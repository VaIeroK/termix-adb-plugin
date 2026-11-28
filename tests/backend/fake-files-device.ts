import net from "node:net";
import {
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_WRTE,
  SHELL_EXIT,
  SHELL_STDOUT,
  encodeMessage,
  parseMessages,
  shellPacket,
  type AdbMessage,
} from "../../src/backend/adb-protocol.js";

export interface FakeNode {
  dir: boolean;
  data?: Buffer;
  mtime: number;
}

export interface FakeFilesDevice {
  port: number;
  files: Map<string, FakeNode>;
  commands: string[];
  close: () => Promise<void>;
}

const S_DIR = 0o040000;
const S_REG = 0o100000;

function parentOf(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/** An adbd with an in-memory file system, the sync service and a few commands. */
export async function startFilesDevice(
  initial: Record<string, string | null> = {},
): Promise<FakeFilesDevice> {
  const device: FakeFilesDevice = {
    port: 0,
    files: new Map([["/", { dir: true, mtime: 1 }]]),
    commands: [],
    close: async () => {},
  };
  for (const [path, content] of Object.entries(initial)) {
    device.files.set(
      path,
      content === null
        ? { dir: true, mtime: 1_700_000_000 }
        : { dir: false, data: Buffer.from(content), mtime: 1_700_000_000 },
    );
  }
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    const send = (c: number, a0: number, a1: number, d?: Buffer) =>
      socket.write(encodeMessage(c, a0, a1, d));

    interface StreamState {
      remote: number;
      kind: "sync" | "shell";
      input: Buffer;
      push?: { path: string; chunks: Buffer[] };
    }
    const streams = new Map<number, StreamState>();
    let nextLocal = 100;
    const reply = (state: StreamState, local: number, data: Buffer) =>
      send(A_WRTE, local, state.remote, data);

    const framed = (tag: string, a: number | Buffer = 0) => {
      const head = Buffer.alloc(8);
      head.write(tag, 0, "ascii");
      if (Buffer.isBuffer(a)) {
        head.writeUInt32LE(a.length, 4);
        return Buffer.concat([head, a]);
      }
      head.writeUInt32LE(a, 4);
      return head;
    };

    const node = (path: string) =>
      device.files.get(path.replace(/\/$/, "") || "/");

    const dnt2 = (name: string, n: FakeNode) => {
      const body = Buffer.alloc(72);
      body.writeUInt32LE(n.dir ? S_DIR | 0o755 : S_REG | 0o644, 20);
      body.writeBigUInt64LE(BigInt(n.data?.length ?? 0), 36);
      body.writeBigInt64LE(BigInt(n.mtime), 52);
      body.writeUInt32LE(Buffer.byteLength(name), 68);
      return Buffer.concat([Buffer.from("DNT2"), body, Buffer.from(name)]);
    };

    const syncStep = (local: number, state: StreamState) => {
      for (;;) {
        const input = state.input;
        if (state.push) {
          if (input.length < 8) return;
          const tag = input.toString("ascii", 0, 4);
          const value = input.readUInt32LE(4);
          if (tag === "DATA") {
            if (input.length < 8 + value) return;
            state.push.chunks.push(Buffer.from(input.subarray(8, 8 + value)));
            state.input = input.subarray(8 + value);
          } else if (tag === "DONE") {
            const { path, chunks } = state.push;
            device.files.set(path, {
              dir: false,
              data: Buffer.concat(chunks),
              mtime: value,
            });
            state.push = undefined;
            state.input = input.subarray(8);
            reply(state, local, framed("OKAY"));
          } else {
            return;
          }
          continue;
        }
        if (input.length < 8) return;
        const tag = input.toString("ascii", 0, 4);
        const length = input.readUInt32LE(4);
        if (input.length < 8 + length) return;
        const arg = input.subarray(8, 8 + length).toString("utf8");
        state.input = input.subarray(8 + length);

        if (tag === "LIS2") {
          const dir = arg.replace(/\/$/, "") || "/";
          const found = device.files.get(dir);
          if (!found?.dir) {
            reply(
              state,
              local,
              framed("FAIL", Buffer.from("No such directory")),
            );
            continue;
          }
          for (const [path, n] of device.files) {
            if (path !== "/" && parentOf(path) === dir) {
              reply(
                state,
                local,
                dnt2(path.slice(path.lastIndexOf("/") + 1), n),
              );
            }
          }
          reply(
            state,
            local,
            Buffer.concat([Buffer.from("DONE"), Buffer.alloc(72)]),
          );
        } else if (tag === "STA2") {
          const n = node(arg);
          const body = Buffer.alloc(68);
          if (!n) body.writeUInt32LE(2, 0);
          else {
            body.writeUInt32LE(n.dir ? S_DIR | 0o755 : S_REG | 0o644, 20);
            body.writeBigUInt64LE(BigInt(n.data?.length ?? 0), 36);
            body.writeBigInt64LE(BigInt(n.mtime), 52);
          }
          reply(state, local, Buffer.concat([Buffer.from("STA2"), body]));
        } else if (tag === "RECV") {
          const n = node(arg);
          if (!n || n.dir) {
            reply(state, local, framed("FAIL", Buffer.from("open failed")));
            continue;
          }
          const data = n.data ?? Buffer.alloc(0);
          for (let o = 0; o < data.length; o += 65536) {
            reply(state, local, framed("DATA", data.subarray(o, o + 65536)));
          }
          reply(state, local, framed("DONE"));
        } else if (tag === "SEND") {
          const path = arg.slice(0, arg.lastIndexOf(","));
          state.push = { path, chunks: [] };
        }
      }
    };

    const shellRun = (local: number, state: StreamState, command: string) => {
      device.commands.push(command);
      const words = [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(
        (m) => (m[1] ?? m[2]).replace(/'\\''/g, "'"),
      );
      let output = "";
      let code = 0;
      const [bin, ...args] = words;
      const paths = args.filter((a) => a.startsWith("/"));
      if (bin === "rm") {
        for (const p of paths) {
          for (const key of [...device.files.keys()]) {
            if (key === p || key.startsWith(`${p}/`)) device.files.delete(key);
          }
        }
      } else if (bin === "mv" && paths.length === 2) {
        const [from, to] = paths;
        if (!device.files.has(from)) {
          output = `mv: ${from}: No such file or directory`;
          code = 1;
        } else {
          for (const key of [...device.files.keys()]) {
            if (key === from || key.startsWith(`${from}/`)) {
              device.files.set(
                to + key.slice(from.length),
                device.files.get(key)!,
              );
              device.files.delete(key);
            }
          }
        }
      } else if (bin === "pm") {
        output = paths[0]?.includes("bad")
          ? "Failure [INSTALL_FAILED_INVALID_APK]"
          : "Success";
      } else if (bin === "tar" || bin === "unzip") {
        // Only the command is checked; the archive gets a placeholder body.
        if (args.includes("-czf")) {
          device.files.set(paths[0], {
            dir: false,
            data: Buffer.from("tar"),
            mtime: 1_700_000_000,
          });
        }
      } else if (bin === "reboot") {
        // Nothing comes back from a device that is going down.
      } else if (bin === "cp" && paths.length === 2) {
        for (const key of [...device.files.keys()]) {
          if (key === paths[0] || key.startsWith(`${paths[0]}/`)) {
            device.files.set(
              paths[1] + key.slice(paths[0].length),
              device.files.get(key)!,
            );
          }
        }
      } else if (bin === "stat") {
        const file = device.files.get(paths[0]);
        output = file
          ? [
              file.dir ? "directory" : "regular file",
              "644",
              "u0_a1",
              "media_rw",
              file.data?.length ?? 0,
              file.mtime,
              args.join(" ").includes("%C") ? "u:object_r:fuse:s0" : "",
              paths[0],
            ].join("|")
          : "stat: no such file";
        if (!file) code = 1;
      } else if (bin === "du") {
        output = `12\t${paths[0]}`;
      } else if (bin === "find") {
        const term = (args[args.indexOf("-iname") + 1] ?? "")
          .replace(/\\(.)/g, "$1")
          .replace(/^\*|\*$/g, "")
          .toLowerCase();
        output = [...device.files.entries()]
          .filter(
            ([key]) =>
              key.startsWith(`${paths[0]}/`) &&
              key
                .slice(key.lastIndexOf("/") + 1)
                .toLowerCase()
                .includes(term),
          )
          .map(([key, file]) =>
            [
              file.dir ? "directory" : "regular file",
              "644",
              file.data?.length ?? 0,
              file.mtime,
              key,
            ].join("|"),
          )
          .join("\n");
      } else if (bin === "chmod") {
        // Recorded in `commands`; the fake keeps no permission bits.
      } else if (bin === "mkdir") {
        device.files.set(paths[0], { dir: true, mtime: 1_700_000_000 });
      } else {
        output = `sh: ${bin}: not found`;
        code = 127;
      }
      if (output)
        reply(state, local, shellPacket(SHELL_STDOUT, Buffer.from(output)));
      reply(state, local, shellPacket(SHELL_EXIT, Buffer.from([code])));
      send(A_CLSE, local, state.remote);
      streams.delete(local);
    };

    const onMessage = (m: AdbMessage) => {
      if (m.command === A_CNXN) {
        send(
          A_CNXN,
          0x01000001,
          65536,
          Buffer.from(
            "device::ro.product.model=Files;features=shell_v2,ls_v2,stat_v2,cmd\0",
          ),
        );
      } else if (m.command === A_OPEN) {
        const service = m.data.toString("utf8").replace(/\0$/, "");
        const local = nextLocal++;
        const state: StreamState = {
          remote: m.arg0,
          kind: service === "sync:" ? "sync" : "shell",
          input: Buffer.alloc(0),
        };
        streams.set(local, state);
        send(A_OKAY, local, m.arg0);
        if (state.kind === "shell") {
          shellRun(local, state, service.replace(/^shell,v2,raw:/, ""));
        }
      } else if (m.command === A_WRTE) {
        const state = streams.get(m.arg1);
        send(A_OKAY, m.arg1, m.arg0);
        if (state?.kind === "sync") {
          state.input = Buffer.concat([state.input, m.data]);
          syncStep(m.arg1, state);
        }
      } else if (m.command === A_CLSE) {
        if (streams.delete(m.arg1)) send(A_CLSE, m.arg1, m.arg0);
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
