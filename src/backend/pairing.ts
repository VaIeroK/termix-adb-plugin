import net from "node:net";
import tls from "node:tls";
import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { createSpake2, type Spake2Role } from "./spake2.js";
import { selfSignedCertificate } from "./x509.js";

/**
 * Android 11+ "Pair device with pairing code" (adb pair host:port code).
 * The phone listens on a pairing port; the client opens TLS 1.3, mixes the
 * 6 digit code and the TLS exporter secret into a SPAKE2 exchange, and swaps
 * encrypted PeerInfo blobs, the first of which carries our adb public key.
 * Once the phone has stored it, the key works on the wireless debugging port.
 *
 * Reference: AOSP packages/modules/adb/pairing_connection and pairing_auth.
 */

export const PAIRING_SPAKE2_MSG = 0;
export const PAIRING_PEER_INFO = 1;
const HEADER_SIZE = 6;
const PAIRING_VERSION = 1;
export const PEER_INFO_SIZE = 8192;
const PEER_INFO_RSA_KEY = 0;
const MAX_PAYLOAD = PEER_INFO_SIZE * 2;
const EXPORT_LABEL = "adb-label\0";
const CLIENT_NAME = Buffer.from("adb pair client\0");
const SERVER_NAME = Buffer.from("adb pair server\0");

/** AES-128-GCM with a little endian message counter as the nonce. */
export class PairingCipher {
  private readonly key: Buffer;
  private encryptCounter = 0n;
  private decryptCounter = 0n;

  constructor(spakeKey: Buffer) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        spakeKey,
        Buffer.alloc(0),
        Buffer.from("adb pairing_auth aes-128-gcm key"),
        16,
      ),
    );
  }

  private static nonce(counter: bigint): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(counter);
    return nonce;
  }

  encrypt(plain: Buffer): Buffer {
    const cipher = createCipheriv(
      "aes-128-gcm",
      this.key,
      PairingCipher.nonce(this.encryptCounter++),
    );
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]);
  }

  decrypt(sealed: Buffer): Buffer {
    if (sealed.length < 16) throw new Error("Pairing reply is too short");
    const decipher = createDecipheriv(
      "aes-128-gcm",
      this.key,
      PairingCipher.nonce(this.decryptCounter++),
    );
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
  }
}

export function pairingPacket(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(PAIRING_VERSION, 0);
  header.writeUInt8(type, 1);
  header.writeUInt32BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** Reads pairing packets off a stream, one at a time. */
export class PairingReader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    stream.on("error", (error: Error) => {
      this.failure = error;
      this.wake();
    });
    stream.on("close", () => {
      this.failure ??= new Error("The device closed the connection");
      this.wake();
    });
  }

  private wake() {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  private async need(length: number): Promise<void> {
    while (this.buffer.length < length) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  async packet(): Promise<{ type: number; payload: Buffer }> {
    await this.need(HEADER_SIZE);
    const version = this.buffer[0];
    const type = this.buffer[1];
    const length = this.buffer.readUInt32BE(2);
    if (version !== PAIRING_VERSION) {
      throw new Error("The device speaks another pairing protocol version");
    }
    if (length === 0 || length > MAX_PAYLOAD) {
      throw new Error("Bad pairing packet");
    }
    await this.need(HEADER_SIZE + length);
    const payload = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length);
    this.buffer = this.buffer.subarray(HEADER_SIZE + length);
    return { type, payload };
  }
}

export function peerInfoBlob(publicKey: string): Buffer {
  const blob = Buffer.alloc(PEER_INFO_SIZE);
  blob[0] = PEER_INFO_RSA_KEY;
  const key = Buffer.from(publicKey, "utf8");
  if (key.length > PEER_INFO_SIZE - 1) throw new Error("Key is too large");
  key.copy(blob, 1);
  return blob;
}

export interface PairOptions {
  /** Resolved address of the phone and its pairing port. */
  host: string;
  port: number;
  /** The 6 digit code shown on the phone. */
  code: string;
  privateKeyPem: string;
  publicKey: string;
  timeoutMs?: number;
}

export class PairingError extends Error {}

/** Runs the pairing; resolves once the phone has accepted our key. */
export async function pairWithDevice(options: PairOptions): Promise<void> {
  const code = options.code.trim();
  if (!/^\d{6}$/.test(code)) {
    throw new PairingError("The pairing code is 6 digits");
  }
  const timeoutMs = options.timeoutMs ?? 20_000;

  const raw = net.connect({ host: options.host, port: options.port });
  raw.setNoDelay(true);
  let secure: tls.TLSSocket | null = null;
  const abort = (error: Error) => {
    raw.destroy(error);
    secure?.destroy(error);
  };
  const timer = setTimeout(
    () => abort(new PairingError("The device did not answer in time")),
    timeoutMs,
  );

  try {
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    secure = tls.connect({
      socket: raw,
      cert: selfSignedCertificate(options.privateKeyPem),
      key: options.privateKeyPem,
      minVersion: "TLSv1.3",
      rejectUnauthorized: false,
    });
    const failed = new Promise<never>((_, reject) => {
      secure?.once("error", reject);
      raw.once("error", reject);
    });
    // Never leave a rejection unhandled once the race is decided.
    failed.catch(() => undefined);
    const reader = new PairingReader(secure);
    await Promise.race([
      new Promise<void>((resolve) => secure?.once("secureConnect", resolve)),
      failed,
    ]);

    const exported = secure.exportKeyingMaterial(
      64,
      EXPORT_LABEL,
      Buffer.alloc(0),
    );
    const role: Spake2Role = "alice";
    const spake = createSpake2({
      role,
      myName: CLIENT_NAME,
      theirName: SERVER_NAME,
      password: Buffer.concat([Buffer.from(code, "ascii"), exported]),
    });

    secure.write(pairingPacket(PAIRING_SPAKE2_MSG, spake.message));
    const theirs = await Promise.race([reader.packet(), failed]);
    if (theirs.type !== PAIRING_SPAKE2_MSG || theirs.payload.length !== 32) {
      throw new PairingError("Unexpected reply from the device");
    }
    const cipher = new PairingCipher(spake.finish(theirs.payload));

    secure.write(
      pairingPacket(
        PAIRING_PEER_INFO,
        cipher.encrypt(peerInfoBlob(options.publicKey)),
      ),
    );
    const info = await Promise.race([reader.packet(), failed]);
    if (info.type !== PAIRING_PEER_INFO) {
      throw new PairingError("Unexpected reply from the device");
    }
    try {
      cipher.decrypt(info.payload);
    } catch {
      // The phone derives a different key when the code is wrong and its
      // reply then fails the integrity check.
      throw new PairingError("Wrong pairing code");
    }
  } catch (error) {
    if (error instanceof PairingError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A wrong code usually shows up as the phone dropping the connection.
    throw new PairingError(
      /closed the connection|ECONNRESET|EPIPE/i.test(message)
        ? "The device closed the connection. The code is wrong or expired, or this is not the pairing port"
        : message,
    );
  } finally {
    clearTimeout(timer);
    secure?.destroy();
    raw.destroy();
  }
}

export { CLIENT_NAME, SERVER_NAME, EXPORT_LABEL };
