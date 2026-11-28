import { markPaired } from "./paired.js";
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
  query?: string;
  overwrite?: boolean;
  permanent?: boolean;
}

/** Where deleted items wait; hidden, on the shared storage. */
const TRASH_DIR = "/sdcard/.termix-trash";
const DEFAULT_RETENTION_DAYS = 7;

function trashId(id: unknown): string {
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) {
    throw new Error("Bad trash id");
  }
  return id;
}

interface TrashRow {
  id: string;
  name: string;
  originalPath: string;
  isDirectory: boolean;
  deletedAt: string;
  size: number;
}

/** Parses the output of the trash listing script. */
export function parseTrash(output: string): {
  items: TrashRow[];
  retentionDays: number;
} {
  const items: TrashRow[] = [];
  let retentionDays = DEFAULT_RETENTION_DAYS;
  for (const block of output.split("@@").slice(1)) {
    const lines = block.split("\n").map((l) => l.trim());
    const [head, a, b, c, d] = lines;
    if (head === "RET") {
      const days = Number(a);
      if (Number.isInteger(days) && days >= 1) retentionDays = days;
      continue;
    }
    if (!/^[\w-]+$/.test(head) || !a) continue;
    items.push({
      id: head,
      name: baseNameOf(a),
      originalPath: a,
      isDirectory: c === "1",
      deletedAt: new Date(Number(b) || 0).toISOString(),
      size: (Number(d) || 0) * 1024,
    });
  }
  return { items, retentionDays };
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Largest file the text editor opens or saves. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** Largest file the viewer (images, audio, PDF) loads as base64. */
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

/** Most results a search returns; one more is asked for to know it was cut. */
const SEARCH_LIMIT = 500;

/** `find` pattern that matches the text anywhere in a name, wildcards literal. */
export function searchPattern(query: string): string {
  return `*${query.replace(/[\\*?[\]]/g, "\\$&")}*`;
}

/** Lines of "%F|%a|%s|%Y|%n" from stat, as entries named relative to `base`. */
export function parseSearch(output: string, base: string) {
  const prefix = base === "/" ? "/" : `${base}/`;
  const entries: {
    name: string;
    mode: number;
    size: number;
    mtime: number;
    dir: boolean;
    link: boolean;
  }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const full = parts.slice(4).join("|");
    if (!full.startsWith(prefix) || full.length === prefix.length) continue;
    entries.push({
      name: full.slice(prefix.length),
      mode: Number.parseInt(parts[1], 8) || 0,
      size: Number.parseInt(parts[2], 10) || 0,
      mtime: Number.parseInt(parts[3], 10) || 0,
      dir: parts[0] === "directory",
      link: parts[0] === "symbolic link",
    });
  }
  return entries;
}

/** The one line "%F|%a|%U|%G|%s|%Y|%C|%n" that stat prints, as fields. */
export function parseProperties(output: string, path: string) {
  const line =
    output.split(/\r?\n/).find((l) => l.split("|").length >= 8) ?? "";
  const parts = line.split("|");
  const type = parts[0] ?? "";
  return {
    path,
    type,
    dir: type === "directory",
    link: type === "symbolic link",
    mode: Number.parseInt(parts[1] ?? "", 8) || 0,
    owner: parts[2] || null,
    group: parts[3] || null,
    size: Number.parseInt(parts[4] ?? "", 10) || 0,
    mtime: Number.parseInt(parts[5] ?? "", 10) || 0,
    // "?" is what stat prints when the context is unknown.
    context: parts[6] && parts[6] !== "?" ? parts[6] : null,
  };
}

const REBOOT_COMMANDS: Record<string, string> = {
  system: "reboot",
  recovery: "reboot recovery",
  bootloader: "reboot bootloader",
  poweroff: "reboot -p",
};

