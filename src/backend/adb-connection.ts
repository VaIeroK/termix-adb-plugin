import net from "node:net";
import tls from "node:tls";
import {
  A_AUTH,
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_STLS,
  A_STLS_VERSION,
  A_WRTE,
  ADB_MAX_DATA,
  ADB_VERSION,
  AUTH_RSAPUBLICKEY,
  AUTH_SIGNATURE,
  AUTH_TOKEN,
  encodeMessage,
  parseFeatures,
  parseMessages,
  signToken,
  type AdbMessage,
} from "./adb-codec.js";
import { selfSignedCertificate } from "./x509.js";

/** The phone is on Wireless debugging and does not know this server's key. */
export class AdbPairingRequiredError extends Error {}

export type AdbPhase = "connecting" | "authorizing" | "ready";

export interface AdbConnectOptions {
  host: string;
  port: number;
  /** PKCS#8 PEM of the RSA key this client authenticates with. */
  privateKeyPem: string;
  /** The same key's public half in the format adbd stores, base64. */
  publicKey: string;
  /** Time to reach the device and get its first answer. */
  connectTimeoutMs?: number;
  /** Time the person has to approve the key on the device screen. */
  authTimeoutMs?: number;
  onPhase?: (phase: AdbPhase) => void;
}

interface Pending {
  data: Buffer;
  done?: () => void;
}

/** One service stream (a shell, a sync session) on an ADB connection. */
export class AdbStream {
  private onData: ((chunk: Buffer) => void) | null = null;
  private onClose: ((error?: string) => void) | null = null;
  private early: Buffer[] = [];
  private closeInfo: { error?: string } | null = null;
  private queue: Pending[] = [];
  private sending = false;
  /** @internal */
  remoteId = 0;
  /** @internal */
  opened = false;
  closed = false;
  /**
   * Hold the acknowledgement of each incoming packet until release() is
   * called, so a slow consumer slows the device down instead of buffering.
   */
  holdAcks = false;
  private heldAck = false;
  /** @internal */
  openWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    readonly localId: number,
    private readonly connection: AdbConnection,
  ) {}

  /** Starts delivery; anything that arrived before is handed over first. */
  setHandlers(handlers: {
    onData: (chunk: Buffer) => void;
    onClose: (error?: string) => void;
  }): void {
    this.onData = handlers.onData;
    this.onClose = handlers.onClose;
    for (const chunk of this.early.splice(0)) handlers.onData(chunk);
    if (this.closeInfo) handlers.onClose(this.closeInfo.error);
  }

  /** Resolves once the device has acknowledged all of `data`. */
  write(data: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The stream is closed"));
    return new Promise<void>((resolve, reject) => {
      const room = Math.max(1, this.connection.maxData);
      if (data.length === 0) {
        resolve();
        return;
      }
      for (let offset = 0; offset < data.length; offset += room) {
        const part = data.subarray(offset, offset + room);
        const last = offset + room >= data.length;
        this.queue.push({
          data: part,
          done: last ? resolve : undefined,
        });
      }
      this.rejectors.add(reject);
      this.pump();
    });
  }
  private rejectors = new Set<(e: Error) => void>();

  /** @internal */
  pump(): void {
    if (this.sending || !this.opened || this.closed) return;
    const next = this.queue[0];
    if (!next) return;
    this.sending = true;
    this.connection.sendMessage(A_WRTE, this.localId, this.remoteId, next.data);
  }

  /** @internal */
  acked(): void {
    this.sending = false;
    const sent = this.queue.shift();
    sent?.done?.();
    this.pump();
  }

  /** @internal */
  acknowledgeIncoming(): void {
    if (this.holdAcks) this.heldAck = true;
    else this.connection.sendMessage(A_OKAY, this.localId, this.remoteId);
  }

  /** Lets the device send the next packet after a held acknowledgement. */
  release(): void {
    if (!this.heldAck || this.closed) return;
    this.heldAck = false;
    this.connection.sendMessage(A_OKAY, this.localId, this.remoteId);
  }

  /** @internal */
  deliver(chunk: Buffer): void {
    if (this.onData) this.onData(chunk);
    else this.early.push(chunk);
  }

  /** @internal */
  end(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    const failure = new Error(error ?? "The stream is closed");
    for (const reject of this.rejectors) reject(failure);
    this.rejectors.clear();
    this.queue = [];
    if (this.openWaiter) {
      this.openWaiter.reject(failure);
      this.openWaiter = null;
    }
    this.closeInfo = { error };
    this.onClose?.(error);
  }

  close(): void {
    if (this.closed) return;
    if (this.opened) {
      this.connection.sendMessage(A_CLSE, this.localId, this.remoteId);
    }
    this.end();
    this.connection.forget(this.localId);
  }
}

/** An authenticated ADB transport: many streams over one TCP connection. */
export class AdbConnection {
  features: string[] = [];
  maxData = 4096;
  closed = false;
  private streams = new Map<number, AdbStream>();
  private nextId = 1;
  private closeHandlers = new Set<(error?: string) => void>();

  constructor(
    private readonly socketRef: { current: net.Socket | tls.TLSSocket },
    private readonly rawSocket: net.Socket,
  ) {}

