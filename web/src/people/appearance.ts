// Deterministic look per agent: which clothed Rocketbox avatar (from the seed and gender; helpers lean casual),
// plus the fallback-body outfit (vendor-tinted top, trousers, shoes, skin, hair) used only if the avatar fails to
// load. Same agent → same person, every visit. The vendor colour lives on the ring and tag, not the clothes.
import * as THREE from 'three';
import { VENDOR_COLORS, type AgentInfo, type Vendor } from '../../../shared/protocol';
import { AVATARS, type AvatarInfo } from './avatars';
import type { Gender, HairStyle } from './library';
import { mulberry32, pick } from './rng';

export type TopStyle = 'tee' | 'shirt' | 'cardigan' | 'hoodie' | 'jacket' | 'sweater';

export interface Look {
  gender: Gender;
  /** Rocketbox avatar id (AVATARS); null = the procedural fallback body. */
  avatar: string | null;
  skin: { light: boolean; tint: THREE.Color };
  hair: { style: HairStyle; color: THREE.Color; beard: boolean };
  top: { style: TopStyle; color: THREE.Color; inner: THREE.Color; longSleeves: boolean; tucked: boolean };
  bottom: { color: THREE.Color; denim: boolean; skirt: boolean };
  shoes: { color: THREE.Color; sole: THREE.Color; sneaker: boolean };
  height: number; // uniform scale around 1
}

const HAIR_COLORS = ['#1f1914', '#2e221a', '#4a3424', '#6b4a2f', '#8a6239', '#b88a55', '#d9b884', '#7a2f1e', '#5c5c5c', '#a9a29a'];
const SKIN_TINTS = [
  { light: true, tint: '#ffffff' }, { light: true, tint: '#f7e6d8' }, { light: false, tint: '#ffffff' },
  { light: false, tint: '#e3c4ac' }, { light: false, tint: '#b48a6e' }, { light: false, tint: '#8c6550' },
];
const TROUSERS = [
  { color: '#2f3d55', denim: true }, { color: '#3b4b66', denim: true }, { color: '#2b2b2e', denim: false },
  { color: '#3a3937', denim: false }, { color: '#b7a17e', denim: false }, { color: '#5e5a4f', denim: false },
];

const VENDOR_STYLES: Record<Vendor, TopStyle[]> = {
  anthropic: ['cardigan', 'sweater', 'cardigan', 'tee'],
  openai: ['shirt', 'jacket', 'shirt', 'tee'],
  deepseek: ['jacket', 'shirt', 'hoodie', 'tee'],
  google: ['hoodie', 'sweater', 'tee', 'cardigan'],
  openrouter: ['tee', 'hoodie', 'shirt'],
  other: ['tee', 'sweater', 'shirt'],
};

export interface LookOptions {
  /** Avatar ids already used nearby (the house): picked only when every other one is taken too. */
  avoid?: ReadonlySet<string>;
  /** Force a specific avatar (e.g. the player's chosen look). */
  avatar?: string;
}

/** Avatars of a gender in this seed's preference order (helpers: casual outfits first). */
export function avatarOrder(seed: number, gender: Gender, kind?: AgentInfo['kind']): AvatarInfo[] {
  const r = mulberry32(seed * 2654435761 + 7);
  const pool = AVATARS.filter((a) => a.gender === gender).map((a) => ({ a, k: r() + (kind === 'subagent' && a.style !== 'casual' ? 1 : 0) }));
  return pool.sort((x, y) => x.k - y.k).map((x) => x.a);
}

