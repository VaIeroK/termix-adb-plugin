// The desktop app reports external editor saves here. A device has none.

export interface LocalEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: LocalEvent) => void;

export function subscribeLocalEvents(_listener: Listener): () => void {
  return () => {};
}
