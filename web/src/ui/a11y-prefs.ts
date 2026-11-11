// Per-device accessibility preferences (Settings → Accessibility), shared by every city like the other device prefs.
//   terminal reader: xterm's screen-reader mode — the shell's output is mirrored into a hidden list a screen reader
//     reads. Off by default: it costs time on big outputs, and nothing can tell whether a reader is running.
//   solid panels: no see-through glass behind text (also automatic with the OS's "reduce transparency" or
//     "more contrast").
import { deviceStorage } from './dom';

export type A11yPref = 'termReader' | 'solid';

const KEYS: Record<A11yPref, string> = {
  termReader: 'rlt.a11y.termReader',
  solid: 'rlt.a11y.solid',
};

const listeners = new Set<(pref: A11yPref, on: boolean) => void>();

export function a11yPref(pref: A11yPref): boolean {
  return deviceStorage.get(KEYS[pref]) === '1';
}

export function setA11yPref(pref: A11yPref, on: boolean): void {
  deviceStorage.set(KEYS[pref], on ? '1' : '0');
  for (const fn of listeners) fn(pref, on);
}

/** Called after any change. Returns unsubscribe. */
export function onA11yPref(fn: (pref: A11yPref, on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
