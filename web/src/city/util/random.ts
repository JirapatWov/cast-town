// Deterministic randomness so the town looks identical on every load.

/** mulberry32: tiny, fast, good-enough PRNG. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const range = (r: () => number, a: number, b: number) => a + (b - a) * r();
export const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length];

/** Smooth 3D value noise in [-1, 1] (used to displace foliage). */
export function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(xf), v = s(yf), w = s(zf);
  const h = (i: number, j: number, k: number) => {
    let n = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = lerp(h(xi, yi, zi), h(xi + 1, yi, zi), u);
  const x10 = lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u);
  const x01 = lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u);
  const x11 = lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
