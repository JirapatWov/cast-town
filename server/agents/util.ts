// Small helpers shared by the agent system modules.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** FNV-1a 32-bit hash — deterministic appearance seeds and short ids. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Keeps the *end* of a long string (useful for stderr tails). */
export function tail(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(s.length - max + 1)}`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

let idCounter = 0;
/** Short unique id: `<prefix>-<time36><counter36>`. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_679_616;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`;
}

export function log(scope: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${scope.padEnd(6)}`, ...args);
}

/** Per-key trailing-edge debounce. */
export class KeyedDebouncer {
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly ms: number) {}
  schedule(key: string, fn: () => void): void {
    const t = this.#timers.get(key);
    if (t) clearTimeout(t);
    this.#timers.set(key, setTimeout(() => {
      this.#timers.delete(key);
      fn();
    }, this.ms));
  }
  cancelAll(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }
}

/** "RouteReviewer" / "route-reviewer" → "Route Reviewer". */
export function humanize(id: string): string {
  const spaced = id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Array.prototype.findLastIndex without needing the ES2023 lib. */
export function findLastIndex<T>(arr: readonly T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}
