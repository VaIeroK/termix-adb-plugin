import { useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { DeviceInfo } from "../../files-client";
import { deviceInfo } from "../api/adb-session";

function size(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function line(info: DeviceInfo, t: (key: string) => string): string {
  const parts: string[] = [];
  const name = [info.brand, info.model].filter(Boolean).join(" ");
  if (name) parts.push(name);
  if (info.android) {
    parts.push(
      `Android ${info.android}${info.sdk ? ` (SDK ${info.sdk})` : ""}`,
    );
  }
  if (info.battery !== null)
    parts.push(`${t("files.battery")} ${info.battery}%`);
  if (info.freeBytes !== null && info.totalBytes !== null) {
    parts.push(
      `${t("files.free")} ${size(info.freeBytes)} / ${size(info.totalBytes)}`,
    );
  }
  return parts.join("  ·  ");
}

/** Model, Android version, battery and free space, refreshed every 15 s. */
export function DeviceStatusBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void deviceInfo(sessionId).then((next) => {
        if (alive && next) setInfo(next);
      });
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  if (!info) return null;
  return (
    <div className="shrink-0 truncate border-t border-edge-panel bg-elevated px-3 py-1 text-xs text-muted-foreground">
      {line(info, t)}
    </div>
  );
}
