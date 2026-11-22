import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Save, X } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { FilesClient } from "./files-client";
import { modeOctal, modeText } from "./files-utils";

const border = "1px solid rgba(128,128,128,0.3)";
const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 6,
  border,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
} as const;
const mono = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: "20px",
} as const;

interface Props {
  client: FilesClient;
  path: string;
  onClose: () => void;
  onDownload: () => void;
}

export function FileEditor({ client, path, onClose, onDownload }: Props) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [mode, setMode] = useState("644");
  const [modeInput, setModeInput] = useState("644");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const dirty = loaded && text !== saved;
  const lines = useMemo(() => text.split("\n").length, [text]);
  const numbers = useMemo(
    () => Array.from({ length: lines }, (_, i) => i + 1).join("\n"),
    [lines],
  );

  useEffect(() => {
    let alive = true;
    client
      .readText(path)
      .then((file) => {
        if (!alive) return;
        setText(file.content);
        setSaved(file.content);
        const octal = modeOctal(file.mode);
        setMode(octal);
        setModeInput(octal);
        setLoaded(true);
      })
      .catch((error) => {
        if (!alive) return;
        setFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, [client, path]);

  const report = (error: unknown) =>
    setMessage(error instanceof Error ? error.message : String(error));

  const save = async () => {
    if (!loaded || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await client.writeText(path, text);
      setSaved(text);
      setMessage(t("files.saved"));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const applyMode = async () => {
    if (modeInput === mode || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await client.chmod(path, modeInput);
      setMode(modeInput);
      setMessage(t("files.permissionsSet"));
    } catch (error) {
      report(error);
      setModeInput(mode);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      const el = event.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = `${text.slice(0, a)}\t${text.slice(b)}`;
      setText(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = a + 1;
      });
    }
  };

  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const octalOk = /^[0-7]{3,4}$/.test(modeInput);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontSize: 13,
        color: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          alignItems: "center",
          flexWrap: "wrap",
          borderBottom: border,
        }}
      >
        <strong
          title={path}
          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {fileName}
          {dirty ? " •" : ""}
        </strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{path}</span>
        <span style={{ flex: 1 }} />
        <label
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
          title={t("files.permissions")}
        >
          <span style={{ opacity: 0.7, fontSize: 12 }}>
            {t("files.permissions")}
          </span>
          <input
            value={modeInput}
            maxLength={4}
            disabled={!loaded}
            onChange={(event) => setModeInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void applyMode();
            }}
            style={{
              ...mono,
              width: 52,
              padding: "2px 6px",
              borderRadius: 6,
              border,
              background: "transparent",
              color: "inherit",
            }}
          />
          <span style={{ ...mono, fontSize: 12, opacity: 0.7 }}>
            {octalOk ? modeText(Number.parseInt(modeInput, 8)) : ""}
          </span>
          <button
            type="button"
            style={buttonStyle}
            disabled={!loaded || !octalOk || modeInput === mode || busy}
            onClick={() => void applyMode()}
          >
            {t("files.apply")}
          </button>
        </label>
        <button
          type="button"
          style={buttonStyle}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          <Save size={14} />
          {t("files.save")}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={!loaded}
          onClick={onDownload}
        >
          <Download size={14} />
          {t("files.download")}
        </button>
        {confirmClose ? (
          <>
            <span style={{ fontSize: 12 }}>{t("files.discard")}</span>
            <button
              type="button"
              style={{ ...buttonStyle, borderColor: "#d33" }}
              onClick={onClose}
            >
              {t("files.discardYes")}
            </button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => setConfirmClose(false)}
            >
              {t("files.cancel")}
            </button>
          </>
        ) : (
          <button type="button" style={buttonStyle} onClick={close}>
            <X size={14} />
            {t("files.close")}
          </button>
        )}
      </div>
      {message && (
        <div
          style={{
            padding: "4px 8px",
            fontSize: 12,
            color:
              failed || /fail|denied|not|large|error/i.test(message)
                ? "#d33"
                : "inherit",
            opacity: 0.9,
          }}
        >
          {message}
        </div>
      )}
      {failed ? null : (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div
            ref={gutter}
            aria-hidden
            style={{
              ...mono,
              padding: "8px 8px 8px 12px",
              textAlign: "right",
              whiteSpace: "pre",
              overflow: "hidden",
              opacity: 0.5,
              borderRight: border,
              userSelect: "none",
              minWidth: 36,
            }}
          >
            {numbers}
          </div>
          <textarea
            ref={area}
            value={text}
            disabled={!loaded}
            spellCheck={false}
            wrap="off"
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onScroll={(event) => {
              if (gutter.current) {
                gutter.current.scrollTop = event.currentTarget.scrollTop;
              }
            }}
            style={{
              ...mono,
              flex: 1,
              minWidth: 0,
              padding: 8,
              border: "none",
              outline: "none",
              resize: "none",
              background: "transparent",
              color: "inherit",
              whiteSpace: "pre",
              overflow: "auto",
              tabSize: 4,
            }}
          />
        </div>
      )}
    </div>
  );
}
