// The 3D town is on show (main.ts says so once, on either way in). What the town doesn't need for its first look —
// the sharp 2k sky, the parked car — waits for this and a moment more, so it never competes with the town's own
// files and first frames for the line or the main thread. A timer, not requestIdleCallback: while a slow GPU draws
// the town, Chrome held idle callbacks for 35 s past their timeout.
const AFTER_MS = 1500;

let shown = false;
const waiting: (() => void)[] = [];

/** main.ts: the town is drawn and the splash lifts (or it took over from the board). */
export function townShown(): void {
  if (shown) return;
  shown = true;
  performance.mark('cast:town-ready'); // User Timing: what the first visit cost up to here (devtools, QA scripts)
  for (const fn of waiting.splice(0)) setTimeout(fn, AFTER_MS);
}

/** Run `fn` shortly after the town is on show. */
export function afterTownShown(fn: () => void): void {
  if (shown) setTimeout(fn, AFTER_MS);
  else waiting.push(fn);
}
