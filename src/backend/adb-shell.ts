import {
  SHELL_EXIT,
  SHELL_STDERR,
  SHELL_STDIN,
  SHELL_STDOUT,
  SHELL_WINDOW_SIZE,
  parseShellPackets,
  shellPacket,
} from "./adb-codec.js";
import {
  connectAdb,
  type AdbConnectOptions,
  type AdbPhase,
} from "./adb-connection.js";

export interface AdbShellHandlers {
  /** Terminal output. stderr arrives here too, like on a real terminal. */
  onData: (chunk: Buffer) => void;
  onPhase?: (phase: AdbPhase) => void;
  /** The session is over. exitCode is set when the shell exited by itself. */
  onClose: (info: { exitCode?: number; error?: string }) => void;
}

export interface AdbShellOptions extends Omit<AdbConnectOptions, "onPhase"> {
  cols: number;
  rows: number;
  term?: string;
}

export interface AdbShell {
  write: (data: Buffer | string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

/**
 * Connects, authenticates and opens an interactive shell. Resolves once the
 * shell is open; the handlers carry everything after that.
 */
export async function openAdbShell(
  options: AdbShellOptions,
  handlers: AdbShellHandlers,
): Promise<AdbShell> {
  const term = (options.term ?? "xterm-256color").replace(/[^\w.-]/g, "");
  const connection = await connectAdb({
    ...options,
    onPhase: handlers.onPhase,
  });
  const useV2 = connection.features.includes("shell_v2");
  const service = useV2 ? `shell,v2,TERM=${term},pty:` : "shell:";

  let stream;
  try {
    stream = await connection.open(service, options.connectTimeoutMs ?? 10_000);
  } catch (error) {
    connection.close();
    throw error;
  }

  let shellBuffer: Buffer = Buffer.alloc(0);
  let exitCode: number | undefined;
  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    connection.close();
    handlers.onClose({ exitCode, error });
  };

  stream.setHandlers({
    onData: (data) => {
      if (!useV2) {
        handlers.onData(data);
        return;
      }
      shellBuffer = Buffer.concat([shellBuffer, data]);
      const { packets, rest } = parseShellPackets(shellBuffer);
      shellBuffer = rest;
      for (const packet of packets) {
        if (packet.id === SHELL_STDOUT || packet.id === SHELL_STDERR) {
          handlers.onData(packet.data);
        } else if (packet.id === SHELL_EXIT && packet.data.length) {
          exitCode = packet.data[0];
        }
      }
    },
    onClose: (error) => finish(error),
  });
  connection.onClose((error) => finish(error));

  const send = (data: Buffer) => {
    if (finished) return;
    stream.write(data).catch(() => undefined);
  };

  const shell: AdbShell = {
    write(data) {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      // Leave room for the shell_v2 header inside one payload.
      const room = Math.max(1, connection.maxData - 5);
      for (let offset = 0; offset < bytes.length; offset += room) {
        const part = bytes.subarray(offset, offset + room);
        send(useV2 ? shellPacket(SHELL_STDIN, part) : Buffer.from(part));
      }
    },
    resize(cols, rows) {
      if (!useV2) return;
      const c = Math.max(1, Math.min(500, Math.floor(cols)));
      const r = Math.max(1, Math.min(200, Math.floor(rows)));
      send(shellPacket(SHELL_WINDOW_SIZE, Buffer.from(`${r}x${c},0x0`)));
    },
    close() {
      finish();
    },
  };

  handlers.onPhase?.("ready");
  if (useV2) shell.resize(options.cols, options.rows);
  return shell;
}
