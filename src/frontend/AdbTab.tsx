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

// Shows which route a paste took. Set false once the touchpad tap is sorted.
const DEBUG_PASTE = false;

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
  // A short note when a clipboard read is refused, with the reason.
  const [notice, setNotice] = useState("");
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
    // Termix's own key bindings and xterm both get to Ctrl+V first, and xterm
    // answers with a raw ^V. So the paste is done here, once, from whichever
    // route reaches us: the browser's paste event or a clipboard read.
    let lastPaste = 0;
    const pasteText = (text: string | undefined) => {
      if (!text) return;
      const now = Date.now();
      if (now - lastPaste < 30) return;
      lastPaste = now;
      term.paste(text);
    };
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const flash = (text: string) => {
      setNotice(text);
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setNotice(""), 6000);
    };
    const readClipboard = async (source = "key") => {
      try {
        if (DEBUG_PASTE) flash(`paste: ${source}...`);
        const text = await navigator.clipboard.readText();
        if (DEBUG_PASTE) flash(`paste: ${source}, ${text.length} chars`);
        if (!text) return;
        pasteText(text);
      } catch (error) {
        setNotice(
          `${t("adb.pasteRefused")}${error instanceof Error && error.message ? ` (${error.message})` : ""}`,
        );
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => setNotice(""), 6000);
      }
    };
    const copySelection = () => {
      const selected = term.getSelection();
      if (selected) {
        void navigator.clipboard?.writeText(selected).catch(() => undefined);
      }
    };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && event.shiftKey && key === "v") {
        event.preventDefault();
        event.stopPropagation();
        void readClipboard();
        return false;
      }
      // Stand aside: the browser fires its paste event, handled below.
      if ((mod && key === "v") || (event.shiftKey && event.key === "Insert")) {
        event.stopPropagation();
        return false;
      }
      // Ctrl+C copies while text is selected and interrupts otherwise.
      if (mod && key === "c" && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        copySelection();
        return false;
      }
      return true;
    });
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pasteText(event.clipboardData?.getData("text/plain"));
    };
    // Capture, so xterm's own handler on its textarea never pastes a second time.
    el.addEventListener("paste", onPaste, true);
    // A two-finger tap on a touchpad is a right click (a middle click on some
    // systems). Like the SSH terminal: copy while text is selected, else paste.
    // One tap can arrive as pointerdown, mouseup and contextmenu: read once.
    let lastTap = 0;
    const pasteFromClipboard = (event: MouseEvent, source: string) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastTap < 300) return;
      lastTap = now;
      // Read the selection now: later events of the same tap may change it.
      if (term.hasSelection()) {
        copySelection();
        return;
      }
      void readClipboard(source);
    };
    const onContextMenu = (event: MouseEvent) =>
      pasteFromClipboard(event, "contextmenu");
    const onAuxClick = (event: MouseEvent) => {
      if (event.button === 1) pasteFromClipboard(event, "middle click");
    };
    // Listen on the whole frame: a layer over the terminal could take the tap.
    const seen = (event: Event) => {
      if (DEBUG_PASTE) {
        const m = event as MouseEvent;
        flash(`event: ${event.type} button ${m.button ?? "-"}`);
      }
    };
    const rightDown = (event: Event) => {
      const m = event as MouseEvent;
      if (event.type === "contextmenu" || m.button === 2 || m.button === 1) {
        pasteFromClipboard(m, `${event.type} b${m.button}`);
      }
    };
    const watched = [
      "pointerdown",
      "mousedown",
      "mouseup",
      "auxclick",
      "contextmenu",
      "touchstart",
      "gesturestart",
    ];
    for (const name of watched) {
      document.addEventListener(name, seen, true);
      document.addEventListener(name, rightDown, true);
    }
    el.addEventListener("contextmenu", onContextMenu, true);
    el.addEventListener("auxclick", onAuxClick, true);
    term.open(el);
    termRef.current = term;
    fitRef.current = fitAddon;
    fit();

    const observer = new ResizeObserver(() => fit());
    observer.observe(el);
    return () => {
      clearTimeout(noticeTimer);
      el.removeEventListener("paste", onPaste, true);
      for (const name of watched) {
        document.removeEventListener(name, seen, true);
        document.removeEventListener(name, rightDown, true);
      }
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("auxclick", onAuxClick, true);
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
              if (message.phase === "ready" && isFocusedPane) {
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
    if (isFocusedPane) termRef.current?.focus();
  }, [isVisible, isFocusedPane, fit]);

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
      onMouseDown={() => termRef.current?.focus()}
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
      {notice && !banner && (
        <div
          role="status"
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            color: "#fde68a",
            background: "rgba(39,39,42,0.92)",
          }}
        >
          {notice}
        </div>
      )}
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
