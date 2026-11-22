import { afterEach, describe, expect, it } from "vitest";
import { generateAdbKey } from "../../src/backend/adb-key.js";
import { connectAdb } from "../../src/backend/adb-protocol.js";
import {
  listDirectory,
  pullFile,
  pushFile,
  runCommand,
  shellQuote,
  statPath,
} from "../../src/backend/adb-sync.js";
import { startFilesDevice, type FakeFilesDevice } from "./fake-files-device.js";

const devices: FakeFilesDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

async function connect(device: FakeFilesDevice) {
  const key = generateAdbKey();
  return connectAdb({
    host: "127.0.0.1",
    port: device.port,
    privateKeyPem: key.privateKeyPem,
    publicKey: key.publicKey,
  });
}

describe("adb sync", () => {
  it("lists, stats and pulls", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/a.txt": "hello",
      "/sdcard/Music": null,
    });
    devices.push(device);
    const adb = await connect(device);

    const entries = await listDirectory(adb, "/sdcard");
    expect(entries.map((e) => [e.name, e.dir, e.size]).sort()).toEqual([
      ["Music", true, 0],
      ["a.txt", false, 5],
    ]);
    expect((await statPath(adb, "/sdcard/a.txt"))?.size).toBe(5);
    expect(await statPath(adb, "/sdcard/none")).toBeNull();

    const chunks: Buffer[] = [];
    await pullFile(adb, "/sdcard/a.txt", (c) => void chunks.push(c));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    await expect(
      pullFile(adb, "/sdcard/Music", () => undefined),
    ).rejects.toThrow();
    adb.close();
  });

  it("pushes a file in several chunks", async () => {
    const device = await startFilesDevice({ "/sdcard": null });
    devices.push(device);
    const adb = await connect(device);
    const big = Buffer.alloc(200_000, 7);
    const session = await pushFile(
      adb,
      "/sdcard/big.bin",
      0o664,
      1_700_000_123,
    );
    await session.write(big.subarray(0, 100_000));
    await session.write(big.subarray(100_000));
    await session.finish();
    expect(device.files.get("/sdcard/big.bin")?.data?.equals(big)).toBe(true);
    expect(device.files.get("/sdcard/big.bin")?.mtime).toBe(1_700_000_123);
    adb.close();
  });

  it("runs commands with quoting and reports failures", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/it's": "x",
    });
    devices.push(device);
    const adb = await connect(device);
    expect(
      (await runCommand(adb, `rm -rf ${shellQuote("/sdcard/it's")}`)).code,
    ).toBe(0);
    expect(device.files.has("/sdcard/it's")).toBe(false);
    const failed = await runCommand(
      adb,
      `mv ${shellQuote("/nope")} ${shellQuote("/x")}`,
    );
    expect(failed.code).toBe(1);
    expect(failed.output).toMatch(/No such file/);
    adb.close();
  });
});