export function lookForAgent(agent: Pick<AgentInfo, 'vendor' | 'appearance' | 'kind'>, opts: LookOptions = {}): Look {
  const r = mulberry32(agent.appearance.seed * 7919 + 17);
  const gender = agent.appearance.gender;
  const order = avatarOrder(agent.appearance.seed, gender, agent.kind);
  const forced = opts.avatar ? AVATARS.find((a) => a.id === opts.avatar) : undefined;
  const avatar = forced ?? order.find((a) => !opts.avoid?.has(a.id)) ?? order[0];
  const vendor = agent.vendor;
  const base = new THREE.Color(VENDOR_COLORS[vendor] ?? VENDOR_COLORS.other);
  // vendor color variant: small lightness/saturation shifts so a team of the same vendor differs
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const top = new THREE.Color().setHSL(hsl.h + (r() - 0.5) * 0.02, THREE.MathUtils.clamp(hsl.s * (0.75 + r() * 0.3), 0, 1), THREE.MathUtils.clamp(hsl.l * (0.85 + r() * 0.3), 0.12, 0.72));
  const style = agent.kind === 'subagent' ? pick(r, ['tee', 'hoodie', 'tee'] as TopStyle[]) : pick(r, VENDOR_STYLES[vendor] ?? VENDOR_STYLES.other);
  const inner = new THREE.Color(pick(r, ['#f1ece2', '#e9e4da', '#f6f3ee', '#2c2c2e', '#d8d3c8']));
  const tr = pick(r, TROUSERS);
  const skin = pick(r, SKIN_TINTS);
  const hairStyles: HairStyle[] = gender === 'f' ? ['Hair_Long', 'Hair_Buns', 'Hair_Long', 'Hair_BuzzedFemale'] : ['Hair_SimpleParted', 'Hair_Buzzed', 'Hair_SimpleParted'];
  const sneaker = r() < 0.55;
  return {
    gender: forced?.gender ?? gender,
    avatar: avatar?.id ?? null,
    skin: { light: skin.light, tint: new THREE.Color(skin.tint) },
    hair: { style: pick(r, hairStyles), color: new THREE.Color(pick(r, HAIR_COLORS)), beard: gender === 'm' && r() < 0.35 },
    top: {
      style,
      color: top,
      inner,
      longSleeves: style === 'shirt' ? r() < 0.7 : style === 'tee' ? false : true,
      tucked: style === 'shirt' && r() < 0.6,
    },
    bottom: { color: new THREE.Color(tr.color), denim: tr.denim, skirt: gender === 'f' && !tr.denim && r() < 0.25 },
    shoes: sneaker ? sneakerColors(r) : leatherColors(r),
    // avatars carry their own natural height: only a small per-person spread on top
    height: avatar ? 1 + (r() - 0.5) * 0.03 : (gender === 'f' ? 0.985 : 0.995) + (r() - 0.5) * 0.04,
  };
}

/** Look for a given avatar id (player look picker); the seed only varies the fallback outfit. */
export function lookForAvatar(avatarId: string, seed = 1): Look {
  const info = AVATARS.find((a) => a.id === avatarId) ?? AVATARS[0];
  return { ...lookForAgent({ vendor: 'other', kind: 'resident', appearance: { seed, gender: info?.gender ?? 'f' } }, { avatar: info?.id }), height: 1 };
}

const SNEAKERS: [string, string][] = [
  ['#f1efe9', '#9c9488'], // white upper, warm grey sole
  ['#2a2b2e', '#f1efe9'], // black upper, white sole
  ['#b9c4cc', '#f1efe9'], // cool grey
  ['#7b2d28', '#f1efe9'], // oxblood
  ['#f1efe9', '#2c2c2c'], // white upper, black sole
  ['#3a4a5e', '#e9e5dc'], // navy
];
const LEATHER = ['#2a1c14', '#191716', '#3a2618', '#211d1b'];

function sneakerColors(r: () => number): Look['shoes'] {
  const [upper, sole] = pick(r, SNEAKERS);
  return { color: new THREE.Color(upper), sole: new THREE.Color(sole), sneaker: true };
}

function leatherColors(r: () => number): Look['shoes'] {
  return { color: new THREE.Color(pick(r, LEATHER)), sole: new THREE.Color('#141110'), sneaker: false };
}
