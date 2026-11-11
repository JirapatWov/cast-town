// Static (merged) plant geometry for planters, balconies and roof terraces — geometry that moves with a building's
// storeys and roof, so it can't live in the instanced tree system. LOD1 cards, no wind, cached per species.
import type * as THREE from 'three';
import { buildTreeGeometries, growTree } from './generator';
import { SPECIES, type SpeciesId } from './species';

const cache = new Map<SpeciesId, { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry; leafColor: [number, number, number] }>();

export function staticPlant(species: SpeciesId): { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry; leafColor: [number, number, number] } {
  let g = cache.get(species);
  if (!g) {
    const def = SPECIES[species];
    const raw = growTree(def.variants[0]);
    const lod = { ...def.lod1, keep: Math.min(1, def.lod1.keep * 1.6) };
    const t = buildTreeGeometries(raw, def.height, lod, def.variants[0].seed);
    g = { bark: t.bark, leaves: t.leaves, leafColor: def.leafColor };
    cache.set(species, g);
  }
  return g;
}
