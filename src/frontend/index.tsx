import { Smartphone } from "lucide-react";
import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { AdbTab } from "./AdbTab";
import { setAdbApp } from "./app";

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
}
