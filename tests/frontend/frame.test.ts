import { describe, expect, it } from "vitest";
import { checkFrameApp, checkFrameViews } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

const options = { manifest: manifest as unknown as Record<string, unknown> };

describe("sandboxed frame", () => {
  it("registers nothing the shell can't take from a frame", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, options);
    expect(problems).toEqual([]);
    expect(registrations.length).toBeGreaterThan(0);
  });

  it("asks core only for what a frame may reach", async () => {
    const { refused } = await checkFrameViews(plugin, {
      ...options,
      hosts: [
        {
          id: 1,
          name: "TV",
          ip: "192.0.2.10",
          port: 22,
          username: "",
          folder: "",
          tags: [],
          pluginSettings: { adb: { enableAdb: true } },
        },
      ],
    });
    // The check renders views against the web app's own wsUrl, which asks for
    // a socket ticket. In a real frame wsUrl is answered inside the frame
    // (token in the WebSocket protocols), so that one request is not ours.
    expect(refused.filter((r) => r !== "POST /users/ws-ticket")).toEqual([]);
  });
});
