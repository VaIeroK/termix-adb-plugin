import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json" with { type: "json" };
import {
  parseInfo,
  parseSearch,
  searchPattern,
} from "../../src/backend/files-route.js";
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

let lastMock: ReturnType<typeof createMockCtx> | null = null;

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
  lastMock = mock;
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

  it("remembers a host that connected, for the new port offer", async () => {
    const device = await startFilesDevice({ "/sdcard": null });
    devices.push(device);
    const socket = await openFiles(device);
    let flag: unknown;
    for (let i = 0; i < 50 && flag !== true; i += 1) {
      flag = await lastMock?.ctx.settings.getHost(5, "adbPaired");
      if (flag !== true) await new Promise((r) => setTimeout(r, 20));
    }
    expect(flag).toBe(true);
    socket.close();
  });

  it("searches names below a folder", async () => {
    expect(searchPattern("a*b[1]")).toBe("*a\\*b\\[1\\]*");
    expect(
      parseSearch("regular file|644|5|1700000000|/sdcard/x|y.txt\n", "/sdcard"),
    ).toEqual([
      {
        name: "x|y.txt",
        mode: 0o644,
        size: 5,
        mtime: 1700000000,
        dir: false,
        link: false,
      },
    ]);

    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/Docs": null,
      "/sdcard/Docs/Report.txt": "r",
      "/sdcard/photo.jpg": "p",
    });
    devices.push(device);
    const socket = await openFiles(device);
    socket.request({ id: 1, op: "search", path: "/sdcard", query: "REPORT" });
    await until(() => socket.reply(1) !== undefined);
    const reply = socket.reply(1) as {
      ok: boolean;
      entries: { name: string }[];
    };
    expect(reply.ok).toBe(true);
    expect(reply.entries.map((e) => e.name)).toEqual(["Docs/Report.txt"]);
    socket.request({ id: 2, op: "search", path: "/sdcard", query: "  " });
    await until(() => socket.reply(2) !== undefined);
    expect(socket.reply(2)).toMatchObject({ ok: false });
    socket.close();
  });

  it("parses the device info lines", () => {
    expect(
      parseInfo(
        "brand=Xiaomi\nmodel=23127PN0CG\nandroid=15\nsdk=35\npresent=1\nbattery=80\n" +
          "df=/dev/fuse 250000000 100000000 150000000 40% /storage/emulated\n",
      ),
    ).toMatchObject({
      brand: "Xiaomi",
      sdk: 35,
      battery: 80,
      totalBytes: 250000000 * 1024,
      freeBytes: 150000000 * 1024,
    });
    expect(parseInfo("present=0\nbattery=0")).toMatchObject({ battery: null });
    expect(parseInfo("junk")).toMatchObject({ model: null, battery: null });
  });

  it("installs APKs, reboots, copies and refuses to overwrite", async () => {
    const device = await startFilesDevice({
      "/sdcard": null,
      "/sdcard/a.apk": "x",
      "/sdcard/bad.apk": "x",
      "/sdcard/n.txt": "text",
      "/sdcard/Docs": null,
    });
    devices.push(device);
    const socket = await openFiles(device);
    const ask = async (id: number, payload: Record<string, unknown>) => {
      socket.request({ id, ...payload });
      await until(() => socket.reply(id) !== undefined);
      return socket.reply(id);
    };

    expect(
      await ask(1, { op: "install", path: "/sdcard/a.apk" }),
    ).toMatchObject({ ok: true });
    expect(
      await ask(2, { op: "install", path: "/sdcard/bad.apk" }),
    ).toMatchObject({ ok: false });
    expect(
      await ask(3, { op: "install", path: "/sdcard/n.txt" }),
    ).toMatchObject({ ok: false });

    expect(await ask(4, { op: "reboot", mode: "recovery" })).toMatchObject({
      ok: true,
    });
    expect(device.commands).toContain("reboot recovery");
    expect(await ask(5, { op: "reboot", mode: "format; rm" })).toMatchObject({
      ok: false,
    });

    expect(
      await ask(6, {
        op: "copy",
        from: "/sdcard/n.txt",
        to: "/sdcard/Docs/n.txt",
      }),
    ).toMatchObject({ ok: true });
    expect(device.files.has("/sdcard/Docs/n.txt")).toBe(true);
    expect(
      await ask(7, {
        op: "copy",
        from: "/sdcard/n.txt",
        to: "/sdcard/Docs/n.txt",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await ask(8, {
        op: "rename",
        from: "/sdcard/Docs",
        to: "/sdcard/Docs/in",
      }),
    ).toMatchObject({ ok: false });
    expect(device.files.has("/sdcard/Docs")).toBe(true);
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
