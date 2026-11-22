import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ClipboardPaste,
  Download,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  PackagePlus,
  Scissors,
  File as FileIcon,
  Folder,
  FolderPlus,
  Home,
  Lock,
  Pencil,
  Search,
  FolderUp,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useToast,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { downloadUrl, filesSocketUrl } from "./app";
import { FileEditor } from "./FileEditor";
import { PortFix } from "./PortFix";
import {
  entriesFromDrop,
  leafDirs,
  planFromEntries,
  planFromFiles,
  type UploadPlan,
} from "./upload-tree";
import { FilesClient, type DeviceInfo, type FileItem } from "./files-client";
import {
  formatSize,
  modeOctal,
  modeText,
  joinPath,
  parentPath,
  shortDate,
  sortItems,
  type SortKey,
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
  const toast = useToast();
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: FileItem | null;
  } | null>(null);
  const [clipboard, setClipboard] = useState<{
    paths: string[];
    mode: "copy" | "cut";
  } | null>(null);
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem("adb.showHidden") === "1";
    } catch {
      return false;
    }
  });
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<{
    query: string;
    truncated: boolean;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // What an in-list drag carries, and the cancel hooks of running uploads.
  const dragPaths = useRef<string[] | null>(null);
  const cancelHooks = useRef(new Map<number, () => void>());
  const infoAt = useRef(0);
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

  const sorted = useMemo(
    () =>
      sortItems(
        showHidden || search
          ? items
          : items.filter((i) => !i.name.startsWith(".")),
        sortKey,
        sortDesc,
      ),
    [items, showHidden, search, sortKey, sortDesc],
  );

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
      setSearch(null);
      setSelected(new Set());
      setAnchorName(null);
      if (Date.now() - infoAt.current > 15_000) {
        infoAt.current = Date.now();
        client
          .call("info")
          .then((reply) => setInfo(reply.info ?? null))
          .catch(() => undefined);
      }
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
    async (plan: UploadPlan, destination = pathRef.current) => {
      const client = clientRef.current;
      if (!client || plan.files.length + plan.dirs.length === 0) return;
      // One row per dropped item: a folder is one row with its total.
      const groups = new Map<
        string,
        { files: UploadPlan["files"]; dirs: string[]; folder: boolean }
      >();
      const group = (top: string, folder: boolean) => {
        let found = groups.get(top);
        if (!found) {
          found = { files: [], dirs: [], folder };
          groups.set(top, found);
        }
        return found;
      };
      for (const item of plan.files) {
        const top = item.rel.split("/")[0];
        group(top, item.rel.includes("/")).files.push(item);
      }
      for (const dir of plan.dirs)
        group(dir.split("/")[0], true).dirs.push(dir);

      for (const [top, entry] of groups) {
        const id = nextLocalId.current--;
        const total = entry.files.reduce((sum, f) => sum + f.file.size, 0);
        let cancelled = false;
        let active = 0;
        cancelHooks.current.set(id, () => {
          cancelled = true;
          if (active) clientRef.current?.cancel(active);
        });
        setTransfers((list) => [
          ...list,
          {
            id,
            name: entry.folder ? `${top}/` : top,
            kind: "up",
            done: 0,
            total,
            state: "running",
          },
        ]);
        try {
          for (const dir of leafDirs({
            files: entry.files,
            dirs: entry.dirs,
          })) {
            await client.call("mkdir", { path: joinPath(destination, dir) });
          }
          let sent = 0;
          for (const { rel, file } of entry.files) {
            if (cancelled) throw new Error(t("files.cancelled"));
            const base = sent;
            const upload = client.upload(
              joinPath(destination, rel),
              file,
              (done) => patchTransfer(id, { done: base + done }),
            );
            active = upload.id;
            await upload.result;
            active = 0;
            sent += file.size;
          }
          patchTransfer(id, { state: "done", done: total });
        } catch (error) {
          patchTransfer(id, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          cancelHooks.current.delete(id);
        }
      }
      reload();
    },
    [patchTransfer, reload, t],
  );

  // Takes what a drop carries; entries must be read before anything awaits.
  const uploadDropped = (data: DataTransfer, destination?: string) => {
    const entries = entriesFromDrop(data);
    const files = [...data.files];
    void (async () => {
      try {
        const plan = entries
          ? await planFromEntries(entries)
          : planFromFiles(files);
        await upload(plan, destination);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
  };

  const moveInto = async (
    paths: string[],
    destination: string,
    copy: boolean,
  ) => {
    const client = clientRef.current;
    if (!client) return;
    setProblem("");
    try {
      for (const from of paths) {
        const name = from.slice(from.lastIndexOf("/") + 1);
        if (parentPath(from) === destination) continue;
        await client.call(copy ? "copy" : "rename", {
          from,
          to: joinPath(destination, name),
        });
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
    reload();
  };

  const runSearch = async () => {
    const client = clientRef.current;
    const query = searchText.trim();
    if (!client || !query) return;
    setProblem("");
    setLoading(true);
    try {
      const reply = await client.search(pathRef.current, query);
      setItems(reply.entries);
      setSelected(new Set());
      setAnchorName(null);
      setSearch({ query, truncated: reply.truncated });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const clearSearch = () => {
    setSearchText("");
    reload();
  };

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
    // A selected row is dragged instead, to move it into a folder.
    if (
      (event.target as HTMLElement).closest?.('tr[draggable="true"]') &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      return;
    }
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
    } else if (prompt.target) {
      const from = joinPath(path, prompt.target);
      if (name !== from.slice(from.lastIndexOf("/") + 1)) {
        void run("rename", { from, to: joinPath(parentPath(from), name) });
      }
    }
    setPrompt(null);
  };

  const toggleHidden = () => {
    setShowHidden((value) => {
      try {
        localStorage.setItem("adb.showHidden", value ? "0" : "1");
      } catch {
        // Not kept between visits.
      }
      return !value;
    });
    setSelected(new Set());
  };

  const copySelection = (mode: "copy" | "cut", picked = selectedItems) => {
    if (picked.length === 0) return;
    setClipboard({
      paths: picked.map((item) => joinPath(pathRef.current, item.name)),
      mode,
    });
  };

  // A free name for a copy next to its original: "a (copy).txt", "a (copy 2).txt".
  const copyName = (name: string) => {
    const taken = new Set(items.map((i) => i.name));
    const dot = name.lastIndexOf(".");
    const [stem, ext] =
      dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n += 1) {
      const candidate = `${stem} (${n === 1 ? "copy" : `copy ${n}`})${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  };

  const paste = async (destination = pathRef.current) => {
    const client = clientRef.current;
    if (!client || !clipboard) return;
    setProblem("");
    try {
      for (const from of clipboard.paths) {
        const name = from.slice(from.lastIndexOf("/") + 1);
        const sameFolder = parentPath(from) === destination;
        if (clipboard.mode === "cut" && sameFolder) continue;
        const target =
          sameFolder && destination === pathRef.current ? copyName(name) : name;
        await client.call(clipboard.mode === "copy" ? "copy" : "rename", {
          from,
          to: joinPath(destination, target),
        });
      }
      if (clipboard.mode === "cut") setClipboard(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
    infoAt.current = 0;
    reload();
  };

  const install = async (item: FileItem) => {
    const client = clientRef.current;
    if (!client) return;
    toast.info(`${t("files.installing")} ${item.name}`);
    try {
      await client.call("install", {
        path: joinPath(pathRef.current, item.name),
      });
      toast.success(`${t("files.installed")}: ${item.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const openMenu = (event: React.MouseEvent, item: FileItem | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (item && !selected.has(item.name)) {
      setSelected(new Set([item.name]));
      setAnchorName(item.name);
    }
    if (!item) setSelected(new Set());
    setConfirmDelete(false);
    setMenu({ x: event.clientX, y: event.clientY, target: item });
  };

  const menuEntries = (target: FileItem | null): MenuEntry[] => {
    const hasClipboard = clipboard !== null;
    if (!target) {
      return [
        {
          id: "paste",
          label: t("files.paste"),
          icon: ClipboardPaste,
          disabled: !hasClipboard,
          run: () => void paste(),
        },
        {
          id: "mkdir",
          label: t("files.newFolder"),
          icon: FolderPlus,
          separator: true,
          run: () => setPrompt({ kind: "mkdir", value: "" }),
        },
        {
          id: "upload",
          label: t("files.upload"),
          icon: Upload,
          run: () => fileInput.current?.click(),
        },
        {
          id: "uploadFolder",
          label: t("files.uploadFolder"),
          icon: FolderUp,
          run: () => folderInput.current?.click(),
        },
        {
          id: "refresh",
          label: t("files.refresh"),
          icon: RefreshCw,
          run: reload,
        },
      ];
    }
    const picked = selectedItems.length > 0 ? selectedItems : [target];
    const single = picked.length === 1;
    const entries: MenuEntry[] = [];
    if (single) {
      entries.push({
        id: "open",
        label: target.dir ? t("files.open") : t("files.edit"),
        icon: target.dir ? FolderOpen : Pencil,
        run: () => open(target),
      });
      if (!target.dir && /\.apk$/i.test(target.name)) {
        entries.push({
          id: "install",
          label: t("files.install"),
          icon: PackagePlus,
          run: () => void install(target),
        });
      }
    }
    entries.push(
      {
        id: "download",
        label: t("files.download"),
        icon: Download,
        separator: true,
        run: () => void download(picked),
      },
      {
        id: "copy",
        label: t("files.copy"),
        icon: Copy,
        separator: true,
        run: () => copySelection("copy", picked),
      },
      {
        id: "cut",
        label: t("files.cut"),
        icon: Scissors,
        run: () => copySelection("cut", picked),
      },
    );
    if (single && target.dir && hasClipboard) {
      entries.push({
        id: "pasteInto",
        label: t("files.pasteInto"),
        icon: ClipboardPaste,
        run: () => void paste(joinPath(pathRef.current, target.name)),
      });
    }
    entries.push(
      {
        id: "rename",
        label: t("files.rename"),
        icon: Pencil,
        separator: true,
        disabled: !single,
        run: startRename,
      },
      {
        id: "permissions",
        label: t("files.permissions"),
        icon: Lock,
        run: startChmod,
      },
      {
        id: "delete",
        label: t("files.delete"),
        icon: Trash2,
        danger: true,
        separator: true,
        run: () => setConfirmDelete(true),
      },
    );
    return entries;
  };

  const startRename = () => {
    if (selectedItems.length === 1) {
      setPrompt({
        kind: "rename",
        value: selectedItems[0].name.slice(
          selectedItems[0].name.lastIndexOf("/") + 1,
        ),
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
    else if ((event.ctrlKey || event.metaKey) && event.key === "f")
      searchInput.current?.focus();
    else if (event.key === "Escape" && search) clearSearch();
    else if ((event.ctrlKey || event.metaKey) && event.key === "c")
      copySelection("copy");
    else if ((event.ctrlKey || event.metaKey) && event.key === "x")
      copySelection("cut");
    else if ((event.ctrlKey || event.metaKey) && event.key === "v")
      void paste();
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
        {status === "error" && !needsPairing && (
          <div style={{ marginTop: 12, maxWidth: 420 }}>
            <PortFix hostId={hostId} onSaved={() => setAttempt((n) => n + 1)} />
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
        if (event.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.types.includes("Files")) {
          uploadDropped(event.dataTransfer);
        }
        dragPaths.current = null;
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
        <button
          type="button"
          style={buttonStyle}
          title={t("files.uploadFolder")}
          onClick={() => folderInput.current?.click()}
        >
          <FolderUp size={14} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(planFromFiles(files));
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          style={{ display: "none" }}
          {...{ webkitdirectory: "", directory: "" }}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(planFromFiles(files));
          }}
        />
        <span style={{ position: "relative", display: "inline-flex" }}>
          <Search
            size={13}
            style={{ position: "absolute", left: 7, top: 7, opacity: 0.6 }}
          />
          <input
            ref={searchInput}
            value={searchText}
            placeholder={t("files.search")}
            aria-label={t("files.search")}
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") void runSearch();
              else if (event.key === "Escape") clearSearch();
            }}
            style={{
              width: 150,
              padding: "4px 8px 4px 25px",
              borderRadius: 6,
              border,
              background: "rgba(128,128,128,0.1)",
              color: "inherit",
              font: "inherit",
            }}
          />
        </span>
        <button
          type="button"
          style={buttonStyle}
          title={t(showHidden ? "files.hideHidden" : "files.showHidden")}
          onClick={toggleHidden}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        {clipboard && (
          <span style={{ fontSize: 12, opacity: 0.75 }}>
            {clipboard.mode === "copy" ? (
              <Copy size={12} />
            ) : (
              <Scissors size={12} />
            )}{" "}
            {clipboard.paths.length}
            <button
              type="button"
              style={{ ...buttonStyle, marginLeft: 4, padding: "2px 4px" }}
              title={t("files.clearClipboard")}
              onClick={() => setClipboard(null)}
            >
              <X size={12} />
            </button>
          </span>
        )}
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

      {search && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "4px 8px",
            fontSize: 12,
            borderBottom: border,
          }}
        >
          <span>
            {t("files.searchResults")} «{search.query}»: {items.length}
            {search.truncated ? "+" : ""}
          </span>
          <button
            type="button"
            style={buttonStyle}
            title={t("files.clearSearch")}
            onClick={clearSearch}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        onMouseDown={startBand}
        onContextMenu={(event) => openMenu(event, null)}
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
              {(
                [
                  ["name", "files.name", {}],
                  ["mode", "files.permissions", { width: 92 }],
                  ["size", "files.size", { width: 84, textAlign: "right" }],
                  ["mtime", "files.modified", { width: 150 }],
                ] as [SortKey, string, Record<string, unknown>][]
              ).map(([key, label, extra]) => (
                <th
                  key={key}
                  onClick={() => {
                    if (sortKey === key) setSortDesc((value) => !value);
                    else {
                      setSortKey(key);
                      setSortDesc(false);
                    }
                  }}
                  style={{ ...cell, ...extra, cursor: "pointer" }}
                >
                  {t(label)}
                  {sortKey === key &&
                    (sortDesc ? (
                      <ChevronDown size={11} />
                    ) : (
                      <ChevronUp size={11} />
                    ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={item.name}
                data-name={item.name}
                onClick={(event) => onRowClick(event, item)}
                onDoubleClick={() => open(item)}
                onContextMenu={(event) => openMenu(event, item)}
                draggable={selected.has(item.name)}
                onDragStart={(event) => {
                  const picked = selectedItems.map((i) =>
                    joinPath(pathRef.current, i.name),
                  );
                  dragPaths.current = picked;
                  event.dataTransfer.effectAllowed = "copyMove";
                  event.dataTransfer.setData("text/plain", picked.join("\n"));
                }}
                onDragEnd={() => {
                  dragPaths.current = null;
                  setDropTarget(null);
                }}
                onDragOver={(event) => {
                  if (!item.dir) return;
                  const internal = dragPaths.current;
                  const files = event.dataTransfer.types.includes("Files");
                  if (!internal && !files) return;
                  const here = joinPath(pathRef.current, item.name);
                  // Not onto itself or into its own contents.
                  if (
                    internal?.some(
                      (p) => here === p || here.startsWith(`${p}/`),
                    )
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = internal
                    ? event.ctrlKey
                      ? "copy"
                      : "move"
                    : "copy";
                  setDropTarget(item.name);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => {
                  if (!item.dir) return;
                  const here = joinPath(pathRef.current, item.name);
                  const internal = dragPaths.current;
                  setDropTarget(null);
                  if (internal) {
                    event.preventDefault();
                    event.stopPropagation();
                    dragPaths.current = null;
                    void moveInto(internal, here, event.ctrlKey);
                  } else if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    event.stopPropagation();
                    setDragging(false);
                    uploadDropped(event.dataTransfer, here);
                  }
                }}
                style={{
                  cursor: "default",
                  background:
                    dropTarget === item.name
                      ? "rgba(96,165,250,0.45)"
                      : selected.has(item.name)
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
                <td
                  title={
                    item.mtime
                      ? new Date(item.mtime * 1000).toLocaleString()
                      : undefined
                  }
                  style={{ ...cell, opacity: 0.8 }}
                >
                  {item.mtime ? shortDate(item.mtime) : ""}
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
                  onClick={() => {
                    const hook = cancelHooks.current.get(item.id);
                    if (hook) hook();
                    else clientRef.current?.cancel(item.id);
                  }}
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

      {info && (
        <div
          style={{
            display: "flex",
            gap: 12,
            padding: "4px 8px",
            borderTop: border,
            fontSize: 11,
            opacity: 0.75,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {deviceLine(info, t)}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** One line about the phone: name, Android version, battery and free space. */
export function deviceLine(
  info: DeviceInfo,
  t: (key: string) => string,
): string {
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
      `${t("files.free")} ${formatSize(info.freeBytes)} / ${formatSize(info.totalBytes)}`,
    );
  }
  return parts.join("  ·  ");
}
