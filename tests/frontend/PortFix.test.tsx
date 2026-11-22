import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: {
    values: {} as Record<string, unknown>,
    loaded: true,
    save: vi.fn(async () => undefined),
  },
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  useSettings: () => h.settings,
}));

import { PortFix } from "../../src/frontend/PortFix.js";

describe("PortFix", () => {
  it("offers nothing until the phone has been paired once", () => {
    h.settings.values = { adbPort: 5555 };
    const view = render(<PortFix hostId="5" onSaved={() => undefined} />);
    expect(view.container.firstChild).toBeNull();
  });

  it("saves the new port next to the other settings and reconnects", async () => {
    h.settings.values = { enableAdb: true, adbPort: 5555, adbPaired: true };
    const onSaved = vi.fn();
    const view = render(<PortFix hostId="5" onSaved={onSaved} />);
    const input = view.getByLabelText("adb.newPort");
    fireEvent.change(input, { target: { value: "41234x" } });
    fireEvent.click(view.getByText("adb.savePort"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(h.settings.save).toHaveBeenCalledWith({
      enableAdb: true,
      adbPort: 41234,
      adbPaired: true,
    });
  });
});
