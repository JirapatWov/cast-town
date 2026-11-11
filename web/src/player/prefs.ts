// The homeowner's settings (per browser): show the avatar in houses, which look, and whether WASD walks.
// Plain data + change notifications, no three.js — the settings UI imports it without pulling in the renderer.
// Looks are the people builder's clothed avatars (people/avatars.ts, plain data).
// Portraits of the looks are rendered by the 3D side when it runs; the UI asks for them through here.

import { AVATARS } from '../people/avatars';
import { deviceStorage } from '../ui/dom';

export interface PlayerPrefs {
  /** Show me (the homeowner avatar) in the house and by its door in the city. */
  show: boolean;
  /** Avatar id of my look (one of PLAYER_LOOKS). */
  look: string;
  /** W/A/S/D walk while the 3D view has focus (arrow keys always do). Off by default: W, A and D are UI shortcuts. */
  wasd: boolean;
}

export interface LookPreset {
  /** The people builder's avatar id (clothed Rocketbox person). */
  id: string;
  gender: 'm' | 'f';
  /** What they wear, for the picker's labels. */
  label: string;
}

/** Every clothed person the people builder ships, women first. */
export const PLAYER_LOOKS: LookPreset[] = [...AVATARS]
  .sort((a, b) => (a.gender === b.gender ? 0 : a.gender === 'f' ? -1 : 1))
  .map((a) => ({ id: a.id, gender: a.gender, label: a.label }));

const DEFAULT_LOOK = PLAYER_LOOKS.find((l) => l.id === 'f07')?.id ?? PLAYER_LOOKS[0]?.id ?? '';

export function lookIndex(id: string): number {
  return Math.max(0, PLAYER_LOOKS.findIndex((l) => l.id === id));
}

const KEY = 'rlt.player.v1';
const DEFAULTS: PlayerPrefs = { show: true, look: DEFAULT_LOOK, wasd: false };

type Listener = (p: PlayerPrefs, prev: PlayerPrefs) => void;
/** Renders portraits of looks (registered by the 3D side). */
export interface PortraitProvider {
  get(look: string): Promise<string | null>;
  /** Drop the looks still waiting (the picker closed). */
  cancel(): void;
}

function load(): PlayerPrefs {
  try {
    const raw = deviceStorage.get(KEY); // the homeowner is the same person in every city
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<PlayerPrefs>;
    return {
      show: typeof v.show === 'boolean' ? v.show : DEFAULTS.show,
      look: typeof v.look === 'string' && PLAYER_LOOKS.some((l) => l.id === v.look) ? v.look : DEFAULTS.look,
      wasd: typeof v.wasd === 'boolean' ? v.wasd : DEFAULTS.wasd,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();
const listeners = new Set<Listener>();
let portraits: PortraitProvider | null = null;

export const playerPrefs = {
  get(): PlayerPrefs {
    return current;
  },
  set(patch: Partial<PlayerPrefs>) {
    const prev = current;
    const next = { ...current, ...patch };
    if (next.show === prev.show && next.look === prev.look && next.wasd === prev.wasd) return;
    current = next;
    deviceStorage.set(KEY, JSON.stringify(next)); // private window / blocked storage: the setting lasts for this visit
    for (const fn of listeners) fn(next, prev);
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** The 3D side registers how to render a look's portrait (data URL), when it can. */
  setPortraitProvider(fn: PortraitProvider | null) {
    portraits = fn;
  },
  portrait(look: string): Promise<string | null> {
    return portraits ? portraits.get(look).catch(() => null) : Promise.resolve(null);
  },
  cancelPortraits() {
    portraits?.cancel();
  },
  /** True when a 3D avatar exists to show (WebGL is up). The settings UI hides itself otherwise. */
  get available(): boolean {
    return portraits !== null;
  },
};
