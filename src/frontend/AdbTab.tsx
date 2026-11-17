import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css?inline";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { shellSocketUrl } from "./app";

type Status = "connecting" | "authorizing" | "ready" | "closed" | "error";

interface ServerMessage {
  type?: string;
  phase?: "connecting" | "authorizing" | "ready";
  code?: number;
  message?: string;
}

const STYLE_ID = "termix-adb-xterm-css";

function ensureXtermCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

const encoder = new TextEncoder();

export function AdbTab({
  host,
  isVisible,
  isFocusedPane,
  inSplit,
  handleRef,
}: TabProps) {
  const { t } = useTranslation();
  const hostId = host?.id === undefined ? "" : String(host.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [detail, setDetail] = useState("");
  // Bumped to start a fresh connection.
  const [attempt, setAttempt] = useState(0);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
    try {
      fitRef.current?.fit();
    } catch {
      // The terminal is not laid out yet.
    }
  }, []);

  // The terminal outlives reconnects.
  useEffect(() => {
    ensureXtermCss();
    const el = containerRef.current;
    if (!el) return undefined;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: "#0b0b0c", foreground: "#e4e4e7" },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current = fitAddon;
    fit();

    const observer = new ResizeObserver(() => fit());
    observer.observe(el);
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fit]);

  // One socket per attempt.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !hostId) return undefined;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let finished = false;
    setStatus("connecting");
    setDetail("");
    term.reset();

    const data = term.onData((input) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(input));
      }
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    void (async () => {
      try {
        fit();
        const target = await shellSocketUrl(hostId, term.cols, term.rows);
        if (cancelled) return;
        if (!target) throw new Error(t("adb.error"));
        socket = new WebSocket(target.url, target.protocols);
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            let message: ServerMessage;
            try {
              message = JSON.parse(event.data) as ServerMessage;
            } catch {
              return;
            }
            if (message.type === "phase" && message.phase) {
              setStatus(message.phase);
              if (message.phase === "ready" && isFocusedPane && !inSplit) {
                term.focus();
              }
            } else if (message.type === "exit") {
              finished = true;
              setStatus("closed");
              setDetail(
                message.code === undefined || message.code === 0
                  ? t("adb.closed")
                  : t("adb.exitCode", { code: message.code }),
              );
            } else if (message.type === "error") {
              finished = true;
              setStatus("error");
              setDetail(message.message || t("adb.error"));
            }
            return;
          }
          term.write(new Uint8Array(event.data as ArrayBuffer));
        };
        socket.onclose = () => {
          if (cancelled) return;
          if (!finished) {
            setStatus("closed");
            setDetail(t("adb.closed"));
          }
        };
        socket.onerror = () => {
          if (cancelled || finished) return;
          finished = true;
          setStatus("error");
          setDetail(t("adb.error"));
        };
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setDetail(error instanceof Error ? error.message : t("adb.error"));
      }
    })();

    return () => {
      cancelled = true;
      data.dispose();
      resize.dispose();
      if (socketRef.current === socket) socketRef.current = null;
      socket?.close();
    };
    // `t`, focus flags and `fit` must not restart a live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, attempt]);

  // Tabs laid out while hidden have no size to fit.
  useEffect(() => {
    if (!isVisible) return;
    fit();
    if (isFocusedPane && !inSplit) termRef.current?.focus();
  }, [isVisible, isFocusedPane, inSplit, fit]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  useImperativeHandle(
    handleRef,
    () => ({
      refresh: reconnect,
      disconnect: () => socketRef.current?.close(),
    }),
    [reconnect],
  );

  const banner =
    status === "ready"
      ? null
      : status === "connecting"
        ? t("adb.connecting")
        : status === "authorizing"
          ? t("adb.authorizing")
          : detail || t("adb.closed");
  const ended = status === "closed" || status === "error";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#0b0b0c",
        padding: 6,
        boxSizing: "border-box",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {banner && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            maxWidth: "min(480px, 80%)",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            color: status === "error" ? "#fecaca" : "#e4e4e7",
            background:
              status === "error"
                ? "rgba(127,29,29,0.9)"
                : "rgba(39,39,42,0.92)",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span>{banner}</span>
          {ended && (
            <button
              type="button"
              onClick={reconnect}
              style={{
                padding: "3px 10px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.3)",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              {t("adb.reconnect")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
