import {
  SHELL_EXIT,
  SHELL_STDERR,
  SHELL_STDOUT,
  parseShellPackets,
} from "./adb-codec.js";
import type { AdbConnection, AdbStream } from "./adb-connection.js";

/**
 * The ADB "sync:" service (file list, stat, pull, push) and a way to run
 * one-off shell commands, over an already authenticated connection.
 * Reference: AOSP packages/modules/adb/SYNC.TXT.
 */

const id = (name: string) => Buffer.from(name, "ascii");
const SYNC_DATA_MAX = 64 * 1024;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export interface FileEntry {
  name: string;
  mode: number;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  dir: boolean;
  link: boolean;
}

export function entryFromMode(
  name: string,
  mode: number,
  size: number,
  mtime: number,
): FileEntry {
  const kind = mode & S_IFMT;
  return {
    name,
    mode,
    size,
    mtime,
    dir: kind === S_IFDIR,
    link: kind === S_IFLNK,
  };
}

/** Quotes one argument for the device's sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Paths are absolute and never contain NUL. */
export function assertDevicePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.length > 4096) {
    throw new Error("Bad path");
  }
  return path;
}

/** Reads framed replies off a sync stream. */
class SyncChannel {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: string | null = null;

  constructor(readonly stream: AdbStream) {
    stream.holdAcks = true;
    stream.setHandlers({
      onData: (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.wake();
      },
      onClose: (error) => {
        this.failure = error ?? "The device closed the file service";
        this.wake();
      },
    });
  }

  private wake() {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      if (this.failure) throw new Error(this.failure);
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    // Everything delivered so far is consumed: let the device send more.
    if (this.buffer.length < SYNC_DATA_MAX) this.stream.release();
    return out;
  }

  write(data: Buffer): Promise<void> {
    return this.stream.write(data);
  }

  close() {
    this.stream.close();
  }
}

async function openSync(connection: AdbConnection): Promise<SyncChannel> {
  return new SyncChannel(await connection.open("sync:"));
}