  /** @internal */
  sendMessage(command: number, arg0: number, arg1: number, data?: Buffer) {
    const socket = this.socketRef.current;
    if (!socket.destroyed) {
      socket.write(encodeMessage(command, arg0, arg1, data));
    }
  }

  /** @internal */
  forget(id: number) {
    this.streams.delete(id);
  }

  onClose(handler: (error?: string) => void): void {
    this.closeHandlers.add(handler);
  }

  /** Opens a service such as `shell:ls` or `sync:`. */
  open(service: string, timeoutMs = 10_000): Promise<AdbStream> {
    if (this.closed) return Promise.reject(new Error("The device is gone"));
    const stream = new AdbStream(this.nextId++, this);
    this.streams.set(stream.localId, stream);
    return new Promise<AdbStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.end("The device did not open the service in time");
        this.streams.delete(stream.localId);
      }, timeoutMs);
      stream.openWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve(stream);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.sendMessage(A_OPEN, stream.localId, 0, Buffer.from(`${service}\0`));
    });
  }

  /** @internal */
  handle(message: AdbMessage): void {
    const stream = this.streams.get(message.arg1);
    switch (message.command) {
      case A_OKAY:
        if (!stream) return;
        if (!stream.opened) {
          stream.remoteId = message.arg0;
          stream.opened = true;
          stream.openWaiter?.resolve();
          stream.openWaiter = null;
          stream.pump();
        } else {
          stream.acked();
        }
        return;
      case A_WRTE:
        if (!stream) return;
        stream.acknowledgeIncoming();
        stream.deliver(message.data);
        return;
      case A_CLSE:
        if (!stream) return;
        if (stream.opened) {
          this.sendMessage(A_CLSE, stream.localId, stream.remoteId);
          stream.end();
        } else {
          stream.end("The device refused to open the service");
        }
        this.streams.delete(stream.localId);
        return;
      default:
        return;
    }
  }

  /** @internal */
  finish(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) stream.end(error);
    this.streams.clear();
    this.socketRef.current.destroy();
    this.rawSocket.destroy();
    for (const handler of this.closeHandlers) handler(error);
  }

  close(): void {
    this.finish();
  }
}

/**
 * Connects, switches to TLS when the phone asks (Wireless debugging) and
 * authenticates. Rejects with a readable message when the device can't be
 * reached or refuses the key.
 */
export function connectAdb(options: AdbConnectOptions): Promise<AdbConnection> {
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const authTimeout = options.authTimeoutMs ?? 60_000;

  return new Promise<AdbConnection>((resolve, reject) => {
    const rawSocket = net.connect({ host: options.host, port: options.port });
    rawSocket.setNoDelay(true);
    rawSocket.setKeepAlive(true, 30_000);
    const socketRef: { current: net.Socket | tls.TLSSocket } = {
      current: rawSocket,
    };
    const connection = new AdbConnection(socketRef, rawSocket);

    let secured = false;
    let ready = false;
    let finished = false;
    let signed = false;
    let keySent = false;
    let received: Buffer = Buffer.alloc(0);

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

    function finish(info: { error?: string; needsPairing?: boolean }) {
      if (finished) return;
      finished = true;
      clearTimer();
      if (ready) {
        connection.finish(info.error);
        return;
      }
      socketRef.current.destroy();
      rawSocket.destroy();
      const message = info.error ?? "The device closed the connection";
      reject(
        info.needsPairing
          ? new AdbPairingRequiredError(message)
          : new Error(message),
      );
    }
    function fail(error: Error) {
      if (secured && !ready) {
        finish({
          error: `The device did not accept this server's key (${error.message}). Pair it first: Wireless debugging → Pair device with pairing code`,
          needsPairing: true,
        });
        return;
      }
      finish({ error: error.message });
    }

    const send = (c: number, a0: number, a1: number, data?: Buffer) =>
      connection.sendMessage(c, a0, a1, data);

    function handle(message: AdbMessage) {
      if (ready) {
        connection.handle(message);
        return;
      }
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
            options.onPhase?.("authorizing");
            setTimer(
              authTimeout,
              "The key was not approved on the device in time",
            );
          } else {
            fail(new Error("The device rejected the key"));
          }
          return;
        }
        case A_STLS:
          if (!secured) upgradeToTls();
          return;
        case A_CNXN: {
          connection.features = parseFeatures(message.data.toString("utf8"));
          connection.maxData = Math.min(
            message.arg1 > 0 ? message.arg1 : 4096,
            ADB_MAX_DATA,
          );
          ready = true;
          clearTimer();
          resolve(connection);
          return;
        }
        default:
          return;
      }
    }

    function upgradeToTls() {
      secured = true;
      send(A_STLS, A_STLS_VERSION, 0);
      const plain = socketRef.current;
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
      socketRef.current = secure;
      attach(secure);
      options.onPhase?.("authorizing");
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
        if (secured && !ready && !finished) {
          fail(new Error("the connection was closed during the TLS handshake"));
        } else {
          finish({});
        }
      });
    }

    rawSocket.on("connect", () => {
      options.onPhase?.("connecting");
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
