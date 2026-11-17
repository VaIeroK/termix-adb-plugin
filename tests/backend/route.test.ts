import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json" with { type: "json" };
import { activate } from "../../src/backend/index.js";
import { startDevice, until, type FakeDevice } from "./fake-device.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: (string | Buffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close");
  }
  get json() {
    return this.sent
      .filter((m): m is string => typeof m === "string")
      .map((m) => JSON.parse(m) as Record<string, unknown>);
  }
  get output() {
    return Buffer.concat(
      this.sent.filter((m): m is Buffer => Buffer.isBuffer(m)),
    ).toString();
  }
}

const host: PluginHostSummary = {
  id: 5,
  userId: "user-1",
  name: "Pixel",
  ip: "127.0.0.1",
  port: 22,
  username: "",
  tags: null,
  folder: null,
  authType: "none",
};

const devices: FakeDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

async function setup(options: {
  settings?: Record<string, unknown>;
  hosts?: PluginHostSummary[];
  permissions?: string[];
}) {
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest: manifest as never,
    capabilities: manifest.capabilities,
    hosts: options.hosts ?? [host],
    permissions: options.permissions,
  });
  for (const [key, value] of Object.entries(options.settings ?? {})) {
    await mock.ctx.settings.setHost(5, key, value);
  }
  await activate(mock.ctx);
  mock.setActor("user-1");
  const route = mock.wsRoutes.find((r) => r.path === "/shell");
  if (!route?.handler) throw new Error("no /shell route");
  const open = async (query: string) => {
    const socket = new FakeSocket();
    await route.handler!({
      userId: "user-1",
      request: { url: `/plugin-ws/adb/shell?${query}` },
      socket,
      clientIp: "127.0.0.1",
      requestOrigin: "http://localhost",
      isDataUnlocked: () => true,
    } as never);
    return socket;
  };
  return { mock, open };
}

describe("/shell route", () => {
  it("opens a shell, relays bytes both ways and stores one key", async () => {
    const device = await startDevice();
    devices.push(device);
    const { mock, open } = await setup({
      settings: { enableAdb: true, adbPort: device.port },
    });

    const socket = await open("hostId=5&cols=100&rows=30");
    expect(socket.json.map((m) => m.phase).filter(Boolean)).toEqual([
      "connecting",
      "authorizing",
      "ready",
    ]);
    await until(() => device.resizes.includes("30x100,0x0"));

    socket.emit("message", Buffer.from("ls\n"), true);
    await until(() => socket.output.includes("ls\n"));
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "resize", cols: 90, rows: 20 })),
      false,
    );
    await until(() => device.resizes.includes("20x90,0x0"));

    socket.emit("message", Buffer.from("exit\n"), true);
    await until(() => socket.closed !== null);
    expect(socket.json.at(-1)).toMatchObject({ type: "exit", code: 3 });

    // The key was made once and is reused: the device is not asked again.
    const stored = await mock.ctx.settings.get<string>("privateKey");
    expect(stored).toContain("BEGIN PRIVATE KEY");
    const again = await open("hostId=5");
    expect(again.json.map((m) => m.phase).filter(Boolean)).toEqual([
      "connecting",
      "ready",
    ]);
    expect(device.trusted).toHaveLength(1);
    again.emit("close");
  });

  it("refuses a host with ADB turned off", async () => {
    const { open } = await setup({ settings: { enableAdb: false } });
    const socket = await open("hostId=5");
    expect(socket.json.at(-1)).toMatchObject({
      type: "error",
      message: "ADB is off for this host",
    });
    expect(socket.closed?.code).toBe(1008);
  });

  it("refuses a host the user can't see", async () => {
    const { open } = await setup({ hosts: [], settings: { enableAdb: true } });
    const socket = await open("hostId=5");
    expect(socket.json.at(-1)).toMatchObject({ type: "error" });
    expect(socket.closed).not.toBeNull();
  });

  it("refuses a bad host id", async () => {
    const { open } = await setup({});
    const socket = await open("hostId=abc");
    expect(socket.json.at(-1)).toMatchObject({ message: "Missing host" });
  });

  it("reports an unreachable device", async () => {
    const { open } = await setup({
      settings: { enableAdb: true, adbPort: 1 },
    });
    const socket = await open("hostId=5");
    expect(socket.json.at(-1)).toMatchObject({ type: "error" });
    expect(socket.closed?.code).toBe(1011);
  });
});
