import net from "node:net";
import {
  constants,
  createPublicKey,
  publicDecrypt,
  randomBytes,
} from "node:crypto";
import {
  A_AUTH,
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_WRTE,
  AUTH_RSAPUBLICKEY,
  AUTH_SIGNATURE,
  AUTH_TOKEN,
  SHELL_EXIT,
  SHELL_STDIN,
  SHELL_STDOUT,
  SHELL_WINDOW_SIZE,
  encodeMessage,
  parseMessages,
  parseShellPackets,
  shellPacket,
  type AdbMessage,
} from "../../src/backend/adb-protocol.js";

const SHA1_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");

/** Reads the little endian words of an adbd public key blob. */
export function decodePublicKey(base64: string) {
  const blob = Buffer.from(base64.split(" ")[0], "base64");
  const words = blob.readUInt32LE(0);
  const n0inv = blob.readUInt32LE(4);
  const read = (offset: number) => {
    let value = 0n;
    for (let i = words - 1; i >= 0; i -= 1) {
      value = (value << 32n) | BigInt(blob.readUInt32LE(offset + i * 4));
    }
    return value;
  };
  return {
    words,
    n0inv,
    n: read(8),
    rr: read(8 + words * 4),
    exponent: blob.readUInt32LE(8 + words * 8),
    length: blob.length,
  };
}

export interface FakeDevice {
  port: number;
  /** Keys adbd has been told to trust, as PEM public keys. */
  trusted: string[];
  resizes: string[];
  stdin: Buffer[];
  services: string[];
  close: () => Promise<void>;
}

/** An adbd that asks for authentication and serves a tiny shell. */
export async function startDevice(
  options: { shellV2?: boolean } = {},
): Promise<FakeDevice> {
  const shellV2 = options.shellV2 ?? true;
  const device: FakeDevice = {
    port: 0,
    trusted: [],
    resizes: [],
    stdin: [],
    services: [],
    close: async () => {},
  };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    let token: Buffer = randomBytes(20);
    let shellBuffer: Buffer = Buffer.alloc(0);
    const send = (cmd: number, a0: number, a1: number, data?: Buffer) =>
      socket.write(encodeMessage(cmd, a0, a1, data));
    const banner = `device::ro.product.model=Fake;features=${shellV2 ? "shell_v2,cmd" : "cmd"}\0`;
    const stdout = (text: string) =>
      send(
        A_WRTE,
        7,
        1,
        shellV2
          ? shellPacket(SHELL_STDOUT, Buffer.from(text))
          : Buffer.from(text),
      );

    const onMessage = (m: AdbMessage) => {
      if (m.command === A_CNXN) {
        token = randomBytes(20);
        send(A_AUTH, AUTH_TOKEN, 0, token);
      } else if (m.command === A_AUTH && m.arg0 === AUTH_SIGNATURE) {
        const ok = device.trusted.some((pem) => {
          try {
            const recovered = publicDecrypt(
              { key: pem, padding: constants.RSA_PKCS1_PADDING },
              m.data,
            );
            return recovered.equals(Buffer.concat([SHA1_PREFIX, token]));
          } catch {
            return false;
          }
        });
        if (ok) send(A_CNXN, 0x01000001, 4096, Buffer.from(banner));
        else {
          token = randomBytes(20);
          send(A_AUTH, AUTH_TOKEN, 0, token);
        }
      } else if (m.command === A_AUTH && m.arg0 === AUTH_RSAPUBLICKEY) {
        const decoded = decodePublicKey(
          m.data.toString("utf8").replace(/\0$/, ""),
        );
        const pem = createPublicKey({
          key: {
            kty: "RSA",
            n: Buffer.from(
              decoded.n.toString(16).padStart(512, "0"),
              "hex",
            ).toString("base64url"),
            e: Buffer.from(
              decoded.exponent.toString(16).padStart(6, "0"),
              "hex",
            ).toString("base64url"),
          },
          format: "jwk",
        }).export({ type: "spki", format: "pem" }) as string;
        device.trusted.push(pem);
        setTimeout(
          () => send(A_CNXN, 0x01000001, 4096, Buffer.from(banner)),
          20,
        );
      } else if (m.command === A_OPEN) {
        device.services.push(m.data.toString("utf8").replace(/\0$/, ""));
        send(A_OKAY, 7, m.arg0);
      } else if (m.command === A_WRTE) {
        send(A_OKAY, 7, m.arg0);
        if (!shellV2) {
          device.stdin.push(Buffer.from(m.data));
          stdout(m.data.toString());
          return;
        }
        shellBuffer = Buffer.concat([shellBuffer, m.data]);
        const parsed = parseShellPackets(shellBuffer);
        shellBuffer = parsed.rest;
        for (const packet of parsed.packets) {
          if (packet.id === SHELL_WINDOW_SIZE) {
            device.resizes.push(packet.data.toString());
          }
          if (packet.id === SHELL_STDIN) {
            const text = packet.data.toString();
            device.stdin.push(Buffer.from(packet.data));
            stdout(text);
            if (text.includes("exit")) {
              send(A_WRTE, 7, 1, shellPacket(SHELL_EXIT, Buffer.from([3])));
              send(A_CLSE, 7, 1);
            }
          }
        }
      } else if (m.command === A_CLSE) {
        socket.end();
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer]);
      const parsed = parseMessages(buffer);
      buffer = parsed.rest;
      parsed.messages.forEach(onMessage);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  device.port = (server.address() as net.AddressInfo).port;
  device.close = () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => resolve());
    });
  return device;
}

export async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
