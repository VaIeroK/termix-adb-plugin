/**
 * Recent files, pinned files and folder shortcuts. The Termix file manager
 * keeps them on its server; here they stay in this browser, per host.
 */

export interface FileManagerEntry {
  id: number;
  name: string;
  path: string;
  lastOpened?: string;
}

type Kind = "recent" | "pinned" | "shortcuts";
const LIMIT: Record<Kind, number> = { recent: 20, pinned: 100, shortcuts: 100 };

const key = (kind: Kind, hostId: number) => `adb.fm.${kind}.${hostId}`;

function read(kind: Kind, hostId: number): FileManagerEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(key(kind, hostId)) ?? "[]");
    return Array.isArray(list) ? (list as FileManagerEntry[]) : [];
  } catch {
    return [];
  }
}

function write(kind: Kind, hostId: number, list: FileManagerEntry[]): void {
  try {
    localStorage.setItem(
      key(kind, hostId),
      JSON.stringify(list.slice(0, LIMIT[kind])),
    );
  } catch {
    // Not kept between visits.
  }
}

function add(kind: Kind, hostId: number, name: string, path: string) {
  const rest = read(kind, hostId).filter((e) => e.path !== path);
  write(kind, hostId, [
    { id: Date.now(), name, path, lastOpened: new Date().toISOString() },
    ...rest,
  ]);
}

function remove(kind: Kind, hostId: number, path: string) {
  write(
    kind,
    hostId,
    read(kind, hostId).filter((e) => e.path !== path),
  );
}

export async function getRecentFiles(
  hostId: number,
): Promise<FileManagerEntry[]> {
  return read("recent", hostId);
}
export async function addRecentFile(
  hostId: number,
  path: string,
  name?: string,
): Promise<void> {
  add("recent", hostId, name ?? path.split("/").pop() ?? path, path);
}
export async function removeRecentFile(
  hostId: number,
  path: string,
): Promise<void> {
  remove("recent", hostId, path);
}
export async function getPinnedFiles(
  hostId: number,
): Promise<FileManagerEntry[]> {
  return read("pinned", hostId);
}
export async function addPinnedFile(
  hostId: number,
  path: string,
  name?: string,
): Promise<void> {
  add("pinned", hostId, name ?? path.split("/").pop() ?? path, path);
}
export async function removePinnedFile(
  hostId: number,
  path: string,
): Promise<void> {
  remove("pinned", hostId, path);
}
export async function getFolderShortcuts(
  hostId: number,
): Promise<FileManagerEntry[]> {
  return read("shortcuts", hostId);
}
export async function addFolderShortcut(
  hostId: number,
  path: string,
  name?: string,
): Promise<void> {
  add("shortcuts", hostId, name ?? path.split("/").pop() ?? path, path);
}
export async function removeFolderShortcut(
  hostId: number,
  path: string,
): Promise<void> {
  remove("shortcuts", hostId, path);
}
