/**
 * The browser side of the /files socket: JSON requests with numbered replies,
 * and binary frames that start with the 4 byte id of the transfer they carry.
 */

export interface FileItem {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  dir: boolean;
  link: boolean;
}

export interface DeviceInfo {
  brand: string | null;
  model: string | null;
  android: string | null;
  sdk: number | null;
  battery: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
}

export interface FileProperties {
  path: string;
  type: string;
  dir: boolean;
  link: boolean;
  mode: number;
  owner: string;
  group: string;
  size: number;
  mtime: number;
  context: string | null;
}

export interface ServerEvent {
  id?: number;
  ok?: boolean;
  error?: string;
  type?: string;
  phase?: "connecting" | "authorizing" | "ready";
  message?: string;
  needsPairing?: boolean;
  entries?: FileItem[];
  entry?: FileItem | null;
  properties?: FileProperties;
  size?: number | null;
  bytes?: number;
  ticket?: string;
  name?: string;
  content?: string;
  mode?: number;
  info?: DeviceInfo;
  truncated?: boolean;
  results?: Array<{ path: string; error?: string }>;
  trash?: {
    items: Array<{
      id: string;
      name: string;
      originalPath: string;
      isDirectory: boolean;
      deletedAt: string;
      size: number;
    }>;
    retentionDays: number;
    canManageRetention: boolean;
  };
}

type Listener = (event: ServerEvent) => void;

const UPLOAD_CHUNK = 256 * 1024;
/** How much unacknowledged data an upload may have in flight. */
const UPLOAD_WINDOW = 4 * 1024 * 1024;

export class FilesClient {
  private nextId = 1;
  private listeners = new Map<number, Listener>();

  constructor(private readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
  }

  /** Feed every socket message here. Returns events that are not replies. */
  dispatch(data: unknown): ServerEvent | null {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(data)) as ServerEvent;
    } catch {
      return null;
    }
    if (typeof event.id === "number") {
      this.listeners.get(event.id)?.(event);
      return null;
    }
    return event;
  }

  /** Fails everything in flight, e.g. when the socket closes. */
  failAll(message: string): void {
    for (const listener of [...this.listeners.values()]) {
      listener({ ok: false, error: message });
    }
  }

  private send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  /** One request, one reply. */
  call<T extends ServerEvent = ServerEvent>(
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.listeners.set(id, (event) => {
        if (event.ok === undefined) return;
        this.listeners.delete(id);
        if (event.ok) resolve(event as T);
        else reject(new Error(event.error || "Request failed"));
      });
      this.send({ id, op, ...payload });
    });
  }

  /** Asks for a one time download link for files and folders. */
  async downloadTicket(
    paths: string[],
  ): Promise<{ ticket: string; name: string; size: number | null }> {
    const reply = await this.call<
      ServerEvent & { ticket: string; name: string; size: number | null }
    >("downloadTicket", { paths });
    return reply;
  }

  /** Names matching the text in this folder and everything below it. */
  async search(
    path: string,
    query: string,
  ): Promise<{ entries: FileItem[]; truncated: boolean }> {
    const reply = await this.call("search", { path, query });
    return {
      entries: reply.entries ?? [],
      truncated: reply.truncated === true,
    };
  }

  /** Whether something is already at this path. */
  async exists(path: string): Promise<boolean> {
    const reply = await this.call("stat", { path });
    return Boolean(reply.entry);
  }

  /** Owner, group, permissions and SELinux context of one path. */
  async properties(path: string): Promise<FileProperties> {
    const reply = await this.call("properties", { path });
    if (!reply.properties) throw new Error("No properties");
    return reply.properties;
  }

  /** Total size of a folder in bytes. */
  async dirSize(path: string): Promise<number> {
    const reply = await this.call("dirsize", { path });
    return reply.bytes ?? 0;
  }

  /** Reads a small text file. */
  async readText(path: string): Promise<{ content: string; mode: number }> {
    const reply = await this.call("read", { path });
    return { content: reply.content ?? "", mode: reply.mode ?? 0o644 };
  }

  /** Replaces a text file's content, keeping its permissions. */
  async writeText(path: string, content: string): Promise<void> {
    await this.call("write", { path, content });
  }

  /** Sets permissions from octal digits like "644". */
  async chmod(
    paths: string | string[],
    mode: string,
    recursive = false,
  ): Promise<void> {
    await this.call("chmod", {
      paths: Array.isArray(paths) ? paths : [paths],
      mode,
      recursive,
    });
  }

  /** Uploads a file with a window of unacknowledged data. */
  upload(
    path: string,
    file: File,
    onProgress: (done: number) => void,
  ): { id: number; result: Promise<void> } {
    const id = this.nextId++;
    const result = new Promise<void>((resolve, reject) => {
      let inflight = 0;
      let wake: (() => void) | null = null;
      let failed: string | null = null;
      let readyResolve: () => void = () => undefined;
      const ready = new Promise<void>((r) => {
        readyResolve = r;
      });
      let finished: (() => void) | null = null;
      const end = () => {
        this.listeners.delete(id);
      };
      this.listeners.set(id, (event) => {
        if (event.type === "ready") readyResolve();
        else if (event.type === "ack") {
          inflight -= event.bytes ?? 0;
          wake?.();
        } else if (event.ok === true) {
          finished?.();
        } else if (event.ok === false) {
          failed = event.error || "Upload failed";
          wake?.();
          readyResolve();
          finished?.();
        }
      });
      this.send({
        id,
        op: "upload",
        path,
        size: file.size,
        mtime: Math.floor(file.lastModified / 1000),
      });
      void (async () => {
        try {
          await ready;
          let sent = 0;
          while (sent < file.size && !failed) {
            while (inflight >= UPLOAD_WINDOW && !failed) {
              await new Promise<void>((r) => {
                wake = r;
              });
            }
            if (failed) break;
            const chunk = await file
              .slice(sent, sent + UPLOAD_CHUNK)
              .arrayBuffer();
            const frame = new Uint8Array(4 + chunk.byteLength);
            new DataView(frame.buffer).setUint32(0, id);
            frame.set(new Uint8Array(chunk), 4);
            this.socket.send(frame);
            inflight += chunk.byteLength;
            sent += chunk.byteLength;
            onProgress(sent - inflight);
          }
          if (!failed) {
            const done = new Promise<void>((r) => {
              finished = r;
            });
            this.send({ id, op: "uploadEnd" });
            await done;
          }
          end();
          if (failed) reject(new Error(failed));
          else resolve();
        } catch (error) {
          end();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    return { id, result };
  }

  cancel(id: number): void {
    this.send({ id, op: "cancel" });
  }
}
