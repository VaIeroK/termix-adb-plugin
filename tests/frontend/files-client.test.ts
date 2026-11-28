import { describe, expect, it } from "vitest";
import { FilesClient } from "../../src/frontend/files-client";
import {
  formatSize,
  joinPath,
  parentPath,
  sortItems,
} from "../../src/frontend/files-utils";

class FakeSocket {
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  json(index: number) {
    return JSON.parse(String(this.sent[index])) as Record<string, unknown>;
  }
}

function frame(id: number, text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out.buffer;
}

describe("path helpers", () => {
  it("joins, goes up and formats", () => {
    expect(joinPath("/sdcard/", "a")).toBe("/sdcard/a");
    expect(parentPath("/sdcard/a")).toBe("/sdcard");
    expect(parentPath("/sdcard")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(formatSize(5)).toBe("5 B");
    expect(formatSize(1536)).toBe("1.5 KB");
  });
  it("sorts folders first", () => {
    const item = (name: string, dir: boolean) =>
      ({ name, dir, size: 0, mtime: 0, mode: 0, link: false }) as never;
    expect(
      sortItems([item("b", false), item("A", true), item("a", false)]).map(
        (i) => i.name,
      ),
    ).toEqual(["A", "a", "b"]);
  });
});

describe("FilesClient", () => {
  it("matches replies to requests", async () => {
    const socket = new FakeSocket();
    const client = new FilesClient(socket as never);
    const pending = client.call("list", { path: "/sdcard" });
    const request = socket.json(0);
    expect(request).toMatchObject({ op: "list", path: "/sdcard" });
    client.dispatch(JSON.stringify({ id: request.id, ok: true, entries: [] }));
    await expect(pending).resolves.toMatchObject({ ok: true });

    const failing = client.call("delete", { paths: ["/x"] });
    client.dispatch(
      JSON.stringify({ id: socket.json(1).id, ok: false, error: "nope" }),
    );
    await expect(failing).rejects.toThrow("nope");
  });

  it("checks existence, properties and folder size", async () => {
    const socket = new FakeSocket();
    const client = new FilesClient(socket as never);
    const reply = (index: number, body: Record<string, unknown>) =>
      client.dispatch(
        JSON.stringify({ id: socket.json(index).id, ok: true, ...body }),
      );
    const exists = client.exists("/sdcard/a");
    reply(0, { entry: { name: "a" } });
    await expect(exists).resolves.toBe(true);
    const missing = client.exists("/sdcard/b");
    reply(1, { entry: null });
    await expect(missing).resolves.toBe(false);
    const props = client.properties("/sdcard/a");
    reply(2, { properties: { path: "/sdcard/a", owner: "u0_a1" } });
    await expect(props).resolves.toMatchObject({ owner: "u0_a1" });
    const size = client.dirSize("/sdcard");
    reply(3, { bytes: 2048 });
    await expect(size).resolves.toBe(2048);
  });

  it("asks for a download ticket", async () => {
    const socket = new FakeSocket();
    const client = new FilesClient(socket as never);
    const pending = client.downloadTicket(["/sdcard/DCIM"]);
    const request = socket.json(0);
    expect(request).toMatchObject({
      op: "downloadTicket",
      paths: ["/sdcard/DCIM"],
    });
    client.dispatch(
      JSON.stringify({
        id: request.id,
        ok: true,
        ticket: "abc",
        name: "DCIM.zip",
        size: null,
      }),
    );
    await expect(pending).resolves.toMatchObject({
      ticket: "abc",
      name: "DCIM.zip",
    });
  });

  it("uploads after the device is ready and waits for the verdict", async () => {
    const socket = new FakeSocket();
    const client = new FilesClient(socket as never);
    const file = new File(["abcdef"], "a.bin");
    const { id, result } = client.upload(
      "/sdcard/a.bin",
      file,
      () => undefined,
    );
    expect(socket.json(0)).toMatchObject({ op: "upload", size: 6 });
    client.dispatch(JSON.stringify({ id, type: "ready" }));
    await new Promise((r) => setTimeout(r, 20));
    const sentFrame = socket.sent[1] as Uint8Array;
    expect(new DataView(sentFrame.buffer).getUint32(0)).toBe(id);
    expect(new TextDecoder().decode(sentFrame.subarray(4))).toBe("abcdef");
    client.dispatch(JSON.stringify({ id, type: "ack", bytes: 6 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(socket.json(2)).toMatchObject({ op: "uploadEnd" });
    client.dispatch(JSON.stringify({ id, ok: true }));
    await expect(result).resolves.toBeUndefined();
  });

  it("fails an upload the device refuses", async () => {
    const socket = new FakeSocket();
    const client = new FilesClient(socket as never);
    const { id, result } = client.upload(
      "/sdcard/a.bin",
      new File(["x"], "a.bin"),
      () => undefined,
    );
    client.dispatch(
      JSON.stringify({ id, ok: false, error: "Permission denied" }),
    );
    await expect(result).rejects.toThrow("Permission denied");
  });
});
