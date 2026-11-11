// The only place the player touches the people builder's API (library, look, character factory, animator, arm
// overlay). If that API changes, this file is the one to adapt.
import * as THREE from 'three';
import type { Assets, Quality } from '../core/types';
import { Animator } from '../people/animator';
import { lookForAvatar } from '../people/appearance';
import { loadCharacter, type Character } from '../people/character';
import { loadCharacterLibrary, type CharacterLibrary } from '../people/library';
import { reserveAvatars } from '../people/manager';
import { ArmOverlay } from '../people/typing';

export interface PlayerBody {
  ch: Character;
  anim: Animator;
  arms: ArmOverlay | null;
  height: number;
  /** Ground speed of Walk_Loop at timeScale 1 for this body (m/s). */
  walkSpeed: number;
  /** World position of the head (for the "you" chip), or null when the rig has no such bone. */
  head(out: THREE.Vector3): THREE.Vector3 | null;
  has(clip: string): boolean;
  dispose(): void;
  /** Free the GPU copies of this body's shared textures and meshes when nothing had loaded the avatar before us
   *  (portraits of looks nobody wears). Safe at any time: three uploads them again if anyone draws them later. */
  releaseGpu(): void;
}

let lib: Promise<CharacterLibrary> | null = null;

/** Keep residents out of my look (they pick their avatars around it). */
export function reserveLook(avatarId: string | null) {
  reserveAvatars(avatarId ? [avatarId] : []);
}

export function characterLibrary(assets: Assets, quality?: () => Quality): Promise<CharacterLibrary> {
  lib ??= loadCharacterLibrary(assets, quality);
  return lib;
}

/** Seed for the fallback outfit only (the avatar decides the clothes): fixed, so the homeowner never changes. */
const SEED = 424_242;

export async function createPlayerBody(assets: Assets, avatarId: string, quality?: () => Quality): Promise<PlayerBody> {
  const library = await characterLibrary(assets, quality);
  const look = lookForAvatar(avatarId, SEED);
  const fresh = !library.peek(look);
  const ch = await loadCharacter(library, look);
  const height = typeof look.height === 'number' ? look.height : 1;
  const anim = new Animator(ch.model, ch.entry.clips, height);
  let arms: ArmOverlay | null = null;
  try {
    arms = new ArmOverlay(ch, SEED, height);
  } catch {
    arms = null; // a rig without the expected arm bones: no typing overlay
  }
  let headBone: THREE.Object3D | null = null;
  try {
    headBone = ch.bone('Head');
  } catch {
    headBone = null;
  }
  ch.model.traverse((o) => {
    o.userData.rltPlayer = true;
  });
  const walk = anim.info('Walk_Loop') as { speed?: number } | undefined;
  return {
    ch,
    anim,
    arms,
    height,
    walkSpeed: (walk?.speed ?? 0.93) * height,
    head(out) {
      if (!headBone) return null;
      return headBone.getWorldPosition(out);
    },
    has: (clip) => !!anim.info(clip),
    dispose() {
      anim.dispose();
      ch.dispose();
    },
    releaseGpu() {
      if (fresh) releaseScene(ch.entry.scene);
    },
  };
}

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap'] as const;

function releaseScene(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as THREE.MeshStandardMaterial;
      for (const k of TEXTURE_SLOTS) std[k]?.dispose();
    }
  });
}
