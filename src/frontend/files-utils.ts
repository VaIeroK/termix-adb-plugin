import type { FileItem } from "./files-client";

/** Where the file manager starts: the phone's shared storage. */
export const START_PATH = "/sdcard";

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export type SortKey = "name" | "mode" | "size" | "mtime";

/** Folders first, then by the chosen column; names compare case blind. */
export function sortItems(
  items: FileItem[],
  key: SortKey = "name",
  descending = false,
): FileItem[] {
  const byName = (a: FileItem, b: FileItem) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const direction = descending ? -1 : 1;
  return [...items].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const diff = key === "name" ? byName(a, b) : a[key] - b[key];
    return diff !== 0 ? diff * direction : byName(a, b);
  });
}

/** Permission bits as "rwxr-xr--". */
export function modeText(mode: number): string {
  return [..."rwxrwxrwx"]
    .map((c, i) => (mode & (1 << (8 - i)) ? c : "-"))
    .join("");
}

/** Permission bits as octal digits, like "644". */
export function modeOctal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** "20.08.24, 16:59": short enough for the narrow column, locale order. */
export function shortDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
