import net from "node:net";
import tls from "node:tls";
import { constants, privateEncrypt } from "node:crypto";
import { selfSignedCertificate } from "./x509.js";

/**
 * A small ADB client: the transport and shell services of the ADB protocol
 * over a plain TCP connection to adbd (`adb tcpip 5555`, or the port the
 * device listens on). No adb binary is involved.
 *
 * Protocol reference: AOSP packages/modules/adb/protocol.txt and
 * shell_protocol.h.
 */

export const A_SYNC = 0x434e5953;
export const A_CNXN = 0x4e584e43;
export const A_AUTH = 0x48545541;
export const A_OPEN = 0x4e45504f;
export const A_OKAY = 0x59414b4f;
export const A_CLSE = 0x45534c43;
export const A_WRTE = 0x45545257;
/** Android 11+ wireless debugging: "switch this connection to TLS". */
export const A_STLS = 0x534c5453;
export const A_STLS_VERSION = 0x01000000;

export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_RSAPUBLICKEY = 3;

/** Protocol version without payload checksums. */
export const ADB_VERSION = 0x01000001;
/** Largest payload we ask the device to send. */
export const ADB_MAX_DATA = 256 * 1024;

const HEADER_SIZE = 24;

/** Packet ids of the shell_v2 protocol. */
export const SHELL_STDIN = 0;
export const SHELL_STDOUT = 1;
export const SHELL_STDERR = 2;
export const SHELL_EXIT = 3;
export const SHELL_CLOSE_STDIN = 4;
export const SHELL_WINDOW_SIZE = 5;

/** DigestInfo prefix of SHA-1. adb signs the 20 byte token as if it were a SHA-1 digest. */
const SHA1_DIGEST_INFO = Buffer.from("3021300906052b0e03021a05000414", "hex");

export interface AdbMessage {
  command: number;
  arg0: number;
  arg1: number;
  data: Buffer;
}

function checksum(data: Buffer): number {
  let sum = 0;
  for (const byte of data) sum = (sum + byte) >>> 0;
  return sum;
}

