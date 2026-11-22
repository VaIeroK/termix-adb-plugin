import { useState } from "react";
import { useSettings, useTranslation } from "@termix-ssh/plugin-sdk/frontend";

const border = "1px solid rgba(128,128,128,0.45)";

/**
 * After a failed connect: wireless debugging picks a new port every time it
 * is switched on, and a phone that already trusts Termix needs only that port.
 * Shown only once this host has connected or paired before.
 */
export function PortFix({
  hostId,
  onSaved,
}: {
  hostId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const settings = useSettings("host", hostId);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!settings.loaded || settings.values.adbPaired !== true) return null;
  const current = Number(settings.values.adbPort) || 5555;
  const port = Number(value);
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await settings.save({ ...settings.values, adbPort: port });
      setValue("");
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") void save();
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 8,
        border,
        fontSize: 13,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      <div>{t("adb.portChanged")}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          inputMode="numeric"
          placeholder={`${t("adb.newPort")} (${current})`}
          value={value}
          onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
          aria-label={t("adb.newPort")}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "4px 8px",
            borderRadius: 6,
            border,
            background: "rgba(0,0,0,0.25)",
            color: "inherit",
            font: "inherit",
          }}
        />
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => void save()}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          {t("adb.savePort")}
        </button>
      </div>
      {error && <div style={{ color: "#f87171" }}>{error}</div>}
    </div>
  );
}
