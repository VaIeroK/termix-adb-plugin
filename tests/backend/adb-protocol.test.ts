import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generateAdbKey } from "../../src/backend/adb-key.js";
import {
  A_OKAY,
  A_WRTE,
  encodeMessage,
  openAdbShell,
  parseFeatures,
  parseMessages,
} from "../../src/backend/adb-protocol.js";
import {
  decodePublicKey,
  startDevice,
  until,
  type FakeDevice,
} from "./fake-device.js";

const devices: FakeDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

describe("adb public key", () => {
  it("matches the layout adbd expects", () => {
    const key = generateAdbKey();
    const decoded = decodePublicKey(key.publicKey);
    expect(decoded.words).toBe(64);
    expect(decoded.length).toBe(524);
    expect(decoded.exponent).toBe(65537);
    // n0inv * n[0] == -1 (mod 2^32)
    expect(
      (BigInt(decoded.n0inv) * (decoded.n & 0xffffffffn)) & 0xffffffffn,
    ).toBe(0xffffffffn);
    // rr == (2^2048)^2 mod n
    expect(decoded.rr).toBe((1n << 4096n) % decoded.n);
    expect(key.publicKey.endsWith(" termix@adb")).toBe(true);
  });
});

describe("codec", () => {
  it("round trips messages and keeps partial ones", () => {
    const a = encodeMessage(A_WRTE, 1, 2, Buffer.from("hello"));
    const b = encodeMessage(A_OKAY, 3, 4);
    const joined = Buffer.concat([a, b.subarray(0, 10)]);
    const first = parseMessages(joined);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].data.toString()).toBe("hello");
    const second = parseMessages(Buffer.concat([first.rest, b.subarray(10)]));
    expect(second.messages[0]).toMatchObject({
      command: A_OKAY,
      arg0: 3,
      arg1: 4,
    });
  });
  it("rejects garbage", () => {
    expect(() => parseMessages(Buffer.alloc(24, 1))).toThrow(/magic/);
  });
  it("reads features", () => {
    expect(parseFeatures("device::ro.x=y;features=shell_v2,cmd;")).toEqual([
      "shell_v2",
      "cmd",
    ]);
    expect(parseFeatures("device::")).toEqual([]);
  });
});

describe("openAdbShell", () => {
  it("authorizes a new key, then signs in silently the second time", async () => {
    const device = await startDevice();
    devices.push(device);
    const key = generateAdbKey();
    const phases: string[] = [];
    const output: string[] = [];
    let closed: { exitCode?: number; error?: string } | null = null;

    const shell = await openAdbShell(
      { host: "127.0.0.1", port: device.port, ...key, cols: 120, rows: 40 },
      {
        onData: (c) => output.push(c.toString()),
        onPhase: (p) => phases.push(p),
        onClose: (info) => (closed = info),
      },
    );
    expect(phases).toEqual(["connecting", "authorizing", "ready"]);
    expect(device.trusted).toHaveLength(1);
    expect(device.services).toEqual(["shell,v2,TERM=xterm-256color,pty:"]);

    await until(() => device.resizes.length === 1);
    expect(device.resizes[0]).toBe("40x120,0x0");

    shell.write("ls\n");
    await until(() => output.join("").includes("ls\n"));
    shell.resize(100, 30);
    await until(() => device.resizes.length === 2);
    expect(device.resizes[1]).toBe("30x100,0x0");

    shell.write("exit\n");
    await until(() => closed !== null);
    expect(closed).toMatchObject({ exitCode: 3 });

    // A second connection with the same key needs no approval.
    const phases2: string[] = [];
    const again = await openAdbShell(
      { host: "127.0.0.1", port: device.port, ...key, cols: 80, rows: 24 },
      { onData: () => {}, onPhase: (p) => phases2.push(p), onClose: () => {} },
    );
    expect(phases2).toEqual(["connecting", "ready"]);
    expect(device.trusted).toHaveLength(1);
    again.close();
  });

  it("splits large input and keeps UTF-8 intact", async () => {
    const device = await startDevice();
    devices.push(device);
    const key = generateAdbKey();
    const output: Buffer[] = [];
    const shell = await openAdbShell(
      { host: "127.0.0.1", port: device.port, ...key, cols: 80, rows: 24 },
      { onData: (c) => output.push(c), onClose: () => {} },
    );
    const text = "привет мир ".repeat(1000);
    shell.write(text);
    const expected = Buffer.from(text);
    await until(
      () => Buffer.concat(device.stdin).length >= expected.length,
      4000,
    );
    expect(Buffer.concat(device.stdin).equals(expected)).toBe(true);
    shell.close();
  });

  it("falls back to the legacy shell without shell_v2", async () => {
    const device = await startDevice({ shellV2: false });
    devices.push(device);
    const key = generateAdbKey();
    const output: string[] = [];
    const shell = await openAdbShell(
      { host: "127.0.0.1", port: device.port, ...key, cols: 80, rows: 24 },
      { onData: (c) => output.push(c.toString()), onClose: () => {} },
    );
    expect(device.services).toEqual(["shell:"]);
    shell.write("id\n");
    await until(() => output.join("") === "id\n");
    shell.resize(10, 10); // no-op, must not throw
    shell.close();
  });

  it("fails clearly when nothing listens", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const key = generateAdbKey();
    await expect(
      openAdbShell(
        { host: "127.0.0.1", port, ...key, cols: 80, rows: 24 },
        { onData: () => {}, onClose: () => {} },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("times out when the peer never answers", async () => {
    const key = generateAdbKey();
    const blackhole = net.createServer((s) => s.on("data", () => {}));
    await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
    const port = (blackhole.address() as net.AddressInfo).port;
    await expect(
      openAdbShell(
        {
          host: "127.0.0.1",
          port,
          ...key,
          cols: 80,
          rows: 24,
          connectTimeoutMs: 100,
        },
        { onData: () => {}, onClose: () => {} },
      ),
    ).rejects.toThrow(/did not answer/);
    blackhole.close();
  });
});
