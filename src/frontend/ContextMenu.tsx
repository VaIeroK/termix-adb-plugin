import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType } from "react";

export interface MenuEntry {
  id: string;
  label: string;
  icon?: ComponentType<{ size?: number }>;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above the entry. */
  separator?: boolean;
  run: () => void;
}

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

/** A right click menu that stays inside the window and closes on any outside action. */
export function ContextMenu({ x, y, entries, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const left = Math.max(
      4,
      Math.min(x, window.innerWidth - el.offsetWidth - 4),
    );
    const top = Math.max(
      4,
      Math.min(y, window.innerHeight - el.offsetHeight - 4),
    );
    setPlace({ left, top });
  }, [x, y, entries.length]);

  useEffect(() => {
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("contextmenu", away, true);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("contextmenu", away, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  return (
    <div
      ref={box}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: place.left,
        top: place.top,
        zIndex: 1000,
        minWidth: 190,
        padding: 4,
        borderRadius: 8,
        border: "1px solid rgba(128,128,128,0.35)",
        background: "var(--popover, #1f2023)",
        color: "var(--popover-foreground, #f3f4f6)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        fontSize: 13,
        userSelect: "none",
      }}
    >
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <div key={entry.id}>
            {entry.separator && (
              <div
                style={{
                  height: 1,
                  margin: "4px 2px",
                  background: "rgba(128,128,128,0.3)",
                }}
              />
            )}
            <button
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                onClose();
                entry.run();
              }}
              style={{
                display: "flex",
                width: "100%",
                gap: 8,
                alignItems: "center",
                padding: "6px 10px",
                border: "none",
                borderRadius: 5,
                background: "transparent",
                color: entry.danger ? "#f87171" : "inherit",
                opacity: entry.disabled ? 0.4 : 1,
                cursor: entry.disabled ? "default" : "pointer",
                font: "inherit",
                textAlign: "left",
              }}
              onMouseEnter={(event) => {
                if (!entry.disabled) {
                  event.currentTarget.style.background =
                    "rgba(128,128,128,0.22)";
                }
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              {Icon ? <Icon size={14} /> : <span style={{ width: 14 }} />}
              {entry.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