/** The "key=value" lines the info command prints, as numbers and text. */
export function parseInfo(output: string) {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const number = (key: string) => {
    const parsed = Number.parseInt(values.get(key) ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  // "Filesystem 1K-blocks Used Available Use% Mounted on"
  const columns = (values.get("df") ?? "").split(/\s+/);
  const totalKb = Number.parseInt(columns[1] ?? "", 10);
  const freeKb = Number.parseInt(columns[3] ?? "", 10);
  return {
    brand: values.get("brand") || null,
    model: values.get("model") || null,
    android: values.get("android") || null,
    sdk: number("sdk"),
    // A TV or a box reports level 0 with no battery fitted: show nothing.
    battery: values.get("present") === "1" ? number("battery") : null,
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
    freeBytes: Number.isFinite(freeKb) ? freeKb * 1024 : null,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
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
    // The host's switches; both are on unless the host turned them off.
    let filesOn = true;
    let powerOn = true;
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

    // Never merge into something that is already there. `overwrite` replaces whatever is at the destination (the caller has
    // asked the user); without it an existing destination is refused.
    const assertFree = async (from: string, to: string, overwrite = false) => {
      if (to === from || to.startsWith(`${from}/`)) {
        throw new Error("Can't put a folder into itself");
      }
      if (await statPath(adb as AdbConnection, to)) {
        if (!overwrite) throw new Error(`${baseName(to)} already exists there`);
        await run(`rm -rf ${shellQuote(to)}`);
      }
    };

    const handle = async (message: Request) => {
      const id = message.id as number;
      try {
        if (message.op === "reboot" ? !powerOn : !filesOn) {
          throw new Error(
            message.op === "reboot"
              ? "Power control is off for this host"
              : "The file manager is off for this host",
          );
        }
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
          case "newfile": {
            const path = assertDevicePath(message.path ?? "");
            if (await statPath(adb as AdbConnection, path)) {
              throw new Error(`${baseName(path)} already exists there`);
            }
            const session = await pushFile(
              adb as AdbConnection,
              path,
              0o664,
              Date.now() / 1000,
            );
            await session.finish();
            await audit("adb_files_newfile", path);
            say({ id, ok: true });
            return;
          }
          case "properties": {
            const path = assertDevicePath(message.path ?? "");
            const format = "%F|%a|%U|%G|%s|%Y";
            // %C (the SELinux context) is missing on some builds, so retry without.
            let result = await runCommand(
              adb as AdbConnection,
              `stat -c '${format}|%C|%n' ${shellQuote(path)}`,
              15_000,
            );
            if (result.code !== 0) {
              result = await runCommand(
                adb as AdbConnection,
                `stat -c '${format}||%n' ${shellQuote(path)}`,
                15_000,
              );
            }
            if (result.code !== 0) {
              throw new Error(result.output.trim() || "No such file");
            }
            say({
              id,
              ok: true,
              properties: parseProperties(result.output, path),
            });
            return;
          }
          case "dirsize": {
            const path = assertDevicePath(message.path ?? "");
            const { output } = await runCommand(
              adb as AdbConnection,
              `du -sk ${shellQuote(path)} 2>/dev/null | tail -n 1`,
              300_000,
            );
            const kb = Number.parseInt(output.trim().split(/\s+/)[0] ?? "", 10);
            if (!Number.isFinite(kb))
              throw new Error("Could not measure the folder");
            say({ id, ok: true, bytes: kb * 1024 });
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
            await assertFree(from, to, message.overwrite === true);
            await run(`mv ${shellQuote(from)} ${shellQuote(to)}`);
            await audit("adb_files_rename", `${from} -> ${to}`);
            say({ id, ok: true });
            return;
          }
          case "copy": {
            const from = assertDevicePath(message.from ?? "");
            const to = assertDevicePath(message.to ?? "");
            await assertFree(from, to, message.overwrite === true);
            await run(`cp -r ${shellQuote(from)} ${shellQuote(to)}`);
            await audit("adb_files_copy", `${from} -> ${to}`);
            say({ id, ok: true });
            return;
          }
          case "compress": {
            // Items from one folder into a .tar.gz (Android has tar, not zip).
            const sources = (message.paths ?? []).map(assertDevicePath);
            const archive = assertDevicePath(message.to ?? "");
            if (sources.length === 0) throw new Error("Nothing to compress");
            const parent = parentOf(sources[0]);
            if (sources.some((p) => parentOf(p) !== parent)) {
              throw new Error("Items must be in the same folder");
            }
            if (!/\.(tar\.gz|tgz)$/i.test(archive)) {
              throw new Error("The archive name must end with .tar.gz");
            }
            if (await statPath(adb as AdbConnection, archive)) {
              throw new Error(`${baseName(archive)} already exists there`);
            }
            await run(
              `tar -czf ${shellQuote(archive)} -C ${shellQuote(parent)} ${sources
                .map((p) => shellQuote(baseName(p)))
                .join(" ")}`,
            );
            await audit(
              "adb_files_compress",
              `${sources.join(", ")} -> ${archive}`,
            );
            say({ id, ok: true });
            return;
          }
          case "extract": {
            // .tar, .tar.gz, .tgz, .tar.bz2 and .zip into a folder.
            const archive = assertDevicePath(message.path ?? "");
            const into = assertDevicePath(message.to ?? parentOf(archive));
            const folder = await statPath(adb as AdbConnection, into);
            if (!folder?.dir) throw new Error("Destination is not a folder");
            if (/\.zip$/i.test(archive)) {
              await run(
                `unzip -o ${shellQuote(archive)} -d ${shellQuote(into)}`,
              );
            } else if (/\.(tar|tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(archive)) {
              await run(
                `tar -xf ${shellQuote(archive)} -C ${shellQuote(into)}`,
              );
            } else {
              throw new Error("Unsupported archive type");
            }
            await audit("adb_files_extract", `${archive} -> ${into}`);
            say({ id, ok: true });
            return;
          }
          case "trash": {
            const paths = (message.paths ?? []).map(assertDevicePath);
            const results: Array<{ path: string; error?: string }> = [];
            for (const path of paths) {
              try {
                if (path === "/" || path.split("/").length < 3) {
                  throw new Error("Refusing to delete a top level folder");
                }
                if (path === TRASH_DIR || path.startsWith(`${TRASH_DIR}/`)) {
                  throw new Error("This is the trash itself");
                }
                const entry = await statPath(adb as AdbConnection, path);
                if (!entry) throw new Error("No such file or folder");
                if (message.permanent === true) {
                  await run(`rm -rf ${shellQuote(path)}`);
                } else {
                  const tid = `${Date.now()}-${randomBytes(3).toString("hex")}`;
                  const dir = `${TRASH_DIR}/${tid}`;
                  await run(
                    `mkdir -p ${shellQuote(`${dir}/data`)} && ` +
                      `printf '%s\\n%s\\n%s\\n' ${shellQuote(path)} ${Date.now()} ${
                        entry.dir ? 1 : 0
                      } > ${shellQuote(`${dir}/meta`)} && ` +
                      `mv ${shellQuote(path)} ${shellQuote(`${dir}/data/${baseName(path)}`)}`,
                  );
                }
                results.push({ path });
              } catch (error) {
                results.push({ path, error: errorText(error) });
              }
            }
            await audit(
              message.permanent === true
                ? "adb_files_delete"
                : "adb_files_trash",
              paths.join(", "),
            );
            say({ id, ok: true, results });
            return;
          }
          case "trashList": {
            const { output } = await runCommand(
              adb as AdbConnection,
              `T=${TRASH_DIR}; for d in "$T"/*/; do [ -f "$d/meta" ] || continue; ` +
                'echo "@@$(basename "$d")"; cat "$d/meta"; ' +
                'du -sk "$d/data" 2>/dev/null | cut -f1; done; ' +
                'echo "@@RET"; cat "$T/.retention" 2>/dev/null',
              60_000,
            );
            const { items, retentionDays } = parseTrash(output);
            // Items older than the retention go while the list is read.
            const limit = Date.now() - retentionDays * 86_400_000;
            const keep: TrashRow[] = [];
            const old: string[] = [];
            for (const item of items) {
              if (new Date(item.deletedAt).getTime() < limit) old.push(item.id);
              else keep.push(item);
            }
            if (old.length > 0) {
              await run(
                `rm -rf ${old.map((o) => shellQuote(`${TRASH_DIR}/${o}`)).join(" ")}`,
              );
            }
            say({
              id,
              ok: true,
              trash: { items: keep, retentionDays, canManageRetention: true },
            });
            return;
          }
          case "trashRestore": {
            const tid = trashId(message.path);
            const { output } = await runCommand(
              adb as AdbConnection,
              `head -n 1 ${shellQuote(`${TRASH_DIR}/${tid}/meta`)}`,
              15_000,
            );
            const original = assertDevicePath(output.trim());
            if (await statPath(adb as AdbConnection, original)) {
              throw new Error(`${baseName(original)} already exists there`);
            }
            await run(
              `mkdir -p ${shellQuote(parentOf(original))} && ` +
                `mv ${shellQuote(`${TRASH_DIR}/${tid}/data/${baseName(original)}`)} ${shellQuote(original)} && ` +
                `rm -rf ${shellQuote(`${TRASH_DIR}/${tid}`)}`,
            );
            await audit("adb_files_restore", original);
            say({ id, ok: true });
            return;
          }
          case "trashDelete": {
            const tid = trashId(message.path);
            await run(`rm -rf ${shellQuote(`${TRASH_DIR}/${tid}`)}`);
            await audit("adb_files_trash_delete", tid);
            say({ id, ok: true });
            return;
          }
          case "trashEmpty": {
            await run(
              `for d in ${shellQuote(TRASH_DIR)}/*/; do rm -rf "$d"; done; true`,
            );
            await audit("adb_files_trash_empty", TRASH_DIR);
            say({ id, ok: true });
            return;
          }
          case "trashRetention": {
            const days = Number(message.size);
            if (!Number.isInteger(days) || days < 1 || days > 3650) {
              throw new Error("Days must be between 1 and 3650");
            }
            await run(
              `mkdir -p ${shellQuote(TRASH_DIR)} && echo ${days} > ${shellQuote(`${TRASH_DIR}/.retention`)}`,
            );
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
          case "search": {
            const base = assertDevicePath(message.path ?? "/");
            const query = String(message.query ?? "").trim();
            if (!query || query.length > 100) {
              throw new Error("Enter a name to look for");
            }
            const { output } = await runCommand(
              adb as AdbConnection,
              `find ${shellQuote(base)} -iname ${shellQuote(searchPattern(query))} ` +
                `-exec stat -c '%F|%a|%s|%Y|%n' {} + 2>/dev/null | head -n ${SEARCH_LIMIT + 1}`,
              120_000,
            );
            const found = parseSearch(output, base);
            say({
              id,
              ok: true,
              path: base,
              entries: found.slice(0, SEARCH_LIMIT),
              truncated: found.length > SEARCH_LIMIT,
            });
            return;
          }
          case "info": {
            const { output } = await runCommand(
              adb as AdbConnection,
              'echo "brand=$(getprop ro.product.manufacturer)"; ' +
                'echo "model=$(getprop ro.product.model)"; ' +
                'echo "android=$(getprop ro.build.version.release)"; ' +
                'echo "sdk=$(getprop ro.build.version.sdk)"; ' +
                'echo "present=$(dumpsys battery | grep -m1 present: | grep -c true)"; ' +
                'echo "battery=$(dumpsys battery | grep -m1 level | tr -dc 0-9)"; ' +
                'echo "df=$(df -k /sdcard | tail -1)"',
              15_000,
            );
            say({ id, ok: true, info: parseInfo(output) });
            return;
          }
          case "install": {
            const path = assertDevicePath(message.path ?? "");
            if (!/\.apk$/i.test(path)) throw new Error("This is not an APK");
            // The package manager runs as system_server, which SELinux keeps
            // out of /sdcard ("Unable to open file"). Like `adb install`, give
            // it a copy in /data/local/tmp, which the shell user can write.
            const staged = `/data/local/tmp/termix-${Date.now()}-${path
              .slice(path.lastIndexOf("/") + 1)
              .replace(/[^\w.-]/g, "_")}`;
            let output: string;
            try {
              const copy = await runCommand(
                adb as AdbConnection,
                `cp ${shellQuote(path)} ${shellQuote(staged)}`,
                120_000,
              );
              if (copy.code !== 0) {
                throw new Error(copy.output.trim() || "Could not read the APK");
              }
              ({ output } = await runCommand(
                adb as AdbConnection,
                `pm install -r ${shellQuote(staged)}`,
                300_000,
              ));
            } finally {
              await runCommand(
                adb as AdbConnection,
                `rm -f ${shellQuote(staged)}`,
                15_000,
              ).catch(() => undefined);
            }
            const text = output.trim();
            if (!/\bSuccess\b/.test(text)) {
              await audit("adb_files_install", path, text || "failed");
              throw new Error(text || "The install failed");
            }
            await audit("adb_files_install", path);
            say({ id, ok: true });
            return;
          }
          case "reboot": {
            const mode = String(message.mode ?? "");
            const command = REBOOT_COMMANDS[mode];
            if (!command) throw new Error("Unknown reboot mode");
            await audit("adb_reboot", mode);
            // The device drops the connection while it goes down; that is the
            // success case, so don't wait for a proper end.
            await Promise.race([
              runCommand(adb as AdbConnection, command, 5000).catch(
                () => undefined,
              ),
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
            say({ id, ok: true });
            return;
          }
          case "readbin": {
            // Any file as base64, for the previews.
            const path = assertDevicePath(message.path ?? "");
            const entry = await statPath(adb as AdbConnection, path);
            if (!entry) throw new Error("No such file");
            if (entry.dir) throw new Error("This is a folder");
            if (entry.size > MAX_VIEW_BYTES) {
              throw new Error("The file is too large to preview (over 64 MB)");
            }
            const parts: Buffer[] = [];
            await pullFile(adb as AdbConnection, path, (chunk) => {
              parts.push(chunk);
            });
            const data = Buffer.concat(parts);
            await audit("adb_files_view", path);
            say({
              id,
              ok: true,
              content: data.toString("base64"),
              size: data.length,
              mtime: entry.mtime,
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
      filesOn =
        (await ctx.settings.getHost<boolean>(hostId, "adbFiles")) !== false;
      powerOn =
        (await ctx.settings.getHost<boolean>(hostId, "adbPower")) !== false;
      if (!filesOn && !powerOn) {
        refuse("The file manager and power control are off for this host");
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
      void markPaired(ctx, hostId);
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
