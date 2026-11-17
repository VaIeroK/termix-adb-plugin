import { describe, expect, it } from "vitest";
import { renderWithApp } from "@termix-ssh/plugin-sdk/testing";
import manifest from "../../manifest.json" with { type: "json" };
import * as plugin from "../../src/frontend/index.js";

const on = { id: 1, pluginSettings: { adb: { enableAdb: true } } };
const off = { id: 2, pluginSettings: { adb: { enableAdb: false } } };

describe("frontend", () => {
  it("registers the tab, the protocol and the connect action", async () => {
    const app = await renderWithApp(plugin, {
      pluginId: manifest.id,
      manifest: manifest as never,
    });
    expect(app.registered.tabs()).toContain("adb");
    expect(app.registered.hostProtocols()).toContain("adb");
    expect(app.registered.hostActions().map((a) => a.id)).toContain("adb");
  });

  it("offers Connect only on hosts that turned ADB on", async () => {
    const app = await renderWithApp(plugin, {
      pluginId: manifest.id,
      manifest: manifest as never,
    });
    expect(
      app.registered.hostActionsFor(on as never).map((a) => a.id),
    ).toContain("adb");
    expect(
      app.registered.hostActionsFor(off as never).map((a) => a.id),
    ).not.toContain("adb");
  });
});
