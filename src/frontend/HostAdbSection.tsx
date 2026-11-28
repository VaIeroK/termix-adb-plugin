import type { HostEditorSectionProps } from "@termix-ssh/plugin-sdk/frontend";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Input, SectionCard, SwitchRow } from "@termix-ssh/plugin-sdk/ui";
import { Smartphone } from "lucide-react";

const PLUGIN_ID = "adb";
const DEFAULT_PORT = 5555;

type Bag = Record<string, Record<string, unknown> | undefined>;

/** The ADB port, in the host editor's own tab so it shows without Advanced. */
export function HostAdbSection({ form, setField }: HostEditorSectionProps) {
  const { t } = useTranslation();
  const bag = (form?.pluginSettings as Bag | undefined) ?? {};
  const port = Number(bag[PLUGIN_ID]?.adbPort);

  const setOwn = (key: string, value: unknown) => {
    setField("pluginSettings", {
      ...bag,
      [PLUGIN_ID]: { ...(bag[PLUGIN_ID] ?? {}), [key]: value },
    });
  };
  const setPort = (value: string) =>
    setOwn("adbPort", value === "" ? DEFAULT_PORT : Number(value));

  return (
    <SectionCard
      title={t("hosts.tabAdb")}
      icon={<Smartphone className="size-3.5" />}
    >
      <div className="flex flex-col gap-1.5 py-3">
        <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {t("settings.host.adbPort.label")}
        </label>
        <Input
          type="number"
          min={1}
          max={65535}
          placeholder={String(DEFAULT_PORT)}
          value={Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT}
          onChange={(event) => setPort(event.target.value)}
          className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.host.adbPort.description")}
        </p>
      </div>
      <SwitchRow
        label={t("settings.host.adbFiles.label")}
        description={t("settings.host.adbFiles.description")}
        checked={bag[PLUGIN_ID]?.adbFiles !== false}
        onChange={(value) => setOwn("adbFiles", value)}
      />
      <SwitchRow
        label={t("settings.host.adbPower.label")}
        description={t("settings.host.adbPower.description")}
        checked={bag[PLUGIN_ID]?.adbPower !== false}
        onChange={(value) => setOwn("adbPower", value)}
      />
    </SectionCard>
  );
}
