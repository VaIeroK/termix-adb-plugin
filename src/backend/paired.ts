import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Remembers that this host's phone has accepted Termix, so a later failure to
 * connect is offered a new port, not a new pairing. Best effort.
 */
export async function markPaired(
  ctx: PluginContext,
  hostId: number,
): Promise<void> {
  try {
    if ((await ctx.settings.getHost<boolean>(hostId, "adbPaired")) === true) {
      return;
    }
    await ctx.settings.setHost(hostId, "adbPaired", true);
  } catch (error) {
    ctx.log.warn(
      `Could not remember the pairing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
