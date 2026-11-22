import { FolderSearch, Power, Smartphone } from "lucide-react";
import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { AdbTab } from "./AdbTab";
import { FilesTab } from "./FilesTab";
import { HostAdbSection } from "./HostAdbSection";
import { adbApp, setAdbApp } from "./app";
import { rebootDevice, type RebootMode } from "./power";

const PLUGIN_ID = "adb";
const DEFAULT_PORT = 5555;

type SettingsBag = Record<string, Record<string, unknown> | undefined>;

function adbEnabled(host: PluginHostRecord | null | undefined): boolean {
  const bag = (host as { pluginSettings?: SettingsBag } | null | undefined)
    ?.pluginSettings;
  return bag?.[PLUGIN_ID]?.enableAdb === true;
}

export function activate(app: TermixApp): void {
  setAdbApp(app);
  app.onDispose(() => setAdbApp(null));
  // Shared and guest pages have no shell to offer.
  if (app.guest) return;

  app.registerHostProtocol({
    id: PLUGIN_ID,
    settingKey: "enableAdb",
    portKey: "adbPort",
    defaultPort: DEFAULT_PORT,
    titleKey: "hosts.tabAdb",
    descriptionKey: "hosts.adbDescription",
    icon: Smartphone,
    order: 125,
  });

  app.registerHostEditorSection({
    id: PLUGIN_ID,
    group: "top",
    titleKey: "hosts.tabAdb",
    icon: Smartphone,
    order: 25,
    visible: (protocols) => !!protocols.enableAdb,
    // Without this the tab waits behind the editor's Advanced switch.
    ...{ simple: true },
    component: HostAdbSection,
  });

  app.registerHostAction({
    id: PLUGIN_ID,
    titleKey: "hosts.tabAdb",
    icon: Smartphone,
    kind: "connect",
    priority: 25,
    order: 125,
    tabType: PLUGIN_ID,
    when: adbEnabled,
  });

  app.registerHostAction({
    id: "adb-files",
    titleKey: "files.title",
    icon: FolderSearch,
    kind: "open",
    order: 126,
    tabType: "adb-files",
    when: adbEnabled,
  });

  // The picker is the host row's own; each choice asks again before it acts.
  const powerItem = (mode: RebootMode) => ({
    id: mode,
    label: adbApp().t(`power.${mode}`),
    run: (host: PluginHostRecord) => {
      const a = adbApp();
      void (async () => {
        const ok = await a.confirm({
          title: a.t(`power.ask.${mode}`),
          description: a.t("power.confirm"),
          confirmLabel: a.t("power.go"),
          destructive: true,
        });
        if (!ok) return;
        // No toast outside a component, so the outcome is a plain notice.
        let notice = a.t("power.sent");
        try {
          await rebootDevice(String(host.id), mode);
        } catch (error) {
          notice = error instanceof Error ? error.message : String(error);
        }
        await a.confirm({
          title: notice,
          confirmLabel: "OK",
          cancelLabel: a.t("files.close"),
          destructive: false,
        });
      })();
    },
  });

  app.registerHostAction({
    id: "adb-power",
    titleKey: "power.title",
    icon: Power,
    kind: "open",
    order: 127,
    when: adbEnabled,
    items: () =>
      (["system", "recovery", "bootloader", "poweroff"] as RebootMode[]).map(
        powerItem,
      ),
  });

  app.registerPaletteEntry({
    id: "adb.files",
    titleKey: "palette.openAdbFiles",
    icon: FolderSearch,
    keywords: ["adb", "android", "files"],
    scope: "host",
    when: (host) => !!host && adbEnabled(host),
    run: (shell, host) => {
      if (host) shell.openTab(host, "adb-files");
    },
  });

  app.registerPaletteEntry({
    id: "adb.connect",
    titleKey: "palette.connectAdb",
    icon: Smartphone,
    keywords: ["adb", "android"],
    scope: "host",
    when: (host) => !!host && adbEnabled(host),
    run: (shell, host) => {
      if (host) shell.openTab(host, PLUGIN_ID);
    },
  });

  app.registerTab(PLUGIN_ID, AdbTab, {
    icon: Smartphone,
    titleKey: "hosts.tabAdb",
    requiresHost: true,
    noHostMessageKey: "adb.noHostSelected",
    persistent: true,
    session: true,
    commandTarget: false,
    ownBackground: true,
    restore: adbEnabled,
    activityTypes: [PLUGIN_ID],
  });

  app.registerTab("adb-files", FilesTab, {
    icon: FolderSearch,
    titleKey: "files.title",
    requiresHost: true,
    noHostMessageKey: "adb.noHostSelected",
    persistent: true,
    session: true,
    commandTarget: false,
    restore: adbEnabled,
  });
}
