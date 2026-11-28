import { filesSocketUrl } from "../../app";
import {
  FilesClient,
  type DeviceInfo,
  type FileItem as AdbItem,
} from "../../files-client";
import type { FileItem } from "../host-types";

/**
 * One /files socket per host. The file manager passes a "session id" around
 * (the host id); this table turns it back into the socket.
 */
interface Session {
  client: FilesClient;
  socket: WebSocket;
}

const sessions = new Map<string, Session>();

export interface ConnectionLog {
  type: "info" | "success" | "warning" | "error";
  stage: string;
  message: string;
}

/** A failed connect; `needsPairing` means the device must be paired first. */
export class AdbConnectError extends Error {
  needsPairing = false;
  connectionLogs: ConnectionLog[] = [];
}

export function isConnected(sessionId: string): boolean {
  return sessions.get(sessionId)?.socket.readyState === WebSocket.OPEN;
}

export function clientFor(sessionId: string): FilesClient {
  const session = sessions.get(sessionId);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to the device");
  }
  return session.client;
}

export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  session?.socket.close();
}

/** Opens the socket and resolves once the device accepted the connection. */
export async function openSession(
  sessionId: string,
  hostId: string,
  onLog?: (log: ConnectionLog) => void,
): Promise<void> {
  closeSession(sessionId);
  const fail = (message: string, needsPairing = false) => {
    const error = new AdbConnectError(message);
    error.needsPairing = needsPairing;
    error.connectionLogs = [{ type: "error", stage: "connection", message }];
    return error;
  };
  const target = await filesSocketUrl(hostId);
  if (!target) throw fail("The server did not give a socket address");

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(target.url, target.protocols);
    const client = new FilesClient(socket);
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        socket.close();
        reject(error);
      } else {
        sessions.set(sessionId, { client, socket });
        resolve();
      }
    };
    socket.onmessage = (event) => {
      const message = client.dispatch(event.data);
      if (!message) return;
      if (message.type === "phase" && message.phase) {
        onLog?.({
          type: "info",
          stage: message.phase,
          message: message.phase,
        });
        if (message.phase === "ready") done();
      } else if (message.type === "error") {
        done(
          fail(message.message || "Connection failed", message.needsPairing),
        );
      }
    };
    socket.onerror = () => done(fail("Could not reach the server"));
    socket.onclose = () => {
      client.failAll("The connection closed");
      if (sessions.get(sessionId)?.socket === socket) {
        sessions.delete(sessionId);
      }
      done(fail("The connection closed"));
    };
  });
}

export async function deviceInfo(
  sessionId: string,
): Promise<DeviceInfo | null> {
  try {
    const reply = await clientFor(sessionId).call("info");
    return reply.info ?? null;
  } catch {
    return null;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The list shape the file manager expects, from one entry of ours. */
export function toFileItem(folder: string, entry: AdbItem): FileItem {
  const date = new Date(entry.mtime * 1000);
  return {
    name: entry.name,
    path: `${folder === "/" ? "" : folder}/${entry.name}`,
    type: entry.dir ? "directory" : entry.link ? "link" : "file",
    size: entry.dir ? undefined : entry.size,
    modified: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    modifiedTimestamp: entry.mtime * 1000,
    permissions: (entry.mode & 0o777).toString(8),
    executable: !entry.dir && (entry.mode & 0o111) !== 0,
  };
}
