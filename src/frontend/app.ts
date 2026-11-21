import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

let current: TermixApp | null = null;

export function setAdbApp(app: TermixApp | null): void {
  current = app;
}

export function adbApp(): TermixApp {
  if (!current) throw new Error("ADB plugin is not active");
  return current;
}

/** The URL of the shell socket for one host, with the auth the app adds. */
export async function shellSocketUrl(
  hostId: string,
  cols: number,
  rows: number,
): Promise<{ url: string; protocols?: string[] } | null> {
  const target = await adbApp().wsUrl("/shell");
  if (!target) return null;
  const url = new URL(target.url);
  url.searchParams.set("hostId", hostId);
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  return { url: url.toString(), protocols: target.protocols };
}

/** The URL of the pairing socket for one host. */
export async function pairSocketUrl(
  hostId: string,
): Promise<{ url: string; protocols?: string[] } | null> {
  const target = await adbApp().wsUrl("/pair");
  if (!target) return null;
  const url = new URL(target.url);
  url.searchParams.set("hostId", hostId);
  return { url: url.toString(), protocols: target.protocols };
}
