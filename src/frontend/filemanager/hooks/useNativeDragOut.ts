import type { FileItem } from "../host-types";

/** Native drag-out is a desktop app feature; not offered for ADB. */
export function useNativeDragOut(_sessionId: string) {
  return {
    start: (_files: FileItem[]) => false,
    cleanup: () => undefined,
    prefetch: (_files: FileItem[]) => undefined,
  };
}
