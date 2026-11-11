// Board or 3D town. The Town board (2D) is a first-class way to use CAST — keyboard and screen-reader friendly, fast
// on old laptops and VMs — not a fallback: the choice is remembered per device, and a board start skips the 3D
// download and build entirely (main.ts loads the town only when someone switches to 3D).
//
// A 3D start opens on the board too when the town takes more than a moment: the board stands in while the town
// builds and the town takes over when ready (`wanted`), unless the board is picked meanwhile.
//
// The 3D state is shared by main.ts (which loads the town) and the UI (the view switch, the board's copy):
//   idle        3D can be loaded but isn't yet (started on the board)
//   loading     the town is being built (progress 0..1)
//   ready       3D is on hand
//   unavailable this browser can't show 3D (no WebGL, or the build failed): the board is all there is
import { deviceStorage } from './dom';

export const BOARD_KEY = 'rlt.view.board';

export type ThreeD = 'idle' | 'loading' | 'ready' | 'unavailable';

/** `?2d` / `?board` start on the board for this visit, `?3d` in 3D; null when the address says nothing. */
export function viewFromSearch(search: string): 'board' | '3d' | null {
  const q = new URLSearchParams(search);
  if (q.has('2d') || q.has('board')) return 'board';
  if (q.has('3d')) return '3d';
  const v = q.get('view');
  return v === 'board' || v === '2d' ? 'board' : v === '3d' ? '3d' : null;
}

/** The address without what asks for a board start (`?2d`, `?board`, `?view=board`): reloading into 3D. */
export function searchWithoutBoard(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('2d');
  q.delete('board');
  if (viewFromSearch(`?view=${q.get('view') ?? ''}`) === 'board') q.delete('view');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Start on the board: the address decides for one visit, else the remembered choice, else the screen — a phone
 *  starts on the board (the town is megabytes of files and seconds of graphics work) until someone picks 3D. */
export function startOnBoard(search: string, stored: string | null, phone = false): boolean {
  const asked = viewFromSearch(search);
  if (asked) return asked === 'board';
  if (stored === '1' || stored === '0') return stored === '1';
  return phone;
}

export function boardRemembered(): string | null {
  return deviceStorage.get(BOARD_KEY);
}

export function rememberBoard(on: boolean): void {
  deviceStorage.set(BOARD_KEY, on ? '1' : '0');
}

/** Cheap check that this browser can make a WebGL context at all (the board start never builds the engine). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // give the context back right away
    return true;
  } catch {
    return false;
  }
}

/** Share of the town's loading its files get (boot.ts townProgress); the rest is building it and getting the graphics
 *  ready, which has no number. */
export const TOWN_FILES_SHARE = 0.85;

let state: ThreeD = 'ready';
let progress = 0;
let working = false;
let wanted = false;
let loader: (() => void) | null = null;
const listeners = new Set<() => void>();

export const threeD = {
  get state(): ThreeD {
    return state;
  },
  /** 0..1 while loading (boot.ts townProgress: never backwards). */
  get progress(): number {
    return progress;
  },
  /** While loading: nothing measurable is moving (building the town, getting the graphics ready) — say "still
   *  working" rather than show a frozen number (#67). */
  get working(): boolean {
    return working;
  },
  set(next: ThreeD, p = next === 'ready' ? 1 : 0, w = false): void {
    if (next === state && p === progress && w === working) return;
    state = next;
    progress = p;
    working = next === 'loading' && w;
    for (const fn of listeners) fn();
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Switch to the town as soon as it is ready: someone asked for 3D before it was loaded, or a 3D start opened on
   *  the board while the town builds (main.ts). Picking the board clears it. */
  get wanted(): boolean {
    return wanted;
  },
  want(on: boolean): void {
    wanted = on;
  },
  /** main.ts: how to build the town on request. */
  setLoader(fn: () => void): void {
    loader = fn;
  },
  /** The UI asks for 3D: start building the town (once). */
  load(): void {
    if (state === 'idle') loader?.();
  },
};
