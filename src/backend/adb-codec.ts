import { constants, privateEncrypt } from "node:crypto";

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
