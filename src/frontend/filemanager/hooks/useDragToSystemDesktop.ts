import type { FileItem, SSHHost } from "../host-types";

/** Not offered for ADB: downloads go through the download button. */
export function useDragToSystemDesktop(_options: {
  sshSessionId: string;
  sshHost: SSHHost;
}) {
  return {
    isFileSystemAPISupported: false,
    handleDragToSystem: async (_files: FileItem[], _options?: unknown) =>
      undefined,
    startDragToSystem: (_files: FileItem[], _options?: unknown) => undefined,
    handleDragEnd: (_event: unknown) => undefined,
    cancelDragToSystem: () => undefined,
  };
}
