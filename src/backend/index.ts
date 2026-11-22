import type { IncomingMessage } from "node:http";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { WebSocket } from "ws";
import {
  resolveTarget,
  TargetRefusedError,
} from "@termix-ssh/plugin-sdk/net-guard";
import { adbKeyFromPem, generateAdbKey, type AdbKey } from "./adb-key.js";
import {
  AdbPairingRequiredError,
  openAdbShell,
  type AdbShell,
} from "./adb-protocol.js";
import { PairingError, pairWithDevice } from "./pairing.js";
import { markPaired } from "./paired.js";
import { registerFilesRoute } from "./files-route.js";

const DEFAULT_PORT = 5555;
const CLOSE_POLICY = 1008;
const CLOSE_NORMAL = 1000;
const CLOSE_ERROR = 1011;

type ServerMessage =
  | { type: "phase"; phase: "connecting" | "authorizing" | "ready" }
  | { type: "exit"; code?: number }
  | { type: "paired" }
  | { type: "error"; message: string; needsPairing?: boolean };

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(ctx: PluginContext): void {
  let keyPromise: Promise<AdbKey> | null = null;

  // One key for the whole server, so a device approves Termix once.
  const loadKey = (): Promise<AdbKey> => {
    keyPromise ??= (async () => {
      const stored = await ctx.settings.get<string>("privateKey");
      if (stored) {
        try {
          return adbKeyFromPem(stored);
        } catch (error) {
          ctx.log.warn(
            `Stored ADB key is unusable, making a new one: ${errorText(error)}`,
          );
        }
      }
      const created = generateAdbKey();
      await ctx.settings.set("privateKey", created.privateKeyPem);
      return created;
    })().catch((error) => {
      keyPromise = null;
      throw error;
    });
    return keyPromise;
  };

  // Core's status dot pings a host on its protocol's own port, not the SSH one.
  ctx.hosts.status.registerPort("adb", async (hostId) => {
    const port = await ctx.settings.getHost<number>(hostId, "adbPort");
    return port || DEFAULT_PORT;
  });

  registerFilesRoute(ctx, loadKey);

  ctx.ws.route("/shell", async (connection) => {
    const ws = connection.socket as WebSocket;
    const request = connection.request as IncomingMessage;

    const say = (message: ServerMessage) => {
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
    const cols = clampInt(url.searchParams.get("cols"), 80, 1, 500);
    const rows = clampInt(url.searchParams.get("rows"), 24, 1, 200);

    // Queue what arrives while the device is still being reached.
    let shell: AdbShell | null = null;
    let closed = false;
    // Counts this session for the host's online indicator until it ends.
    let releaseSession: (() => void) | null = null;
    const endSession = () => {
      releaseSession?.();
      releaseSession = null;
    };
    const early: { data?: Buffer; size?: [number, number] }[] = [];
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const data = Buffer.isBuffer(raw)
          ? raw
          : Buffer.concat(raw as Buffer[]);
        if (shell) shell.write(data);
        else early.push({ data });
        return;
      }
      try {
        const message = JSON.parse(String(raw)) as {
          type?: string;
          cols?: number;
          rows?: number;
        };
        if (message.type === "resize" && message.cols && message.rows) {
          if (shell) shell.resize(message.cols, message.rows);
          else early.push({ size: [message.cols, message.rows] });
        }
      } catch {
        // Not for us.
      }
    });
    ws.on("close", () => {
      closed = true;
      endSession();
      shell?.close();
    });
    ws.on("error", () => {
      closed = true;
      endSession();
      shell?.close();
    });

    let target = "";
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
      const port =
        (await ctx.settings.getHost<number>(hostId, "adbPort")) || DEFAULT_PORT;
      target = `${host.ip}:${port}`;
      // The device is a saved host, so its address is not request input; an
      // admin can still forbid private ranges. Connect to the checked address.
      const allowPrivate =
        (await ctx.settings.get<boolean>("allowPrivateNetworks")) !== false;
      const resolved = await resolveTarget(host.ip, {
        allowPrivateHosts: allowPrivate ? [host.ip] : [],
      });
      const key = await loadKey();
      if (closed) return;

      shell = await openAdbShell(
        {
          host: resolved.address,
          port,
          privateKeyPem: key.privateKeyPem,
          publicKey: key.publicKey,
          cols,
          rows,
        },
        {
          onData: (chunk) => {
            if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
          },
          onPhase: (phase) => say({ type: "phase", phase }),
          onClose: ({ exitCode, error }) => {
            endSession();
            if (error) say({ type: "error", message: error });
            else say({ type: "exit", code: exitCode });
            ws.close(CLOSE_NORMAL);
          },
        },
      );
      if (closed) {
        shell.close();
        return;
      }
      for (const item of early.splice(0)) {
        if (item.data) shell.write(item.data);
        if (item.size) shell.resize(item.size[0], item.size[1]);
      }
      releaseSession = ctx.hosts.trackSession(hostId);
      void markPaired(ctx, hostId);
      await ctx.audit.record({
        action: "adb_shell_open",
        resourceType: "host",
        resourceId: String(hostId),
        resourceName: host.name ?? host.ip,
        details: `ADB shell to ${target}`,
        success: true,
      });
    } catch (error) {
      endSession();
      const message =
        error instanceof TargetRefusedError
          ? "This address is not allowed (private network access is off)"
          : errorText(error);
      ctx.log.warn(
        `ADB connection to ${target || `host ${hostId}`} failed: ${message}`,
      );
      await ctx.audit
        .record({
          action: "adb_shell_open",
          resourceType: "host",
          resourceId: String(hostId),
          details: `ADB shell to ${target || `host ${hostId}`}`,
          success: false,
          errorMessage: message,
        })
        .catch(() => undefined);
      refuse(message, CLOSE_ERROR, error instanceof AdbPairingRequiredError);
    }
  });

  // Android 11+ "Pair device with pairing code". The code is sent in the first
  // message, never in the URL, so it stays out of access logs.
  ctx.ws.route("/pair", async (connection) => {
    const ws = connection.socket as WebSocket;
    const request = connection.request as IncomingMessage;
    const say = (message: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const refuse = (message: string, code = CLOSE_POLICY) => {
      say({ type: "error", message });
      ws.close(code, message.slice(0, 120));
    };
    const url = new URL(request.url ?? "", "http://localhost");
    const hostId = Number.parseInt(url.searchParams.get("hostId") ?? "", 10);
    if (!Number.isInteger(hostId) || hostId <= 0) {
      refuse("Missing host");
      return;
    }

    let started = false;
    ws.on("error", () => undefined);
    ws.on("message", (raw) => {
      if (started) return;
      started = true;
      void (async () => {
        let target = `host ${hostId}`;
        try {
          const message = JSON.parse(String(raw)) as {
            port?: number;
            code?: string;
          };
          const port = Number(message.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            refuse("Enter the pairing port from the phone");
            return;
          }
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
          target = `${host.ip}:${port}`;
          const allowPrivate =
            (await ctx.settings.get<boolean>("allowPrivateNetworks")) !== false;
          const resolved = await resolveTarget(host.ip, {
            allowPrivateHosts: allowPrivate ? [host.ip] : [],
          });
          const key = await loadKey();
          await pairWithDevice({
            host: resolved.address,
            port,
            code: String(message.code ?? ""),
            privateKeyPem: key.privateKeyPem,
            publicKey: key.publicKey,
          });
          await ctx.audit.record({
            action: "adb_pair",
            resourceType: "host",
            resourceId: String(hostId),
            resourceName: host.name ?? host.ip,
            details: `ADB pairing with ${target}`,
            success: true,
          });
          await markPaired(ctx, hostId);
          say({ type: "paired" });
          ws.close(CLOSE_NORMAL);
        } catch (error) {
          const text =
            error instanceof TargetRefusedError
              ? "This address is not allowed (private network access is off)"
              : errorText(error);
          if (!(error instanceof PairingError)) {
            ctx.log.warn(`ADB pairing with ${target} failed: ${text}`);
          }
          await ctx.audit
            .record({
              action: "adb_pair",
              resourceType: "host",
              resourceId: String(hostId),
              details: `ADB pairing with ${target}`,
              success: false,
              errorMessage: text,
            })
            .catch(() => undefined);
          refuse(text, CLOSE_ERROR);
        }
      })();
    });
  });
}
