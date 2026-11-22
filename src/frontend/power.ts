import { filesSocketUrl } from "./app";
import { FilesClient } from "./files-client";

export type RebootMode = "system" | "recovery" | "bootloader" | "poweroff";

/** Connects to the phone and sends one reboot (or power off) command. */
export function rebootDevice(hostId: string, mode: RebootMode): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const target = await filesSocketUrl(hostId);
      if (!target) {
        reject(new Error("Not available"));
        return;
      }
      const socket = new WebSocket(target.url, target.protocols);
      const client = new FilesClient(socket);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.close();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("The device did not answer in time")),
        30_000,
      );
      socket.onmessage = (event) => {
        const message = client.dispatch(event.data);
        if (!message) return;
        if (message.type === "phase" && message.phase === "ready") {
          client
            .call("reboot", { mode })
            .then(() => {
              clearTimeout(timer);
              finish();
            })
            .catch((error) => {
              clearTimeout(timer);
              finish(error instanceof Error ? error : new Error(String(error)));
            });
        } else if (message.type === "error") {
          clearTimeout(timer);
          finish(new Error(message.message || "Connection failed"));
        }
      };
      socket.onclose = () =>
        finish(new Error("The connection closed before the command was sent"));
    })();
  });
}
