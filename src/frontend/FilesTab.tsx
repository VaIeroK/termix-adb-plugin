import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { FileManager } from "./filemanager/FileManager";

/** The Termix file manager, working against the device's /files socket. */
export function FilesTab({ tab, host, sshHost, isVisible, shell }: TabProps) {
  const data = tab.data as
    { initialFilePath?: string; initialPath?: string } | undefined;
  return (
    <FileManager
      initialHost={(sshHost ?? host) as never}
      initialFilePath={data?.initialFilePath}
      initialPath={data?.initialPath}
      isVisible={isVisible}
      onOpenTerminalTab={
        host
          ? (path) =>
              shell.openTab(host, "adb", {
                forceNewTab: true,
                data: { cwd: path },
              })
          : undefined
      }
    />
  );
}
