import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    selection = "";
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    paste = vi.fn();
    focus = vi.fn();
    loadAddon() {}
    open() {}
    reset() {}
    write() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    hasSelection() {
      return this.selection !== "";
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = "";
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
  }
  return { terminals: [] as FakeTerminal[], FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class extends h.FakeTerminal {
    constructor() {
      super();
      h.terminals.push(this);
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css?inline", () => ({ default: "" }));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/frontend/app", () => ({
  shellSocketUrl: async () => null,
}));

import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { AdbTab } from "../../src/frontend/AdbTab.js";

function mount() {
  const props = {
    host: { id: 5 },
    isVisible: true,
    isFocusedPane: true,
    handleRef: createRef(),
  } as unknown as TabProps;
  const view = render(<AdbTab {...props} />);
  const term = h.terminals.at(-1)!;
  // The xterm container is the wrapper's first child.
  const container = view.container.firstElementChild!.firstElementChild!;
  return { view, term, container };
}

function key(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  return event;
}

beforeEach(() => {
  h.terminals.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe("AdbTab paste and copy", () => {
  it("lets Ctrl+V, Cmd+V and Shift+Insert reach the browser's paste", () => {
    const { term } = mount();
    for (const init of [
      { key: "v", ctrlKey: true },
      { key: "v", metaKey: true },
      { key: "Insert", shiftKey: true },
    ]) {
      const event = key(init);
      expect(term.keyHandler!(event)).toBe(false);
      // Not cancelled, or the browser would never fire its paste event.
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("pastes once from the paste event, even if it fires twice", () => {
    const { term, container } = mount();
    const send = () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { getData: () => "ls -la" },
      });
      container.dispatchEvent(event);
    };
    send();
    send();
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(term.paste).toHaveBeenCalledWith("ls -la");
  });

  it("Ctrl+Shift+V reads the clipboard and pastes", async () => {
    const readText = vi.fn().mockResolvedValue("pm list packages");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { term } = mount();
    const event = key({ key: "V", ctrlKey: true, shiftKey: true });
    expect(term.keyHandler!(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(term.paste).toHaveBeenCalledWith("pm list packages"),
    );
  });

  it("right click and middle click paste instead of opening a menu", async () => {
    const readText = vi.fn().mockResolvedValue("ls");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { term, container } = mount();

    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith("ls"));

    term.paste.mockClear();
    await new Promise((r) => setTimeout(r, 350));
    container.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledWith("ls"));

    // One tap reported as button 2 down, up and contextmenu pastes once.
    term.paste.mockClear();
    await new Promise((r) => setTimeout(r, 350));
    container.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 }),
    );
    container.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(term.paste).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(term.paste).toHaveBeenCalledTimes(1);
  });

  it("right click copies a selection instead of pasting", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("old clipboard");
    vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
    const { term, container } = mount();
    term.selection = "selected text";

    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("selected text");
    expect(term.hasSelection()).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(readText).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("Ctrl+C copies a selection and otherwise interrupts", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { term } = mount();

    expect(term.keyHandler!(key({ key: "c", ctrlKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    term.selection = "hello";
    expect(term.keyHandler!(key({ key: "c", ctrlKey: true }))).toBe(false);
    expect(writeText).toHaveBeenCalledWith("hello");
    // Copying drops the selection, so the next Ctrl+C interrupts again.
    expect(term.hasSelection()).toBe(false);
    expect(term.keyHandler!(key({ key: "c", ctrlKey: true }))).toBe(true);

    term.selection = "";
    expect(
      term.keyHandler!(key({ key: "C", ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("ignores key releases and plain typing", () => {
    const { term } = mount();
    expect(
      term.keyHandler!(new KeyboardEvent("keyup", { key: "v", ctrlKey: true })),
    ).toBe(true);
    expect(term.keyHandler!(key({ key: "a" }))).toBe(true);
  });
});

describe("AdbTab focus", () => {
  it("focuses the terminal on a click, also in a split", () => {
    const { view, term } = mount();
    term.focus.mockClear();
    fireEvent.mouseDown(view.container.firstElementChild!);
    expect(term.focus).toHaveBeenCalledTimes(1);
  });

  it("focuses a visible, focused pane even when it is in a split", () => {
    const { term } = mount();
    expect(term.focus).toHaveBeenCalled();
  });
});
