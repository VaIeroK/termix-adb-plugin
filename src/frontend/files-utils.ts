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

/** Folders first, then by name, case blind. */
export function sortItems(items: FileItem[]): FileItem[] {
  return [...items].sort((a, b) =>
    a.dir === b.dir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.dir
        ? -1
        : 1,
  );
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
