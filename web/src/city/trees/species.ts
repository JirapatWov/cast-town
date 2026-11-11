// Tree and shrub species for the town. Branching parameters start from EZ-Tree presets (MIT, Daniel Greenheck;
// their units are arbitrary — every variant is rescaled to `height` metres) and were tuned for street trees seen
// from the city camera: fewer, larger sprig cards; LOD0 ≈ 4–6k triangles, LOD1 ≈ 1k, far ≈ 100.
import type { LodSpec, TreeParams } from './generator';
import type { BarkType, LeafType } from './materials';

export type SpeciesId = 'oak' | 'ash' | 'aspen' | 'poplar' | 'pine' | 'shrub';

export interface SpeciesDef {
  id: SpeciesId;
  /** Variants (different seeds/shapes) — instances pick one at random. */
  variants: TreeParams[];
  leaf: LeafType;
  bark: BarkType;
  /** Height in metres at instance scale 1. */
  height: number;
  lod0: LodSpec;
  lod1: LodSpec;
  /** Far-LOD atlas tile (0 oak, 1 ash, 2 pine, 3 aspen), clump count and clump size relative to the crown radius. */
  far: { tile: number; clusters: number; size: number };
  /** Linear multiplier on the leaf texture (the sprig photos are bright yellow-green). */
  leafColor: [number, number, number];
  /** Back-light glow. */
  translucency: number;
}

type Arr = number[];
const P = (o: {
  seed: number; type: 'deciduous' | 'evergreen'; levels: number; angle: Arr; children: Arr; gnarliness: Arr; length: Arr; radius: Arr;
  sections: Arr; segments: Arr; start: Arr; taper: Arr; twist: Arr; force: number;
  leaves: { count: number; start: number; size: number; sizeVariance: number; angle: number };
}): TreeParams => ({
  ...o, force: { direction: [0, 1, 0], strength: o.force }, leaves: { ...o.leaves, double: true },
});