function request(command: string, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(8);
  id(command).copy(header, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

async function failure(channel: SyncChannel, length: number): Promise<Error> {
  const message = (await channel.read(length)).toString("utf8");
  return new Error(message || "The device refused the request");
}

/** Lists a directory. Uses the 64 bit variant when the device has it. */
export async function listDirectory(
  connection: AdbConnection,
  path: string,
): Promise<FileEntry[]> {
  assertDevicePath(path);
  const channel = await openSync(connection);
  const v2 = connection.features.includes("ls_v2");
  const entries: FileEntry[] = [];
  try {
    await channel.write(request(v2 ? "LIS2" : "LIST", path));
    for (;;) {
      const tag = (await channel.read(4)).toString("ascii");
      if (tag === "DONE") break;
      if (tag === "FAIL") {
        const length = (await channel.read(4)).readUInt32LE(0);
        throw await failure(channel, length);
      }
      if (tag === "DENT") {
        const head = await channel.read(16);
        const name = (await channel.read(head.readUInt32LE(12))).toString(
          "utf8",
        );
        if (name !== "." && name !== "..") {
          entries.push(
            entryFromMode(
              name,
              head.readUInt32LE(0),
              head.readUInt32LE(4),
              head.readUInt32LE(8),
            ),
          );
        }
      } else if (tag === "DNT2") {
        const head = await channel.read(72);
        const name = (await channel.read(head.readUInt32LE(68))).toString(
          "utf8",
        );
        if (head.readUInt32LE(0) === 0 && name !== "." && name !== "..") {
          entries.push(
            entryFromMode(
              name,
              head.readUInt32LE(20),
              Number(head.readBigUInt64LE(36)),
              Number(head.readBigInt64LE(52)),
            ),
          );
        }
      } else {
        throw new Error("Unexpected reply from the file service");
      }
    }
  } finally {
    channel.close();
  }
  return entries;
}

/** Follows symlinks; null when the path does not exist. */
export async function statPath(
  connection: AdbConnection,
  path: string,
): Promise<FileEntry | null> {
  assertDevicePath(path);
  const channel = await openSync(connection);
  const v2 = connection.features.includes("stat_v2");
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    await channel.write(request(v2 ? "STA2" : "STAT", path));
    const tag = (await channel.read(4)).toString("ascii");
    if (tag === "STAT") {
      const body = await channel.read(12);
      const mode = body.readUInt32LE(0);
      if (mode === 0 && body.readUInt32LE(4) === 0) return null;
      return entryFromMode(
        name,
        mode,
        body.readUInt32LE(4),
        body.readUInt32LE(8),
      );
    }
    if (tag === "STA2") {
      const body = await channel.read(68);
      if (body.readUInt32LE(0) !== 0) return null;
      return entryFromMode(
        name,
        body.readUInt32LE(20),
        Number(body.readBigUInt64LE(36)),
        Number(body.readBigInt64LE(52)),
      );
    }
    throw new Error("Unexpected reply from the file service");
  } finally {
    channel.close();
  }
}

/**
 * Reads a file. `onChunk` may be async: the device is held back until it
 * resolves, so a slow consumer never makes the server buffer the file.
 */
export async function pullFile(
  connection: AdbConnection,
  path: string,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  assertDevicePath(path);
  const channel = await openSync(connection);
  try {
    await channel.write(request("RECV", path));
    for (;;) {
      if (isCancelled()) throw new Error("Cancelled");
      const head = await channel.read(8);
      const tag = head.toString("ascii", 0, 4);
      const length = head.readUInt32LE(4);
      if (tag === "DONE") return;
      if (tag === "FAIL") throw await failure(channel, length);
      if (tag !== "DATA")
        throw new Error("Unexpected reply from the file service");
      await onChunk(await channel.read(length));
    }
  } finally {
    channel.close();
  }
}

export interface PushSession {
  /** Sends the next piece of the file; resolves when the device took it. */
  write: (chunk: Buffer) => Promise<void>;
  /** Finishes the file and waits for the device's verdict. */
  finish: () => Promise<void>;
  abort: () => void;
}

/** Starts writing a file. `mode` is the permission bits, like 0o644. */
export async function pushFile(
  connection: AdbConnection,
  path: string,
  mode: number,
  mtime: number,
): Promise<PushSession> {
  assertDevicePath(path);
  const channel = await openSync(connection);
  const spec = `${path},${S_IFREG | (mode & 0o7777)}`;
  try {
    await channel.write(request("SEND", spec));
  } catch (error) {
    channel.close();
    throw error;
  }
  return {
    async write(chunk) {
      for (let offset = 0; offset < chunk.length; offset += SYNC_DATA_MAX) {
        await channel.write(
          request("DATA", chunk.subarray(offset, offset + SYNC_DATA_MAX)),
        );
      }
    },
    async finish() {
      try {
        const done = Buffer.alloc(8);
        id("DONE").copy(done, 0);
        done.writeUInt32LE(Math.max(0, Math.floor(mtime)) >>> 0, 4);
        await channel.write(done);
        const head = await channel.read(8);
        const tag = head.toString("ascii", 0, 4);
        if (tag === "FAIL") throw await failure(channel, head.readUInt32LE(4));
        if (tag !== "OKAY")
          throw new Error("Unexpected reply from the file service");
      } finally {
        channel.close();
      }
    },
    abort() {
      channel.close();
    },
  };
}

/** Runs one command and returns what it printed and how it ended. */
export async function runCommand(
  connection: AdbConnection,
  command: string,
  timeoutMs = 60_000,
): Promise<{ output: string; code: number }> {
  const v2 = connection.features.includes("shell_v2");
  const marker = "__ADB_RC__";
  const service = v2
    ? `shell,v2,raw:${command}`
    : `shell:${command}; echo ${marker}$?`;
  const stream = await connection.open(service);
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let code = 0;
    const timer = setTimeout(() => {
      stream.close();
      reject(new Error("The command took too long"));
    }, timeoutMs);
    stream.setHandlers({
      onData: (chunk) => {
        if (!v2) {
          parts.push(chunk);
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        const parsed = parseShellPackets(pending);
        pending = parsed.rest;
        for (const packet of parsed.packets) {
          if (packet.id === SHELL_STDOUT || packet.id === SHELL_STDERR) {
            parts.push(Buffer.from(packet.data));
          } else if (packet.id === SHELL_EXIT && packet.data.length) {
            code = packet.data[0];
          }
        }
      },
      onClose: (error) => {
        clearTimeout(timer);
        if (error) {
          reject(new Error(error));
          return;
        }
        let output = Buffer.concat(parts).toString("utf8");
        if (!v2) {
          const match = new RegExp(`${marker}(\\d+)\\s*$`).exec(output);
          if (match) {
            code = Number(match[1]);
            output = output.slice(0, match.index);
          }
        }
        resolve({ output: output.trim(), code });
      },
    });
  });
}

export { S_IFDIR, S_IFLNK, S_IFREG };
