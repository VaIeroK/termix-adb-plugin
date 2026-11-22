import { describe, expect, it } from "vitest";
import {
  leafDirs,
  planFromEntries,
  planFromFiles,
} from "../../src/frontend/upload-tree.js";
import { sortItems } from "../../src/frontend/files-utils.js";

function file(name: string, rel = "", size = 1): File {
  const made = new File(["x".repeat(size)], name);
  if (rel) Object.defineProperty(made, "webkitRelativePath", { value: rel });
  return made;
}

// A stand-in for the browser's FileSystemEntry tree.
function fakeFile(name: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(file(name)),
  };
}
function fakeDir(name: string, children: unknown[]) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let given = false;
      return {
        readEntries: (ok: (e: unknown[]) => void) => {
          ok(given ? [] : children);
          given = true;
        },
      };
    },
  };
}

describe("upload plans", () => {
  it("keeps folder paths from a folder picker", () => {
    const plan = planFromFiles([
      file("a.txt", "Pics/a.txt"),
      file("b.txt", "Pics/sub/b.txt"),
      file("c.txt"),
    ]);
    expect(plan.files.map((f) => f.rel)).toEqual([
      "Pics/a.txt",
      "Pics/sub/b.txt",
      "c.txt",
    ]);
    expect(leafDirs(plan)).toEqual(["Pics/sub"]);
  });

  it("walks a dropped folder, empty folders included", async () => {
    const tree = fakeDir("Top", [
      fakeFile("one.txt"),
      fakeDir("Empty", []),
      fakeDir("Deep", [fakeFile("two.txt")]),
    ]);
    const plan = await planFromEntries([tree as never]);
    expect(plan.files.map((f) => f.rel).sort()).toEqual([
      "Top/Deep/two.txt",
      "Top/one.txt",
    ]);
    expect(leafDirs(plan).sort()).toEqual(["Top/Deep", "Top/Empty"]);
  });
});

describe("sortItems", () => {
  const item = (name: string, size: number, dir = false) => ({
    name,
    size,
    dir,
    mode: 0o644,
    mtime: size,
    link: false,
  });
  it("keeps folders first and flips with descending", () => {
    const list = [item("b", 5), item("D", 0, true), item("a", 9)];
    expect(sortItems(list, "size").map((i) => i.name)).toEqual(["D", "b", "a"]);
    expect(sortItems(list, "size", true).map((i) => i.name)).toEqual([
      "D",
      "a",
      "b",
    ]);
    expect(sortItems(list).map((i) => i.name)).toEqual(["D", "a", "b"]);
  });
});
