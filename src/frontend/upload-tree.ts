/** What to send to the phone: files with their path inside the dropped folder. */
export interface UploadPlan {
  files: { rel: string; file: File }[];
  /** Folders to create, including empty ones. */
  dirs: string[];
}

const MAX_FILES = 20_000;

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: Entry[]) => void,
      fail: (error: unknown) => void,
    ) => void;
  };
}

/** Must run inside the drop event: the browser drops the list afterwards. */
export function entriesFromDrop(data: DataTransfer): Entry[] | null {
  const items = [...(data.items ?? [])];
  if (
    items.length === 0 ||
    !items.every((item) => "webkitGetAsEntry" in item)
  ) {
    return null;
  }
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry() as Entry | null)
    .filter((entry): entry is Entry => entry !== null);
  return entries.length > 0 ? entries : null;
}

async function readAll(entry: Entry): Promise<Entry[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) =>
      reader.readEntries(ok, fail),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

export async function planFromEntries(entries: Entry[]): Promise<UploadPlan> {
  const plan: UploadPlan = { files: [], dirs: [] };
  const walk = async (entry: Entry, prefix: string): Promise<void> => {
    if (plan.files.length > MAX_FILES) return;
    const rel = `${prefix}${entry.name}`;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((ok, fail) =>
        (entry.file as NonNullable<Entry["file"]>)(ok, fail),
      );
      plan.files.push({ rel, file });
    } else if (entry.isDirectory) {
      plan.dirs.push(rel);
      for (const child of await readAll(entry)) await walk(child, `${rel}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  if (plan.files.length > MAX_FILES) {
    throw new Error(`Too many files (over ${MAX_FILES})`);
  }
  return plan;
}

/** Files from a picker; a folder picker fills webkitRelativePath. */
export function planFromFiles(files: File[]): UploadPlan {
  const plan: UploadPlan = { files: [], dirs: [] };
  const dirs = new Set<string>();
  for (const file of files) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    plan.files.push({ rel, file });
    const cut = rel.lastIndexOf("/");
    if (cut > 0) dirs.add(rel.slice(0, cut));
  }
  plan.dirs = [...dirs];
  return plan;
}

/** The folders that have to be made: only the deepest, mkdir -p does the rest. */
export function leafDirs(plan: UploadPlan): string[] {
  const all = new Set(plan.dirs);
  for (const { rel } of plan.files) {
    const cut = rel.lastIndexOf("/");
    if (cut > 0) all.add(rel.slice(0, cut));
  }
  return [...all].filter(
    (dir) => ![...all].some((other) => other.startsWith(`${dir}/`)),
  );
}
