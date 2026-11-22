import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Home,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { downloadUrl, filesSocketUrl } from "./app";
import { FileEditor } from "./FileEditor";
import { FilesClient, type FileItem } from "./files-client";
import {
  formatSize,
  modeOctal,
  modeText,
  joinPath,
  parentPath,
  sortItems,
  START_PATH,
} from "./files-utils";

type Status = "connecting" | "authorizing" | "ready" | "closed" | "error";

interface Transfer {
  id: number;
  name: string;
  kind: "down" | "up";
  done: number;
  total: number;
  state: "running" | "done" | "failed";
  error?: string;
  doneLabel?: string;
}

type Prompt = {
  kind: "mkdir" | "rename" | "chmod";
  value: string;
  target?: string;
  recursive?: boolean;
};

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
const cell = {
  padding: "4px 8px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function FilesTab({ host }: TabProps) {
  const { t } = useTranslation();
  const hostId = host?.id === undefined ? "" : String(host.id);
  const clientRef = useRef<FilesClient | null>(null);
  const pathRef = useRef(START_PATH);
  const [status, setStatus] = useState<Status>("connecting");
  const [detail, setDetail] = useState("");
  const [needsPairing, setNeedsPairing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [path, setPath] = useState(START_PATH);
  const [pathInput, setPathInput] = useState(START_PATH);
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorName, setAnchorName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  // True right after a rubber band drag, so its mouse up isn't taken as a click.
  const justDragged = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Ids for transfers that have no socket id (downloads are plain links).
  const nextLocalId = useRef(-1);

  const sorted = useMemo(() => sortItems(items), [items]);

  const load = useCallback(async (target: string) => {
    const client = clientRef.current;
    if (!client) return;
    setLoading(true);
    setProblem("");
    try {
      const reply = await client.call("list", { path: target });
      pathRef.current = target;
      setPath(target);
      setPathInput(target);
      setItems(reply.entries ?? []);
      setSelected(new Set());
      setAnchorName(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setPathInput(pathRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hostId) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    setStatus("connecting");
    setDetail("");
    setNeedsPairing(false);
    clientRef.current = null;

    void (async () => {
      const target = await filesSocketUrl(hostId);
      if (disposed) return;
      if (!target) {
        setStatus("error");
        setDetail(t("adb.error"));
        return;
      }
      socket = new WebSocket(target.url, target.protocols);
      const client = new FilesClient(socket);
      let failed = false;
      socket.onmessage = (event) => {
        const message = client.dispatch(event.data);
        if (!message) return;
        if (message.type === "phase" && message.phase) {
          setStatus(message.phase);
          if (message.phase === "ready") {
            clientRef.current = client;
            void load(pathRef.current);
          }
        } else if (message.type === "error") {
          failed = true;
          setStatus("error");
          setDetail(message.message || t("adb.error"));
          setNeedsPairing(message.needsPairing === true);
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        clientRef.current = null;
        client.failAll(t("adb.closed"));
        if (!failed) setStatus("closed");
      };
    })();

    return () => {
      disposed = true;
      clientRef.current = null;
      socket?.close();
    };
  }, [hostId, attempt, load, t]);

  const reload = useCallback(() => void load(pathRef.current), [load]);

  const patchTransfer = useCallback((id: number, patch: Partial<Transfer>) => {
    setTransfers((list) =>
      list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const download = useCallback(
    async (names: FileItem[], base?: string) => {
      const client = clientRef.current;
      if (!client || names.length === 0) return;
      const label =
        names.length === 1
          ? names[0].name
          : `${names.length} ${t("files.items")}`;
      const id = nextLocalId.current--;
      setTransfers((list) => [
        ...list,
        { id, name: label, kind: "down", done: 0, total: 0, state: "running" },
      ]);
      try {
        const reply = await client.downloadTicket(
          names.map((item) => joinPath(base ?? pathRef.current, item.name)),
        );
        const href = await downloadUrl(reply.ticket);
        if (!href) throw new Error(t("adb.error"));
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = reply.name;
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        patchTransfer(id, {
          state: "done",
          name: reply.name,
          doneLabel: t("files.downloadStarted"),
        });
      } catch (error) {
        patchTransfer(id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [patchTransfer, t],
  );

  const upload = useCallback(
    async (files: File[]) => {
      const client = clientRef.current;
      if (!client) return;
      for (const file of files) {
        const { id, result } = client.upload(
          joinPath(pathRef.current, file.name),
          file,
          (done) => patchTransfer(id, { done }),
        );
        setTransfers((list) => [
          ...list,
          {
            id,
            name: file.name,
            kind: "up",
            done: 0,
            total: file.size,
            state: "running",
          },
        ]);
        try {
          await result;
          patchTransfer(id, { state: "done", done: file.size });
        } catch (error) {
          patchTransfer(id, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      reload();
    },
    [patchTransfer, reload],
  );

  const run = useCallback(
    async (op: string, payload: Record<string, unknown>) => {
      const client = clientRef.current;
      if (!client) return;
      setProblem("");
      try {
        await client.call(op, payload);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
      reload();
    },
    [reload],
  );

  const selectedItems = sorted.filter((item) => selected.has(item.name));

  const open = (item: FileItem) => {
    if (item.dir) void load(joinPath(path, item.name));
    else setEditing(joinPath(path, item.name));
  };

  // Drag with the left button over the list to select the rows it touches.
  const startBand = (event: React.MouseEvent) => {
    const box = listRef.current;
    if (event.button !== 0 || !box) return;
    // Leave the scroll bars alone.
    const bounds = box.getBoundingClientRect();
    if (
      event.clientX > bounds.left + box.clientWidth ||
      event.clientY > bounds.top + box.clientHeight
    ) {
      return;
    }
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const base = additive ? new Set(selected) : new Set<string>();
    const originX = event.clientX - bounds.left + box.scrollLeft;
    const originY = event.clientY - bounds.top + box.scrollTop;
    let active = false;

    const move = (e: MouseEvent) => {
      const now = box.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - now.left, box.clientWidth));
      const y = Math.max(0, Math.min(e.clientY - now.top, box.clientHeight));
      const curX = x + box.scrollLeft;
      const curY = y + box.scrollTop;
      if (!active && Math.hypot(curX - originX, curY - originY) < 4) return;
      active = true;
      const left = Math.min(originX, curX);
      const top = Math.min(originY, curY);
      const width = Math.abs(curX - originX);
      const height = Math.abs(curY - originY);
      setBand({ x: left, y: top, w: width, h: height });
      const next = new Set(base);
      for (const row of box.querySelectorAll<HTMLElement>("tr[data-name]")) {
        const r = row.getBoundingClientRect();
        const rowTop = r.top - now.top + box.scrollTop;
        const rowLeft = r.left - now.left + box.scrollLeft;
        if (
          rowTop < top + height &&
          rowTop + r.height > top &&
          rowLeft < left + width &&
          rowLeft + r.width > left
        ) {
          next.add(row.dataset.name as string);
        }
      }
      setSelected(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBand(null);
      if (active) {
        justDragged.current = true;
        setTimeout(() => {
          justDragged.current = false;
        }, 0);
        setConfirmDelete(false);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // Without this the browser starts selecting page text.
    event.preventDefault();
    listRef.current?.closest<HTMLElement>("[tabindex]")?.focus();
  };

  const onRowClick = (event: React.MouseEvent, item: FileItem) => {
    if (justDragged.current) return;
    setConfirmDelete(false);
    if (event.shiftKey && anchorName) {
      const names = sorted.map((i) => i.name);
      const from = names.indexOf(anchorName);
      const to = names.indexOf(item.name);
      const [a, b] = from < to ? [from, to] : [to, from];
      setSelected(new Set(names.slice(a, b + 1)));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selected);
      if (next.has(item.name)) next.delete(item.name);
      else next.add(item.name);
      setSelected(next);
    } else {
      setSelected(new Set([item.name]));
    }
    setAnchorName(item.name);
  };

  const submitPrompt = () => {
    if (!prompt) return;
    if (prompt.kind === "chmod") {
      const mode = prompt.value.trim();
      if (!/^[0-7]{3,4}$/.test(mode)) return;
      void run("chmod", {
        paths: selectedItems.map((item) => joinPath(path, item.name)),
        mode,
        recursive: Boolean(prompt.recursive),
      });
      setPrompt(null);
      return;
    }
    const name = prompt.value.trim().replace(/\/+$/, "");
    if (!name || name.includes("/")) return;
    if (prompt.kind === "mkdir") {
      void run("mkdir", { path: joinPath(path, name) });
    } else if (prompt.target && name !== prompt.target) {
      void run("rename", {
        from: joinPath(path, prompt.target),
        to: joinPath(path, name),
      });
    }
    setPrompt(null);
  };

  const startRename = () => {
    if (selectedItems.length === 1) {
      setPrompt({
        kind: "rename",
        value: selectedItems[0].name,
        target: selectedItems[0].name,
      });
    }
  };

  const startChmod = () => {
    if (selectedItems.length === 0) return;
    setPrompt({
      kind: "chmod",
      value: modeOctal(selectedItems[0].mode),
      recursive: false,
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.key === "F2") startRename();
    else if (event.key === "Delete" && selectedItems.length)
      setConfirmDelete(true);
    else if (event.key === "Backspace") void load(parentPath(path));
    else if (event.key === "Enter" && selectedItems.length === 1)
      open(selectedItems[0]);
    else if ((event.ctrlKey || event.metaKey) && event.key === "a") {
      event.preventDefault();
      setSelected(new Set(sorted.map((i) => i.name)));
    } else return;
    event.preventDefault();
  };

  if (!hostId) return null;

  if (status !== "ready") {
    return (
      <div style={{ padding: 16, fontSize: 13, color: "inherit" }}>
        <div>
          {status === "error" || status === "closed"
            ? needsPairing
              ? t("adb.notPaired")
              : detail || t("adb.closed")
            : status === "authorizing"
              ? t("adb.authorizing")
              : t("adb.connecting")}
        </div>
        {needsPairing && (
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            {t("files.pairFirst")}
          </div>
        )}
        {(status === "error" || status === "closed") && (
          <button
            type="button"
            style={{ ...buttonStyle, marginTop: 12 }}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("adb.reconnect")}
          </button>
        )}
      </div>
    );
  }

  if (editing && clientRef.current) {
    const file = editing;
    return (
      <FileEditor
        client={clientRef.current}
        path={file}
        onClose={() => setEditing(null)}
        onDownload={() =>
          void download(
            [
              {
                name: file.slice(file.lastIndexOf("/") + 1),
                mode: 0,
                size: 0,
                mtime: 0,
                dir: false,
                link: false,
              },
            ],
            parentPath(file),
          )
        }
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        fontSize: 13,
        color: "inherit",
        outline: "none",
      }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload([...event.dataTransfer.files]);
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
        <button
          type="button"
          style={buttonStyle}
          title={t("files.up")}
          onClick={() => void load(parentPath(path))}
          disabled={path === "/"}
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          style={buttonStyle}
          title={t("files.home")}
          onClick={() => void load(START_PATH)}
        >
          <Home size={14} />
        </button>
        <button
          type="button"
          style={buttonStyle}
          title={t("files.refresh")}
          onClick={reload}
        >
          <RefreshCw size={14} />
        </button>
        <input
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const value = pathInput.trim();
              void load(value.startsWith("/") ? value : `/${value}`);
            }
          }}
          aria-label={t("files.path")}
          style={{
            flex: 1,
            minWidth: 160,
            padding: "4px 8px",
            borderRadius: 6,
            border,
            background: "rgba(128,128,128,0.1)",
            color: "inherit",
            font: "inherit",
          }}
        />
        <button
          type="button"
          style={buttonStyle}
          onClick={() => setPrompt({ kind: "mkdir", value: "" })}
        >
          <FolderPlus size={14} /> {t("files.newFolder")}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={14} /> {t("files.upload")}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(files);
          }}
        />
        <button
          type="button"
          style={buttonStyle}
          disabled={selectedItems.length === 0}
          onClick={() => void download(selectedItems)}
        >
          <Download size={14} /> {t("files.download")}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={selectedItems.length !== 1}
          onClick={startRename}
        >
          <Pencil size={14} /> {t("files.rename")}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={selectedItems.length === 0}
          onClick={startChmod}
        >
          <Lock size={14} /> {t("files.permissions")}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={selectedItems.length === 0}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={14} /> {t("files.delete")}
        </button>
      </div>

      {prompt && (
        <div
          style={{ display: "flex", gap: 6, padding: 8, borderBottom: border }}
        >
          <input
            autoFocus
            value={prompt.value}
            placeholder={t(
              prompt.kind === "mkdir"
                ? "files.folderName"
                : prompt.kind === "chmod"
                  ? "files.permissionsHint"
                  : "files.newName",
            )}
            onChange={(event) =>
              setPrompt({ ...prompt, value: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") submitPrompt();
              if (event.key === "Escape") setPrompt(null);
            }}
            style={{
              flex: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border,
              background: "rgba(128,128,128,0.1)",
              color: "inherit",
              font: "inherit",
            }}
          />
          {prompt.kind === "chmod" && selectedItems.some((i) => i.dir) && (
            <label
              style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={Boolean(prompt.recursive)}
                onChange={(event) =>
                  setPrompt({ ...prompt, recursive: event.target.checked })
                }
              />
              {t("files.recursive")}
            </label>
          )}
          <button type="button" style={buttonStyle} onClick={submitPrompt}>
            OK
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => setPrompt(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {confirmDelete && selectedItems.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: 8,
            borderBottom: border,
            background: "rgba(239,68,68,0.12)",
          }}
        >
          <span style={{ flex: 1 }}>
            {t("files.confirmDelete", { count: selectedItems.length })}
          </span>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              setConfirmDelete(false);
              void run("delete", {
                paths: selectedItems.map((i) => joinPath(path, i.name)),
              });
            }}
          >
            {t("files.delete")}
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => setConfirmDelete(false)}
          >
            {t("files.cancel")}
          </button>
        </div>
      )}

      {problem && (
        <div
          style={{ padding: "6px 8px", color: "#f87171", borderBottom: border }}
        >
          {problem}
        </div>
      )}

      <div
        ref={listRef}
        onMouseDown={startBand}
        onClick={(event) => {
          // A click on empty space clears the selection.
          if (event.target === event.currentTarget && !justDragged.current) {
            setSelected(new Set());
          }
        }}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          userSelect: "none",
          overflow: "auto",
          outline: dragging ? "2px dashed rgba(96,165,250,0.8)" : "none",
          outlineOffset: -4,
          opacity: loading ? 0.6 : 1,
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", opacity: 0.7, fontSize: 11 }}>
              <th style={cell}>{t("files.name")}</th>
              <th style={{ ...cell, width: 96 }}>{t("files.permissions")}</th>
              <th style={{ ...cell, width: 100, textAlign: "right" }}>
                {t("files.size")}
              </th>
              <th style={{ ...cell, width: 160 }}>{t("files.modified")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={item.name}
                data-name={item.name}
                onClick={(event) => onRowClick(event, item)}
                onDoubleClick={() => open(item)}
                style={{
                  cursor: "default",
                  background: selected.has(item.name)
                    ? "rgba(96,165,250,0.25)"
                    : "transparent",
                }}
              >
                <td style={cell}>
                  <span
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    {item.dir ? <Folder size={14} /> : <FileIcon size={14} />}
                    {item.name}
                    {item.link ? " →" : ""}
                  </span>
                </td>
                <td
                  title={modeOctal(item.mode)}
                  style={{
                    ...cell,
                    opacity: 0.8,
                    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                    fontSize: 11,
                  }}
                >
                  {item.mode ? `${modeText(item.mode)}` : ""}
                </td>
                <td style={{ ...cell, textAlign: "right", opacity: 0.8 }}>
                  {item.dir ? "" : formatSize(item.size)}
                </td>
                <td style={{ ...cell, opacity: 0.8 }}>
                  {item.mtime
                    ? new Date(item.mtime * 1000).toLocaleString()
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {band && (
          <div
            style={{
              position: "absolute",
              left: band.x,
              top: band.y,
              width: band.w,
              height: band.h,
              border: "1px solid rgba(96,165,250,0.9)",
              background: "rgba(96,165,250,0.2)",
              pointerEvents: "none",
            }}
          />
        )}
        {!loading && sorted.length === 0 && !problem && (
          <div style={{ padding: 16, opacity: 0.7 }}>{t("files.empty")}</div>
        )}
      </div>

      {transfers.length > 0 && (
        <div style={{ borderTop: border, maxHeight: 140, overflow: "auto" }}>
          {transfers.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "4px 8px",
              }}
            >
              <span style={{ flex: 1, ...cell }}>
                {item.kind === "down" ? "↓" : "↑"} {item.name}
              </span>
              <span style={{ opacity: 0.8 }}>
                {item.state === "failed"
                  ? item.error
                  : item.state === "done"
                    ? (item.doneLabel ?? t("files.done"))
                    : item.total
                      ? `${Math.floor((item.done / item.total) * 100)}%`
                      : formatSize(item.done)}
              </span>
              {item.state === "running" ? (
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => clientRef.current?.cancel(item.id)}
                  title={t("files.cancel")}
                >
                  <X size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() =>
                    setTransfers((list) => list.filter((i) => i.id !== item.id))
                  }
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
