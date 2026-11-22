import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json" with { type: "json" };
import { activate } from "../../src/backend/index.js";
import { crc32 } from "../../src/backend/zip-stream.js";
import { until } from "./fake-device.js";
import { startFilesDevice, type FakeFilesDevice } from "./fake-files-device.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: (string | Buffer)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(
    data: string | Buffer,
    optionsOrCb?: unknown,
    cb?: (error?: Error) => void,
  ) {
    this.sent.push(data);
    const done = typeof optionsOrCb === "function" ? optionsOrCb : cb;
    (done as ((e?: Error) => void) | undefined)?.();
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
  frames(id: number) {
    return Buffer.concat(
      this.sent
        .filter((m): m is Buffer => Buffer.isBuffer(m))
        .filter((m) => m.readUInt32BE(0) === id)
        .map((m) => m.subarray(4)),
    );
  }
  request(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  frame(id: number, data: Buffer) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(id);
    this.emit("message", Buffer.concat([head, data]), true);
  }
  reply(id: number) {
    return this.json.find((m) => m.id === id && (m.ok !== undefined || m.type));
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

const devices: FakeFilesDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.close()));
});

type Handler = (req: unknown, res: unknown) => unknown;

class FakeResponse extends EventEmitter {
  headers: Record<string, string | number> = {};
  chunks: Buffer[] = [];
  statusCode = 200;
  body: unknown = null;
  writableEnded = false;
  destroyed = false;
  setHeader(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = value;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(body: unknown) {
    this.body = body;
  }
  write(chunk: Buffer) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  get data() {
    return Buffer.concat(this.chunks);
  }
}

/** Reads a zip made of stored entries through its central directory. */
function readStoredZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const start = offset + 30 + zip.readUInt16LE(offset + 26);
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

let downloadHandler: Handler | null = null;

async function download(ticket: string) {
  const res = new FakeResponse();
  await downloadHandler!({ params: { ticket } }, res);
  return res;
}

async function openFiles(device: FakeFilesDevice) {
  downloadHandler = null;
  const mock = createMockCtx({
    router: () => ({
      get: (_path: string, handler: Handler) => {
        downloadHandler = handler;
      },
    }),
    pluginId: manifest.id,
    manifest: manifest as never,
    capabilities: manifest.capabilities,
    hosts: [host],
    sandbox: true,
  });
  await mock.ctx.settings.setHost(5, "enableAdb", true);
  await mock.ctx.settings.setHost(5, "adbPort", device.port);
  await activate(mock.ctx);
  mock.setActor("user-1");
  const route = mock.wsRoutes.find((r) => r.path === "/files");
  if (!route?.handler) throw new Error("no /files route");
  const socket = new FakeSocket();
  void route.handler({
    userId: "user-1",
    request: { url: "/plugin-ws/adb/files?hostId=5" },
    socket,
    clientIp: "127.0.0.1",
    requestOrigin: "http://localhost",
    isDataUnlocked: () => true,
  } as never);
  await until(
    () => socket.json.some((m) => m.type === "phase" && m.phase === "ready"),
    8000,
  );
  return socket;
}

describe("/files route", () => {
  it("lists, downloads, uploads, renames and deletes", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/a.txt": "hello",
      "/sdcard/Docs": null,
    });
    devices.push(device);
    const socket = await openFiles(device);

    socket.request({ id: 1, op: "list", path: "/sdcard" });
    await until(() => socket.reply(1) !== undefined);
    const listed = socket.reply(1) as {
      entries: { name: string; dir: boolean }[];
    };
    expect(listed.entries.map((e) => e.name).sort()).toEqual(["Docs", "a.txt"]);

    socket.request({ id: 2, op: "downloadTicket", paths: ["/sdcard/a.txt"] });
    await until(() => socket.reply(2) !== undefined);
    const ticket = socket.reply(2) as {
      ticket: string;
      name: string;
      size: number;
    };
    expect(ticket).toMatchObject({ name: "a.txt", size: 5 });
    const file = await download(ticket.ticket);
    expect(file.data.toString()).toBe("hello");
    expect(file.headers["content-length"]).toBe(5);
    expect(String(file.headers["content-disposition"])).toContain("a.txt");
    // A ticket works once.
    expect((await download(ticket.ticket)).statusCode).toBe(404);
    expect((await download("made-up")).statusCode).toBe(404);

    socket.request({ id: 3, op: "upload", path: "/sdcard/new.bin", size: 6 });
    await until(() =>
      socket.json.some((m) => m.id === 3 && m.type === "ready"),
    );
    socket.frame(3, Buffer.from("abc"));
    socket.frame(3, Buffer.from("def"));
    socket.request({ id: 3, op: "uploadEnd" });
    await until(() => socket.json.some((m) => m.id === 3 && m.ok === true));
    expect(device.files.get("/sdcard/new.bin")?.data?.toString()).toBe(
      "abcdef",
    );

    socket.request({
      id: 4,
      op: "rename",
      from: "/sdcard/new.bin",
      to: "/sdcard/Docs/n.bin",
    });
    await until(() => socket.reply(4) !== undefined);
    expect(device.files.has("/sdcard/Docs/n.bin")).toBe(true);

    socket.request({ id: 5, op: "delete", paths: ["/sdcard/Docs"] });
    await until(() => socket.reply(5) !== undefined);
    expect(device.files.has("/sdcard/Docs")).toBe(false);

    socket.request({ id: 6, op: "delete", paths: ["/sdcard"] });
    await until(() => socket.reply(6) !== undefined);
    expect(socket.reply(6)).toMatchObject({ ok: false });
    expect(device.files.has("/sdcard")).toBe(true);

    socket.request({ id: 7, op: "downloadTicket", paths: ["/sdcard/none"] });
    await until(() => socket.reply(7) !== undefined);
    expect(socket.reply(7)).toMatchObject({ ok: false });
    socket.close();
  });

  it("opens, saves and chmods a text file, refuses binary", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/n.txt": "héllo\nworld",
    });
    device.files.set("/sdcard/b.bin", {
      dir: false,
      data: Buffer.from([1, 0, 2]),
      mtime: 1,
    });
    devices.push(device);
    const socket = await openFiles(device);

    socket.request({ id: 1, op: "read", path: "/sdcard/n.txt" });
    await until(() => socket.reply(1) !== undefined);
    expect(socket.reply(1)).toMatchObject({
      ok: true,
      content: "héllo\nworld",
      mode: 0o644,
    });

    socket.request({
      id: 2,
      op: "write",
      path: "/sdcard/n.txt",
      content: "änderung\n",
    });
    await until(() => socket.reply(2) !== undefined);
    expect(socket.reply(2)).toMatchObject({ ok: true });
    expect(device.files.get("/sdcard/n.txt")?.data?.toString()).toBe(
      "änderung\n",
    );

    socket.request({ id: 3, op: "chmod", path: "/sdcard/n.txt", mode: "600" });
    await until(() => socket.reply(3) !== undefined);
    expect(socket.reply(3)).toMatchObject({ ok: true });
    expect(device.commands.some((c) => c.startsWith("chmod 600 "))).toBe(true);

    socket.request({
      id: 4,
      op: "chmod",
      path: "/sdcard/n.txt",
      mode: "9; ls",
    });
    await until(() => socket.reply(4) !== undefined);
    expect(socket.reply(4)).toMatchObject({ ok: false });

    socket.request({
      id: 8,
      op: "chmod",
      paths: ["/sdcard/n.txt", "/sdcard/b.bin"],
      mode: "755",
      recursive: true,
    });
    await until(() => socket.reply(8) !== undefined);
    expect(
      device.commands.some((c) => /^chmod -R 755 '?\/sdcard\/n\.txt/.test(c)),
    ).toBe(true);

    socket.request({ id: 5, op: "read", path: "/sdcard/b.bin" });
    await until(() => socket.reply(5) !== undefined);
    expect(socket.reply(5)).toMatchObject({ ok: false });
    socket.close();
  });

  it("downloads a folder as a zip", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/Docs": null,
      "/sdcard/Docs/one.txt": "first",
      "/sdcard/Docs/Sub": null,
      "/sdcard/Docs/Sub/two.txt": "second",
    });
    devices.push(device);
    const socket = await openFiles(device);
    socket.request({ id: 1, op: "downloadTicket", paths: ["/sdcard/Docs"] });
    await until(() => socket.reply(1) !== undefined);
    const ticket = socket.reply(1) as { ticket: string; name: string };
    expect(ticket.name).toBe("Docs.zip");
    const archive = await download(ticket.ticket);
    expect(archive.headers["content-type"]).toBe("application/zip");
    const files = readStoredZip(archive.data);
    expect([...files.keys()].sort()).toEqual([
      "Docs/",
      "Docs/Sub/",
      "Docs/Sub/two.txt",
      "Docs/one.txt",
    ]);
    expect(files.get("Docs/Sub/two.txt")?.toString()).toBe("second");
    expect(files.get("Docs/one.txt")?.toString()).toBe("first");
    socket.close();
  });
});
