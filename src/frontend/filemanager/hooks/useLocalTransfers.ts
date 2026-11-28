/** The local pane transfers are not part of the ADB file manager. */
export function useLocalTransfers(_options: Record<string, unknown>) {
  return {
    uploadLocalPaths: async (..._args: unknown[]) => undefined,
    downloadRemoteItems: async (..._args: unknown[]) => undefined,
  };
}
