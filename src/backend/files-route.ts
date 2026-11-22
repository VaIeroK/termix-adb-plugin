import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { WebSocket } from "ws";
import {
  resolveTarget,
  TargetRefusedError,
} from "@termix-ssh/plugin-sdk/net-guard";
import type { AdbKey } from "./adb-key.js";
import {
  AdbPairingRequiredError,
  connectAdb,
  type AdbConnection,
} from "./adb-protocol.js";
import {
  assertDevicePath,
  listDirectory,
  pullFile,
  pushFile,
  runCommand,
  shellQuote,
  statPath,
  type FileEntry,
  type PushSession,
} from "./adb-sync.js";
import { ZipWriter } from "./zip-stream.js";

const DEFAULT_PORT = 5555;
const CLOSE_POLICY = 1008;
const CLOSE_NORMAL = 1000;
const CLOSE_ERROR = 1011;
/** Symlinks are resolved one by one; a directory full of them stops here. */
const MAX_LINK_LOOKUPS = 200;

interface Request {
  id?: number;
  op?: string;
  path?: string;
  from?: string;
  to?: string;
  paths?: string[];
  size?: number;
  mtime?: number;
  content?: string;
  mode?: number | string;
  recursive?: boolean;
}

/** Largest file the text editor opens or saves. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const TICKET_TTL_MS = 60_000;
/** Tree walks stop here, so a symlink loop or a huge tree can't run forever. */
const MAX_DEPTH = 32;
const MAX_ENTRIES = 20_000;

interface Ticket {
  adb: AdbConnection;
  paths: string[];
  expires: number;
  hostName: string;
  audit: (action: string, details: string, error?: string) => Promise<unknown>;
}

interface Out {
  setHeader: (name: string, value: string | number) => void;
  status: (code: number) => Out;
  json: (body: unknown) => unknown;
  write: (chunk: Buffer) => boolean;
  end: () => void;
  destroy: (error?: Error) => void;
  once: (event: string, listener: () => void) => void;
  on: (event: string, listener: () => void) => void;
  writableEnded: boolean;
}

interface Router {
  get: (
    path: string,
    handler: (
      req: { params: Record<string, string> },
      res: Out,
    ) => void | Promise<void>,
  ) => void;
}

/** RFC 6266: an ASCII fallback plus the real name as UTF-8. */
export function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Writes with back pressure; rejects once the browser went away. */
function writer(res: Out): (chunk: Buffer) => Promise<void> {
  let gone = false;
  res.on("close", () => {
    if (!res.writableEnded) gone = true;
  });
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      if (gone) {
        reject(new Error("The download was cancelled"));
        return;
      }
      if (res.write(chunk)) resolve();
      else {
        const stop = () => reject(new Error("The download was cancelled"));
        res.once("close", stop);
        res.once("drain", () => resolve());
      }
    });
}

async function addTree(
  zip: ZipWriter,
  adb: AdbConnection,
  devicePath: string,
  archivePath: string,
  mtime: number,
  budget: { left: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  await zip.addDirectory(archivePath, mtime);
  const entries = await listDirectory(adb, devicePath);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (--budget.left < 0) throw new Error("Too many files for one archive");
    // Links are skipped: they can loop, or leave the folder being copied.
    if (entry.link) continue;
    const from = `${devicePath.replace(/\/$/, "")}/${entry.name}`;
    const to = `${archivePath}/${entry.name}`;
    if (entry.dir) {
      await addTree(zip, adb, from, to, entry.mtime, budget, depth + 1);
    } else {
      await zip.addFile(to, entry.mtime, (push) => pullFile(adb, from, push));
    }
  }
}

async function serveTicket(ticket: Ticket, res: Out): Promise<void> {
  const write = writer(res);
  const { adb, paths } = ticket;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "application/octet-stream");

  const first = await statPath(adb, paths[0]);
  if (!first) throw new Error("No such file");
  if (paths.length === 1 && !first.dir) {
    res.setHeader("Content-Length", first.size);
    res.setHeader(
      "Content-Disposition",
      contentDisposition(baseName(paths[0])),
    );
    await pullFile(adb, paths[0], write);
    res.end();
    return;
  }
  const archive =
    paths.length === 1 ? `${baseName(paths[0])}.zip` : "adb-files.zip";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", contentDisposition(archive));
  const zip = new ZipWriter(write);
  const budget = { left: MAX_ENTRIES };
  for (const path of paths) {
    const entry = await statPath(adb, path);
    if (!entry) continue;
    const name = baseName(path);
    if (entry.dir) {
      await addTree(zip, adb, path, name, entry.mtime, budget);
    } else {
      await zip.addFile(name, entry.mtime, (push) => pullFile(adb, path, push));
    }
  }
  await zip.finish();
  res.end();
}

