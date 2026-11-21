import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { generateAdbKey } from "../../src/backend/adb-key.js";
import {
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_STLS,
  A_STLS_VERSION,
  A_WRTE,
  SHELL_STDIN,
  SHELL_STDOUT,
  encodeMessage,
  parseMessages,
  parseShellPackets,
  shellPacket,
  type AdbMessage,
} from "../../src/backend/adb-protocol.js";
import {
  CLIENT_NAME,
  EXPORT_LABEL,
  PAIRING_PEER_INFO,
  PAIRING_SPAKE2_MSG,
  PairingCipher,
  PairingReader,
  SERVER_NAME,
  pairingPacket,
  peerInfoBlob,
} from "../../src/backend/pairing.js";
import { createSpake2 } from "../../src/backend/spake2.js";
import { selfSignedCertificate } from "../../src/backend/x509.js";
import { decodePublicKey } from "./fake-device.js";

export interface FakeWireless {
  pairingPort: number;
  connectPort: number;
  /** RSA moduli (hex) of the keys that completed pairing. */
  paired: string[];
  stdin: Buffer[];
  close: () => Promise<void>;
}

function modulusHex(publicKey: string): string {
  return decodePublicKey(publicKey).n.toString(16);
}

/** A phone with Wireless debugging on: a pairing port and a TLS connect port. */
export async function startWirelessDevice(code: string): Promise<FakeWireless> {
  const deviceKey = generateAdbKey();
  const cert = selfSignedCertificate(deviceKey.privateKeyPem);
  const sockets = new Set<net.Socket>();
  const device: FakeWireless = {
    pairingPort: 0,
    connectPort: 0,
    paired: [],
    stdin: [],
    close: async () => {},
  };

  const pairing = tls.createServer(
    {
      cert,
      key: deviceKey.privateKeyPem,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: false,
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      const reader = new PairingReader(socket);
      void (async () => {
        const exported = socket.exportKeyingMaterial(
          64,
          EXPORT_LABEL,
          Buffer.alloc(0),
        );
        const spake = createSpake2({
          role: "bob",
          myName: SERVER_NAME,
          theirName: CLIENT_NAME,
          password: Buffer.concat([Buffer.from(code), exported]),
        });
        const first = await reader.packet();
        socket.write(pairingPacket(PAIRING_SPAKE2_MSG, spake.message));
        const cipher = new PairingCipher(spake.finish(first.payload));
        const info = await reader.packet();
        try {
          const blob = cipher.decrypt(info.payload);
          const text = blob.subarray(1).toString("utf8").replace(/\0.*$/s, "");
          device.paired.push(modulusHex(text));
          socket.write(
            pairingPacket(
              PAIRING_PEER_INFO,
              cipher.encrypt(peerInfoBlob("device-guid")),
            ),
          );
        } catch {
          socket.destroy();
        }
      })().catch(() => socket.destroy());
    },
  );

  const connectServer = net.createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    const onRaw = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // One header at a time: TLS bytes may already follow the STLS packet.
      while (buffer.length >= 24) {
        const command = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(12);
        if (buffer.length < 24 + length) return;
        buffer = buffer.subarray(24 + length);
        if (command === A_CNXN) {
          raw.write(encodeMessage(A_STLS, A_STLS_VERSION, 0));
        } else if (command === A_STLS) {
          raw.off("data", onRaw);
          // TLS bytes may already follow the STLS packet; hand them over.
          const duplex = new Duplex({
            read() {},
            write(data, _encoding, done) {
              raw.write(data, done);
            },
            final(done) {
              raw.end(done);
            },
          });
          if (buffer.length) duplex.push(buffer);
          raw.on("data", (more: Buffer) => duplex.push(more));
          raw.on("end", () => duplex.push(null));
          raw.on("close", () => duplex.destroy());
          startTls(duplex);
          return;
        }
      }
    };
    raw.on("data", onRaw);
  });

  function startTls(raw: Duplex) {
    const secure = new tls.TLSSocket(raw, {
      isServer: true,
      cert,
      key: deviceKey.privateKeyPem,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: false,
    } as tls.TLSSocketOptions);
    secure.on("error", () => undefined);
    secure.once("secure", () => {
      const peer = secure.getPeerCertificate(true);
      const known =
        peer?.raw &&
        device.paired.includes(
          Buffer.from(
            (
              new X509Certificate(peer.raw).publicKey.export({
                format: "jwk",
              }) as { n: string }
            ).n,
            "base64url",
          ).toString("hex"),
        );
      if (!known) {
        secure.destroy();
        return;
      }
      secure.write(
        encodeMessage(
          A_CNXN,
          0x01000001,
          4096,
          Buffer.from("device::ro.product.model=Wireless;features=shell_v2\0"),
        ),
      );
    });
    let buffer: Buffer = Buffer.alloc(0);
    let shellBuffer: Buffer = Buffer.alloc(0);
    const send = (cmd: number, a0: number, a1: number, data?: Buffer) =>
      secure.write(encodeMessage(cmd, a0, a1, data));
    const onMessage = (m: AdbMessage) => {
      if (m.command === A_OPEN) {
        send(A_OKAY, 9, m.arg0);
      } else if (m.command === A_WRTE) {
        send(A_OKAY, 9, m.arg0);
        shellBuffer = Buffer.concat([shellBuffer, m.data]);
        const parsed = parseShellPackets(shellBuffer);
        shellBuffer = parsed.rest;
        for (const packet of parsed.packets) {
          if (packet.id === SHELL_STDIN) {
            device.stdin.push(Buffer.from(packet.data));
            send(
              A_WRTE,
              9,
              m.arg0,
              shellPacket(SHELL_STDOUT, Buffer.from(packet.data)),
            );
          }
        }
      } else if (m.command === A_CLSE) {
        secure.end();
      }
    };
    secure.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseMessages(buffer);
      buffer = parsed.rest;
      parsed.messages.forEach(onMessage);
    });
  }

  await Promise.all([
    new Promise<void>((r) => pairing.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => connectServer.listen(0, "127.0.0.1", r)),
  ]);
  device.pairingPort = (pairing.address() as net.AddressInfo).port;
  device.connectPort = (connectServer.address() as net.AddressInfo).port;
  device.close = () =>
    new Promise<void>((resolve) => {
      sockets.forEach((s) => s.destroy());
      pairing.close();
      connectServer.close(() => resolve());
    });
  return device;
}