export function encodeMessage(
  command: number,
  arg0: number,
  arg1: number,
  data: Buffer = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(command >>> 0, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(data.length, 12);
  header.writeUInt32LE(checksum(data), 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return data.length ? Buffer.concat([header, data]) : header;
}

/** Splits whole messages off the front of a buffer. Throws on a corrupt header. */
export function parseMessages(input: Buffer): {
  messages: AdbMessage[];
  rest: Buffer;
} {
  const messages: AdbMessage[] = [];
  let buffer = input;
  while (buffer.length >= HEADER_SIZE) {
    const command = buffer.readUInt32LE(0);
    const magic = buffer.readUInt32LE(20);
    if ((command ^ 0xffffffff) >>> 0 !== magic) {
      throw new Error("Not an ADB peer: bad packet magic");
    }
    const length = buffer.readUInt32LE(12);
    if (length > 16 * 1024 * 1024) {
      throw new Error("ADB packet is too large");
    }
    if (buffer.length < HEADER_SIZE + length) break;
    messages.push({
      command,
      arg0: buffer.readUInt32LE(4),
      arg1: buffer.readUInt32LE(8),
      data: buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
    });
    buffer = buffer.subarray(HEADER_SIZE + length);
  }
  return { messages, rest: buffer };
}

export function shellPacket(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(id, 0);
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

/** Splits whole shell_v2 packets off the front of a buffer. */
export function parseShellPackets(input: Buffer): {
  packets: { id: number; data: Buffer }[];
  rest: Buffer;
} {
  const packets: { id: number; data: Buffer }[] = [];
  let buffer = input;
  while (buffer.length >= 5) {
    const length = buffer.readUInt32LE(1);
    if (buffer.length < 5 + length) break;
    packets.push({ id: buffer[0], data: buffer.subarray(5, 5 + length) });
    buffer = buffer.subarray(5 + length);
  }
  return { packets, rest: buffer };
}

/** The signature adbd expects for an AUTH token. */
export function signToken(privateKeyPem: string, token: Buffer): Buffer {
  return privateEncrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([SHA1_DIGEST_INFO, token]),
  );
}

/** The device's feature list from its CNXN banner, like `shell_v2,cmd`. */
export function parseFeatures(banner: string): string[] {
  const match = /(?:^|;)features=([^;\0]*)/.exec(banner);
  return match ? match[1].split(",").filter(Boolean) : [];
}

/** The phone is on Wireless debugging and does not know this server's key. */
export class AdbPairingRequiredError extends Error {}

export type AdbPhase = "connecting" | "authorizing" | "ready";

export interface AdbShellHandlers {
  /** Terminal output. stderr arrives here too, like on a real terminal. */
  onData: (chunk: Buffer) => void;
  onPhase?: (phase: AdbPhase) => void;
  /** The session is over. exitCode is set when the shell exited by itself. */
  onClose: (info: { exitCode?: number; error?: string }) => void;
}

export interface AdbShellOptions {
  host: string;
  port: number;
  /** PKCS#8 PEM of the RSA key this client authenticates with. */
  privateKeyPem: string;
  /** The same key's public half in the format adbd stores, base64. */
  publicKey: string;
  cols: number;
  rows: number;
  term?: string;
  /** Time to reach the device and get its first answer. */
  connectTimeoutMs?: number;
  /** Time the person has to approve the key on the device screen. */
  authTimeoutMs?: number;
}

export interface AdbShell {
  write: (data: Buffer | string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

const LOCAL_ID = 1;

/**
 * Connects, authenticates and opens an interactive shell. Resolves once the
 * shell is open; the handlers carry everything after that. Rejects with a
 * readable message when the device can't be reached or refuses the key.
 */
export function openAdbShell(
  options: AdbShellOptions,
  handlers: AdbShellHandlers,
): Promise<AdbShell> {
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const authTimeout = options.authTimeoutMs ?? 60_000;
  const term = (options.term ?? "xterm-256color").replace(/[^\w.-]/g, "");

  return new Promise<AdbShell>((resolve, reject) => {
    const rawSocket = net.connect({ host: options.host, port: options.port });
    rawSocket.setNoDelay(true);
    rawSocket.setKeepAlive(true, 30_000);
    // Replaced by a TLS socket when the device asks for the TLS upgrade.
    let socket: net.Socket | tls.TLSSocket = rawSocket;
    let secured = false;

    let received: Buffer = Buffer.alloc(0);
    let shellBuffer: Buffer = Buffer.alloc(0);
    let opened = false;
    let finished = false;
    let signed = false;
    let keySent = false;
    let useV2 = false;
    let maxData = 4096;
    let remoteId = 0;
    let sending = false;
    let exitCode: number | undefined;
    const queue: Buffer[] = [];

    let timer: NodeJS.Timeout | null = setTimeout(
      () => fail(new Error("The device did not answer in time")),
      connectTimeout,
    );
    const setTimer = (ms: number, message: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(message)), ms);
    };
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const send = (
      command: number,
      arg0: number,
      arg1: number,
      data?: Buffer,
    ) => {
      if (!socket.destroyed)
        socket.write(encodeMessage(command, arg0, arg1, data));
    };

    function finish(info: { error?: string; needsPairing?: boolean }) {
      if (finished) return;
      finished = true;
      clearTimer();
      socket.destroy();
      rawSocket.destroy();
      if (opened) handlers.onClose({ exitCode, error: info.error });
      else {
        const message = info.error ?? "The device closed the connection";
        reject(
          info.needsPairing
            ? new AdbPairingRequiredError(message)
            : new Error(message),
        );
      }
    }
    function fail(error: Error) {
      if (secured && !opened) {
        finish({
          error: `The device did not accept this server's key (${error.message}). Pair it first: Wireless debugging → Pair device with pairing code`,
          needsPairing: true,
        });
        return;
      }
      finish({ error: error.message });
    }

    const shell: AdbShell = {
      write(data) {
        if (finished) return;
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        // Leave room for the shell_v2 header inside one payload.
        const room = Math.max(1, maxData - 5);
        for (let offset = 0; offset < bytes.length; offset += room) {
          const part = bytes.subarray(offset, offset + room);
          queue.push(
            useV2 ? shellPacket(SHELL_STDIN, part) : Buffer.from(part),
          );
        }
        pump();
      },
      resize(cols, rows) {
        if (finished || !useV2) return;
        const c = Math.max(1, Math.min(500, Math.floor(cols)));
        const r = Math.max(1, Math.min(200, Math.floor(rows)));
        queue.push(
          shellPacket(SHELL_WINDOW_SIZE, Buffer.from(`${r}x${c},0x0`)),
        );
        pump();
      },
      close() {
        if (finished) return;
        if (opened && remoteId) send(A_CLSE, LOCAL_ID, remoteId);
        finish({});
      },
    };

    function pump() {
      if (sending || !opened || finished || queue.length === 0) return;
      const next = queue.shift() as Buffer;
      sending = true;
      send(A_WRTE, LOCAL_ID, remoteId, next);
    }

    function deliver(data: Buffer) {
      if (!useV2) {
        handlers.onData(data);
        return;
      }
      shellBuffer = Buffer.concat([shellBuffer, data]);
      const { packets, rest } = parseShellPackets(shellBuffer);
      shellBuffer = rest;
      for (const packet of packets) {
        if (packet.id === SHELL_STDOUT || packet.id === SHELL_STDERR) {
          handlers.onData(packet.data);
        } else if (packet.id === SHELL_EXIT && packet.data.length) {
          exitCode = packet.data[0];
        }
      }
    }

    function handle(message: AdbMessage) {
      switch (message.command) {
        case A_AUTH: {
          if (message.arg0 !== AUTH_TOKEN) return;
          if (!signed) {
            signed = true;
            send(
              A_AUTH,
              AUTH_SIGNATURE,
              0,
              signToken(options.privateKeyPem, message.data),
            );
          } else if (!keySent) {
            keySent = true;
            send(
              A_AUTH,
              AUTH_RSAPUBLICKEY,
              0,
              Buffer.from(`${options.publicKey}\0`),
            );
            handlers.onPhase?.("authorizing");
            setTimer(
              authTimeout,
              "The key was not approved on the device in time",
            );
          } else {
            fail(new Error("The device rejected the key"));
          }
          return;
        }
        case A_STLS: {
          if (secured) return;
          upgradeToTls();
          return;
        }
        case A_CNXN: {
          const banner = message.data.toString("utf8");
          const features = parseFeatures(banner);
          useV2 = features.includes("shell_v2");
          maxData = Math.min(
            message.arg1 > 0 ? message.arg1 : 4096,
            ADB_MAX_DATA,
          );
          setTimer(connectTimeout, "The device did not open a shell in time");
          const service = useV2 ? `shell,v2,TERM=${term},pty:` : "shell:";
          send(A_OPEN, LOCAL_ID, 0, Buffer.from(`${service}\0`));
          return;
        }
        case A_OKAY: {
          if (!opened) {
            remoteId = message.arg0;
            opened = true;
            clearTimer();
            handlers.onPhase?.("ready");
            if (useV2) shell.resize(options.cols, options.rows);
            resolve(shell);
            pump();
          } else {
            sending = false;
            pump();
          }
          return;
        }
        case A_WRTE: {
          send(A_OKAY, LOCAL_ID, remoteId);
          deliver(message.data);
          return;
        }
        case A_CLSE: {
          if (!opened) {
            fail(new Error("The device refused to open a shell"));
            return;
          }
          send(A_CLSE, LOCAL_ID, remoteId);
          finish({});
          return;
        }
        default:
          return;
      }
    }

    function upgradeToTls() {
      secured = true;
      send(A_STLS, A_STLS_VERSION, 0);
      const plain = socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      received = Buffer.alloc(0);
      // adbd only looks at the certificate's public key, which must be one
      // it has paired.
      const secure = tls.connect({
        socket: plain,
        cert: selfSignedCertificate(options.privateKeyPem),
        key: options.privateKeyPem,
        minVersion: "TLSv1.3",
        rejectUnauthorized: false,
      });
      socket = secure;
      attach(secure);
      handlers.onPhase?.("authorizing");
    }

    function attach(stream: net.Socket | tls.TLSSocket) {
      stream.on("data", (chunk) => {
        try {
          received = Buffer.concat([received, chunk as Buffer]);
          const { messages, rest } = parseMessages(received);
          received = rest;
          for (const message of messages) handle(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      stream.on("error", (error) => fail(error));
      stream.on("close", () => {
        if (secured && !opened && !finished) {
          fail(new Error("the connection was closed during the TLS handshake"));
        } else {
          finish({});
        }
      });
    }

    rawSocket.on("connect", () => {
      handlers.onPhase?.("connecting");
      send(
        A_CNXN,
        ADB_VERSION,
        ADB_MAX_DATA,
        Buffer.from("host::features=shell_v2,cmd\0"),
      );
    });
    attach(rawSocket);
  });
}
