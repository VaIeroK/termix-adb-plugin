import { afterEach, describe, expect, it } from "vitest";
import { generateAdbKey } from "../../src/backend/adb-key.js";
import { openAdbShell } from "../../src/backend/adb-protocol.js";
import { pairWithDevice } from "../../src/backend/pairing.js";
import { createSpake2 } from "../../src/backend/spake2.js";
import { until } from "./fake-device.js";
import { startWirelessDevice, type FakeWireless } from "./fake-wireless.js";

const devices: FakeWireless[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

describe("SPAKE2", () => {
  const cn = Buffer.from("adb pair client\0");
  const sn = Buffer.from("adb pair server\0");
  it("agrees on a key for the same password", () => {
    const password = Buffer.from("123456-secret");
    const a = createSpake2({
      role: "alice",
      myName: cn,
      theirName: sn,
      password,
    });
    const b = createSpake2({
      role: "bob",
      myName: sn,
      theirName: cn,
      password,
    });
    expect(a.finish(b.message).equals(b.finish(a.message))).toBe(true);
  });
  it("disagrees for another password", () => {
    const a = createSpake2({
      role: "alice",
      myName: cn,
      theirName: sn,
      password: Buffer.from("111111"),
    });
    const b = createSpake2({
      role: "bob",
      myName: sn,
      theirName: cn,
      password: Buffer.from("222222"),
    });
    expect(a.finish(b.message).equals(b.finish(a.message))).toBe(false);
  });
  it("rejects a point that is not on the curve", () => {
    const a = createSpake2({
      role: "alice",
      myName: cn,
      theirName: sn,
      password: Buffer.from("1"),
    });
    expect(() => a.finish(Buffer.alloc(32, 0xff))).toThrow();
  });
});

describe("wireless debugging", () => {
  it("pairs with the code, then opens a shell over TLS", async () => {
    const phone = await startWirelessDevice("482913");
    devices.push(phone);
    const key = generateAdbKey();

    await pairWithDevice({
      host: "127.0.0.1",
      port: phone.pairingPort,
      code: "482913",
      privateKeyPem: key.privateKeyPem,
      publicKey: key.publicKey,
    });
    expect(phone.paired).toHaveLength(1);

    const out: Buffer[] = [];
    const shell = await openAdbShell(
      {
        host: "127.0.0.1",
        port: phone.connectPort,
        privateKeyPem: key.privateKeyPem,
        publicKey: key.publicKey,
        cols: 80,
        rows: 24,
      },
      { onData: (c) => out.push(c), onClose: () => undefined },
    );
    shell.write("echo hi\n");
    await until(() => Buffer.concat(out).toString().includes("echo hi"));
    shell.close();
  });

  it("refuses a wrong pairing code", async () => {
    const phone = await startWirelessDevice("482913");
    devices.push(phone);
    const key = generateAdbKey();
    await expect(
      pairWithDevice({
        host: "127.0.0.1",
        port: phone.pairingPort,
        code: "000000",
        privateKeyPem: key.privateKeyPem,
        publicKey: key.publicKey,
        timeoutMs: 3000,
      }),
    ).rejects.toThrow(/code|closed/i);
    expect(phone.paired).toHaveLength(0);
  });

  it("tells the person to pair when the key is unknown", async () => {
    const phone = await startWirelessDevice("482913");
    devices.push(phone);
    const key = generateAdbKey();
    await expect(
      openAdbShell(
        {
          host: "127.0.0.1",
          port: phone.connectPort,
          privateKeyPem: key.privateKeyPem,
          publicKey: key.publicKey,
          cols: 80,
          rows: 24,
          connectTimeoutMs: 3000,
        },
        { onData: () => undefined, onClose: () => undefined },
      ),
    ).rejects.toThrow(/Pair it first/);
  });
});