const OAK_A = P({
  seed: 35729, type: 'deciduous', levels: 3, angle: [0, 54, 58, 32], children: [6, 4, 3], gnarliness: [0, -0.1, -0.15, 0.09],
  length: [37.24, 11.08, 12.39, 7.16], radius: [1.41, 0.9, 0.69, 1.19], sections: [8, 6, 3, 1], segments: [7, 5, 3, 3],
  start: [0, 0.49, 0.06, 0.12], taper: [0.73, 0.42, 0.69, 0.75], twist: [-0.23, 0.42, 0, 0], force: -0.01,
  leaves: { count: 9, start: 0.16, size: 3.6, sizeVariance: 0.5, angle: 42 },
});
const OAK_B = P({
  seed: 51013, type: 'deciduous', levels: 3, angle: [0, 50, 52, 36], children: [7, 4, 3], gnarliness: [0.02, 0.12, -0.1, 0.09],
  length: [33, 14, 11, 7], radius: [1.5, 0.82, 0.7, 1.1], sections: [8, 6, 3, 1], segments: [7, 5, 3, 3],
  start: [0, 0.42, 0.1, 0.12], taper: [0.73, 0.42, 0.69, 0.75], twist: [0.15, -0.3, 0, 0], force: -0.015,
  leaves: { count: 8, start: 0.16, size: 3.8, sizeVariance: 0.5, angle: 40 },
});
const ASH_A = P({
  seed: 36330, type: 'deciduous', levels: 3, angle: [0, 48, 75, 60], children: [7, 4, 3], gnarliness: [0.03, 0.25, 0.2, 0.09],
  length: [43.47, 27.14, 9.51, 4.6], radius: [2.0, 0.63, 0.76, 0.7], sections: [10, 6, 4, 2], segments: [8, 5, 3, 3],
  start: [0, 0.23, 0.33, 0], taper: [0.7, 0.7, 0.7, 0.7], twist: [0.09, -0.07, 0, 0], force: -0.06,
  leaves: { count: 8, start: 0, size: 3.9, sizeVariance: 0.5, angle: 55 },
});
const ASH_B = P({
  seed: 77211, type: 'deciduous', levels: 3, angle: [0, 42, 70, 60], children: [8, 4, 3], gnarliness: [0.05, 0.2, 0.2, 0.09],
  length: [40, 24, 10, 4.6], radius: [1.9, 0.6, 0.76, 0.7], sections: [10, 6, 4, 2], segments: [8, 5, 3, 3],
  start: [0, 0.3, 0.3, 0], taper: [0.7, 0.7, 0.7, 0.7], twist: [-0.1, 0.1, 0, 0], force: -0.04,
  leaves: { count: 8, start: 0, size: 3.7, sizeVariance: 0.5, angle: 50 },
});
const ASPEN = P({
  seed: 18020, type: 'deciduous', levels: 2, angle: [0, 70, 32, 7], children: [12, 4, 3], gnarliness: [0.05, 0.12, 0.12, 0.02],
  length: [50, 9, 11.19, 1], radius: [0.8, 0.45, 0.7, 0.7], sections: [10, 6, 6, 6], segments: [7, 4, 3, 3],
  start: [0, 0.45, 0.35, 0], taper: [0.37, 0.13, 0.7, 0.7], twist: [0, 0, 0, 0], force: 0.0148,
  leaves: { count: 12, start: 0.12, size: 3.6, sizeVariance: 0.5, angle: 30 },
});
// upright, narrow crown (Lombardy-poplar-like): ash sprigs on steep, short branches
const POPLAR = P({
  seed: 9001, type: 'deciduous', levels: 3, angle: [0, 22, 30, 35], children: [12, 3, 3], gnarliness: [0.02, 0.06, 0.1, 0.09],
  length: [46, 13, 6, 3.5], radius: [1.3, 0.55, 0.7, 0.7], sections: [10, 5, 3, 2], segments: [7, 4, 3, 3],
  start: [0, 0.18, 0.2, 0], taper: [0.75, 0.6, 0.7, 0.7], twist: [0, 0, 0, 0], force: 0.02,
  leaves: { count: 7, start: 0, size: 3.0, sizeVariance: 0.45, angle: 35 },
});
const PINE_A = P({
  seed: 13977, type: 'evergreen', levels: 1, angle: [0, 110, 16, 60], children: [70, 3, 5], gnarliness: [0.05, 0.08, 0, 0],
  length: [50, 23.87, 14.08, 1], radius: [1.05, 0.36, 0.7, 0.7], sections: [12, 6, 8, 6], segments: [7, 4, 4, 3],
  start: [0, 0.22, 0.14, 0.3], taper: [0.7, 0.7, 0.7, 0.7], twist: [0, 0, 0, 0], force: -0.003,
  leaves: { count: 14, start: 0.09, size: 2.3, sizeVariance: 0.2, angle: 39 },
});
const PINE_B = P({
  seed: 11744, type: 'evergreen', levels: 1, angle: [0, 112, 60, 60], children: [64, 7, 5], gnarliness: [0.05, 0.08, 0, 0],
  length: [44, 17, 10, 1], radius: [0.9, 0.41, 0.7, 0.7], sections: [12, 6, 8, 6], segments: [7, 4, 4, 3],
  start: [0, 0.15, 0.3, 0.3], taper: [0.7, 0.7, 0.7, 0.7], twist: [0, 0, 0, 0], force: 0,
  leaves: { count: 12, start: 0.05, size: 1.9, sizeVariance: 0.4, angle: 25 },
});
const SHRUB = P({
  seed: 45590, type: 'deciduous', levels: 3, angle: [0, 30, 62, 60], children: [7, 3, 2], gnarliness: [0.11, 0.09, 0.05, 0.09],
  length: [0.1, 15.3, 5.59, 4.6], radius: [0.58, 0.95, 0.76, 0.7], sections: [3, 4, 4, 3], segments: [4, 4, 3, 3],
  start: [0, 0.53, 0.33, 0], taper: [0.7, 0.7, 0.7, 0.7], twist: [0.3, -0.07, 0, 0], force: -0.02,
  leaves: { count: 6, start: 0, size: 4.2, sizeVariance: 0.5, angle: 55 },
});

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  oak: {
    id: 'oak', variants: [OAK_A, OAK_B], leaf: 'oak', bark: 'oak', height: 7.6,
    lod0: { keep: 0.62, maxLevel: 3, ringStride: [1, 1, 2, 2] }, lod1: { keep: 0.11, grow: 1.05, maxLevel: 2, ringStride: [2, 2, 3], sideStride: [2, 2, 2] },
    far: { tile: 0, clusters: 9, size: 0.95 }, leafColor: [0.62, 0.7, 0.5], translucency: 0.3,
  },
  ash: {
    id: 'ash', variants: [ASH_A, ASH_B], leaf: 'ash', bark: 'oak', height: 8.5,
    lod0: { keep: 0.6, maxLevel: 3, ringStride: [1, 2, 2, 2] }, lod1: { keep: 0.1, grow: 1.05, maxLevel: 2, ringStride: [2, 3, 4], sideStride: [2, 2, 2] },
    far: { tile: 1, clusters: 10, size: 0.9 }, leafColor: [0.66, 0.74, 0.54], translucency: 0.32,
  },
  aspen: {
    id: 'aspen', variants: [ASPEN], leaf: 'aspen', bark: 'birch', height: 8.2,
    lod0: { keep: 0.8, maxLevel: 2, ringStride: [1, 1, 2] }, lod1: { keep: 0.14, grow: 1.05, maxLevel: 1, ringStride: [2, 2], sideStride: [2, 2] },
    far: { tile: 3, clusters: 9, size: 0.85 }, leafColor: [0.95, 0.82, 0.62], translucency: 0.38,
  },
  poplar: {
    id: 'poplar', variants: [POPLAR], leaf: 'ash', bark: 'oak', height: 9.8,
    lod0: { keep: 0.55, maxLevel: 3, ringStride: [1, 2, 2, 2] }, lod1: { keep: 0.1, grow: 1.05, maxLevel: 2, ringStride: [2, 3, 3], sideStride: [2, 2, 2] },
    far: { tile: 1, clusters: 9, size: 0.7 }, leafColor: [0.56, 0.66, 0.46], translucency: 0.28,
  },
  pine: {
    id: 'pine', variants: [PINE_A, PINE_B], leaf: 'pine', bark: 'pine', height: 9.2,
    lod0: { keep: 0.75, maxLevel: 1, ringStride: [1, 2], sideStride: [1, 1] }, lod1: { keep: 0.16, grow: 1.05, maxLevel: 0, ringStride: [2], sideStride: [2] },
    far: { tile: 2, clusters: 11, size: 0.75 }, leafColor: [0.5, 0.6, 0.46], translucency: 0.18,
  },
  shrub: {
    id: 'shrub', variants: [SHRUB], leaf: 'oak', bark: 'oak', height: 1.25,
    lod0: { keep: 0.7, maxLevel: 2, ringStride: [1, 2, 2] }, lod1: { keep: 0.22, grow: 1.05, maxLevel: 1, ringStride: [2, 2], sideStride: [2, 2] },
    far: { tile: 0, clusters: 3, size: 1.1 }, leafColor: [0.55, 0.64, 0.45], translucency: 0.25,
  },
};
