import type { FileItem, SSHHost } from "../host-types";

/** Dragging to the desktop needs the Termix desktop app; not offered for ADB. */
export function useDragToDesktop(_options: {
  sshSessionId: string;
  sshHost: SSHHost;
}) {
  return {
    dragFileToDesktop: async (_file: FileItem) => undefined,
    dragFilesToDesktop: async (_files: FileItem[]) => undefined,
  };
}