/** The file manager socket: one ADB connection, many requests. */
export function registerFilesRoute(
  ctx: PluginContext,
  loadKey: () => Promise<AdbKey>,
): void {
  // One time links for downloads. The browser can't read a download off the
  // socket (the frame may not touch blob links), so it follows a link that
  // streams from this socket's ADB connection. The ticket is the credential:
  // random, single use, valid a minute, issued only to a checked session.
  const tickets = new Map<string, Ticket>();
  const router = ctx.http.router<Router>({
    public: ["/download/:ticket"],
  });
  router.get("/download/:ticket", async (req, res) => {
    const ticket = tickets.get(req.params.ticket);
    tickets.delete(req.params.ticket);
    if (!ticket || ticket.expires < Date.now() || ticket.adb.closed) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(404).json({ error: "This download link has expired" });
      return;
    }
    const label = ticket.paths.join(", ");
    try {
      await serveTicket(ticket, res);
      await ticket.audit("adb_files_download", label);
    } catch (error) {
      const message = errorText(error);
      await ticket.audit("adb_files_download", label, message);
      if (res.writableEnded) return;
      // Headers may be out already; ending the connection marks it failed.
      res.destroy(new Error(message));
    }
  });

  ctx.ws.route("/files", async (connection) => {
    const ws = connection.socket as WebSocket;
    const request = connection.request as IncomingMessage;

    const say = (message: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const refuse = (
      message: string,
      code = CLOSE_POLICY,
      needsPairing = false,
    ) => {
      say({ type: "error", message, needsPairing });
      ws.close(code, message.slice(0, 120));
    };

    const url = new URL(request.url ?? "", "http://localhost");
    const hostId = Number.parseInt(url.searchParams.get("hostId") ?? "", 10);
    if (!Number.isInteger(hostId) || hostId <= 0) {
      refuse("Missing host");
      return;
    }

    let adb: AdbConnection | null = null;
    let closed = false;
    let releaseSession: (() => void) | null = null;
    let hostName = `host ${hostId}`;
    let target = "";
    const cancelled = new Set<number>();
    const uploads = new Map<
      number,
      { session: PushSession; chain: Promise<void>; path: string }
    >();

    const shutdown = () => {
      closed = true;
      releaseSession?.();
      releaseSession = null;
      for (const upload of uploads.values()) upload.session.abort();
      uploads.clear();
      adb?.close();
    };
    ws.on("close", shutdown);
    ws.on("error", shutdown);

    const audit = (action: string, details: string, error?: string) =>
      ctx.audit
        .record({
          action,
          resourceType: "host",
          resourceId: String(hostId),
          resourceName: hostName,
          details,
          success: !error,
          ...(error ? { errorMessage: error } : {}),
        })
        .catch(() => undefined);

    const sendFrame = (id: number, data: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) {
          reject(new Error("The browser went away"));
          return;
        }
        const frame = Buffer.alloc(4 + data.length);
        frame.writeUInt32BE(id >>> 0, 0);
        data.copy(frame, 4);
        ws.send(frame, { binary: true }, (error) =>
          error ? reject(error) : resolve(),
        );
      });

    const list = async (path: string) => {
      const entries = await listDirectory(adb as AdbConnection, path);
      let lookups = 0;
      const resolved: FileEntry[] = [];
      for (const entry of entries) {
        if (entry.link && lookups < MAX_LINK_LOOKUPS) {
          lookups += 1;
          const target = await statPath(
            adb as AdbConnection,
            `${path.replace(/\/$/, "")}/${entry.name}`,
          ).catch(() => null);
          if (target) {
            resolved.push({
              ...entry,
              dir: target.dir,
              size: target.size,
              mtime: target.mtime,
            });
            continue;
          }
        }
        resolved.push(entry);
      }
      return resolved;
    };

    const run = async (command: string) => {
      const { output, code } = await runCommand(adb as AdbConnection, command);
      if (code !== 0) throw new Error(output || `Command failed (${code})`);
    };

    const handle = async (message: Request) => {
      const id = message.id as number;
      try {
        switch (message.op) {
          case "list": {
            const path = assertDevicePath(message.path ?? "/");
            say({ id, ok: true, path, entries: await list(path) });
            return;
          }
          case "stat": {
            const entry = await statPath(
              adb as AdbConnection,
              assertDevicePath(message.path ?? "/"),
            );
            say({ id, ok: true, entry });
            return;
          }
          case "mkdir": {
            const path = assertDevicePath(message.path ?? "");
            await run(`mkdir -p ${shellQuote(path)}`);
            await audit("adb_files_mkdir", path);
            say({ id, ok: true });
            return;
          }
          case "rename": {
            const from = assertDevicePath(message.from ?? "");
            const to = assertDevicePath(message.to ?? "");
            await run(`mv ${shellQuote(from)} ${shellQuote(to)}`);
            await audit("adb_files_rename", `${from} -> ${to}`);
            say({ id, ok: true });
            return;
          }
          case "copy": {
            const from = assertDevicePath(message.from ?? "");
            const to = assertDevicePath(message.to ?? "");
            await run(`cp -r ${shellQuote(from)} ${shellQuote(to)}`);
            await audit("adb_files_copy", `${from} -> ${to}`);
            say({ id, ok: true });
            return;
          }
          case "delete": {
            const paths = (message.paths ?? []).map(assertDevicePath);
            if (paths.some((p) => p === "/" || p.split("/").length < 3)) {
              throw new Error("Refusing to delete a top level folder");
            }
            await run(`rm -rf ${paths.map(shellQuote).join(" ")}`);
            await audit("adb_files_delete", paths.join(", "));
            say({ id, ok: true });
            return;
          }
          case "downloadTicket": {
            const paths = (message.paths ?? []).map(assertDevicePath);
            if (paths.length === 0 || paths.length > 500) {
              throw new Error("Nothing to download");
            }
            const first = await statPath(adb as AdbConnection, paths[0]);
            if (!first) throw new Error("No such file");
            // Old tickets of this socket go first, so a script can't pile them up.
            const now = Date.now();
            for (const [key, value] of tickets) {
              if (value.expires < now) tickets.delete(key);
            }
            const token = randomBytes(24).toString("base64url");
            tickets.set(token, {
              adb: adb as AdbConnection,
              paths,
              expires: now + TICKET_TTL_MS,
              hostName,
              audit,
            });
            const single = paths.length === 1;
            say({
              id,
              ok: true,
              ticket: token,
              name:
                single && !first.dir
                  ? baseName(paths[0])
                  : `${single ? baseName(paths[0]) : "adb-files"}.zip`,
              size: single && !first.dir ? first.size : null,
            });
            return;
          }
          case "read": {
            const path = assertDevicePath(message.path ?? "");
            const entry = await statPath(adb as AdbConnection, path);
            if (!entry) throw new Error("No such file");
            if (entry.dir) throw new Error("This is a folder");
            if (entry.size > MAX_EDIT_BYTES) {
              throw new Error("The file is too large to edit (over 2 MB)");
            }
            const parts: Buffer[] = [];
            await pullFile(adb as AdbConnection, path, (chunk) => {
              parts.push(chunk);
            });
            const data = Buffer.concat(parts);
            let content: string;
            try {
              if (data.includes(0)) throw new Error("binary");
              content = new TextDecoder("utf-8", { fatal: true }).decode(data);
            } catch {
              throw new Error("This is not a text file");
            }
            await audit("adb_files_open", path);
            say({
              id,
              ok: true,
              content,
              mode: entry.mode & 0o7777,
              size: data.length,
              mtime: entry.mtime,
            });
            return;
          }
          case "write": {
            const path = assertDevicePath(message.path ?? "");
            const data = Buffer.from(String(message.content ?? ""), "utf8");
            if (data.length > MAX_EDIT_BYTES) {
              throw new Error("The file is too large to save (over 2 MB)");
            }
            const entry = await statPath(adb as AdbConnection, path);
            if (entry?.dir) throw new Error("This is a folder");
            const session = await pushFile(
              adb as AdbConnection,
              path,
              entry ? entry.mode & 0o7777 : 0o664,
              Date.now() / 1000,
            );
            try {
              await session.write(data);
            } catch (error) {
              session.abort();
              throw error;
            }
            await session.finish();
            await audit("adb_files_save", path);
            say({ id, ok: true, size: data.length });
            return;
          }
          case "chmod": {
            const paths = (message.paths ?? [message.path ?? ""]).map(
              assertDevicePath,
            );
            const mode = String(message.mode ?? "");
            if (!/^[0-7]{3,4}$/.test(mode)) {
              throw new Error("Permissions are 3 or 4 octal digits, like 644");
            }
            if (paths.length === 0 || paths.length > 500) {
              throw new Error("Nothing to change");
            }
            await run(
              `chmod ${message.recursive ? "-R " : ""}${mode} ${paths.map(shellQuote).join(" ")}`,
            );
            await audit("adb_files_chmod", `${paths.join(", ")} ${mode}`);
            say({ id, ok: true });
            return;
          }
          case "upload": {
            const path = assertDevicePath(message.path ?? "");
            const session = await pushFile(
              adb as AdbConnection,
              path,
              0o664,
              message.mtime ?? Date.now() / 1000,
            );
            uploads.set(id, { session, chain: Promise.resolve(), path });
            say({ id, type: "ready" });
            return;
          }
          case "uploadEnd": {
            const upload = uploads.get(id);
            if (!upload) throw new Error("No such upload");
            await upload.chain;
            uploads.delete(id);
            await upload.session.finish();
            await audit("adb_files_upload", upload.path);
            say({ id, ok: true });
            return;
          }
          case "cancel": {
            cancelled.add(id);
            const upload = uploads.get(id);
            if (upload) {
              uploads.delete(id);
              upload.session.abort();
              await run(`rm -f ${shellQuote(upload.path)}`).catch(
                () => undefined,
              );
              say({ id, ok: false, error: "Cancelled" });
            }
            return;
          }
          default:
            throw new Error("Unknown request");
        }
      } catch (error) {
        const upload = uploads.get(id);
        if (upload) {
          uploads.delete(id);
          upload.session.abort();
        }
        say({
          id,
          ok: false,
          error: cancelled.has(id) ? "Cancelled" : errorText(error),
        });
      }
    };

    // Messages that arrive while the device is still being reached wait here.
    let ready: Promise<void> | null = null;
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const data = Buffer.isBuffer(raw)
          ? raw
          : Buffer.concat(raw as Buffer[]);
        if (data.length < 4) return;
        const id = data.readUInt32BE(0);
        const upload = uploads.get(id);
        if (!upload) return;
        const chunk = data.subarray(4);
        upload.chain = upload.chain
          .then(() => upload.session.write(chunk))
          .then(() => say({ id, type: "ack", bytes: chunk.length }))
          .catch((error) => {
            uploads.delete(id);
            upload.session.abort();
            say({ id, ok: false, error: errorText(error) });
          });
        return;
      }
      let message: Request;
      try {
        message = JSON.parse(String(raw)) as Request;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      void (ready ?? Promise.resolve()).then(() => {
        if (adb && !closed) return handle(message);
        return undefined;
      });
    });

    let resolveReady: () => void = () => undefined;
    ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    try {
      const access = await ctx.hosts.checkAccess(hostId, "connect");
      if (!access.hasAccess || !(await ctx.rbac.has("sessions"))) {
        refuse("You can't connect to this host");
        return;
      }
      const host = await ctx.hosts.get(hostId);
      if (!host) {
        refuse("Host not found");
        return;
      }
      if (!(await ctx.settings.getHost<boolean>(hostId, "enableAdb"))) {
        refuse("ADB is off for this host");
        return;
      }
      hostName = host.name ?? host.ip;
      const port =
        (await ctx.settings.getHost<number>(hostId, "adbPort")) || DEFAULT_PORT;
      target = `${host.ip}:${port}`;
      const allowPrivate =
        (await ctx.settings.get<boolean>("allowPrivateNetworks")) !== false;
      const resolved = await resolveTarget(host.ip, {
        allowPrivateHosts: allowPrivate ? [host.ip] : [],
      });
      const key = await loadKey();
      if (closed) return;

      adb = await connectAdb({
        host: resolved.address,
        port,
        privateKeyPem: key.privateKeyPem,
        publicKey: key.publicKey,
        onPhase: (phase) => say({ type: "phase", phase }),
      });
      if (closed) {
        adb.close();
        return;
      }
      adb.onClose((error) => {
        if (closed) return;
        say({ type: "error", message: error ?? "The device went away" });
        ws.close(CLOSE_NORMAL);
      });
      releaseSession = ctx.hosts.trackSession(hostId);
      await audit("adb_files_open", `ADB files on ${target}`);
      say({ type: "phase", phase: "ready" });
      resolveReady();
    } catch (error) {
      const message =
        error instanceof TargetRefusedError
          ? "This address is not allowed (private network access is off)"
          : errorText(error);
      ctx.log.warn(
        `ADB files connection to ${target || `host ${hostId}`} failed: ${message}`,
      );
      await audit("adb_files_open", `ADB files on ${target}`, message);
      refuse(message, CLOSE_ERROR, error instanceof AdbPairingRequiredError);
    }
  });
}
