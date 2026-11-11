// Auto quality step-down (#71). The engine notices frames that stay below 30 fps at full resolution and suggests the
// next lower preset; this applies it once per preset and says so in a toast you can click to undo. Undo (or picking
// a higher preset by hand afterwards) means "I prefer the looks": the device then never steps down on its own again.
// Never steps up: a laptop that was slow on battery stays at the lower preset until someone picks another.
import type { Quality } from '../core/types';
import { onQualityAdvice } from '../engine/frame-pacing';
import { deviceStorage } from './dom';
import type { Shell } from './shell';

export const AUTO_QUALITY_KEY = 'rlt.autoQuality';
const RANK: Record<Quality, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
const label = (q: Quality) => q[0].toUpperCase() + q.slice(1);

export interface AutoQualityDeps {
  quality(): Quality;
  /** Apply a preset without the usual "Graphics set to …" toast. */
  setQuality(q: Quality): void;
  toast(text: string, onClick?: () => void): void;
  /** Quality changes from anywhere (menu, palette, this module). */
  onQualityChange(fn: (q: Quality) => void): () => void;
  store: { get(key: string): string | null; set(key: string, value: string): void };
}

/** Returns the handler for one piece of engine advice (exported for tests). */
export function autoQuality(d: AutoQualityDeps): { advise(from: Quality, to: Quality): void; dispose(): void } {
  let auto: { from: Quality; to: Quality } | null = null;
  let applying = false;
  const optOut = () => d.store.set(AUTO_QUALITY_KEY, 'off');
  const off = d.onQualityChange((q) => {
    if (applying || !auto) return;
    if (RANK[q] > RANK[auto.to]) optOut(); // put the looks back by hand: respect that from now on
    auto = null;
  });
  return {
    advise(from, to) {
      if (d.store.get(AUTO_QUALITY_KEY) === 'off' || d.quality() !== from || RANK[to] >= RANK[from]) return;
      applying = true;
      try {
        d.setQuality(to);
      } finally {
        applying = false;
      }
      const step = { from, to };
      auto = step;
      // the whole text is the button (click or tap): no device-specific verb
      d.toast(`Graphics lowered to ${label(to)} to keep the town smooth. Undo`, () => {
        if (auto !== step || d.quality() !== to) return;
        optOut();
        applying = true;
        try {
          d.setQuality(from);
        } finally {
          applying = false;
        }
        auto = null;
        d.toast(`Graphics back to ${label(from)}. They won't be lowered automatically on this device again.`);
      });
    },
    dispose: off,
  };
}

export function installAutoQuality(shell: Shell): () => void {
  const a = autoQuality({
    quality: () => shell.quality,
    setQuality: (q) => shell.setQuality(q, { quiet: true }),
    toast: (text, onClick) => shell.toast('info', text, onClick ? { onClick, ttl: 12_000 } : undefined),
    onQualityChange: (fn) => shell.bus.on('quality:change', ({ quality }) => fn(quality)),
    store: deviceStorage,
  });
  const stop = onQualityAdvice(a.advise);
  return () => {
    stop();
    a.dispose();
  };
}
