// Quality presets: one place that maps Low/Medium/High/Ultra to concrete renderer, lighting and post settings.
// Budgets (renderer.info incl. shadow passes): Low ≤ 250 calls / 0.8 M tris, Medium ≤ 400 / 1.5 M, High ≤ 600 / 2.5 M.
import type { WebGLRenderer } from 'three';
import type { Quality } from '../core/types';
import type { GIQuality } from './gi';
import { deviceStorage } from '../ui/dom';

export interface QualitySettings {
  /** Upper bound for devicePixelRatio (Retina at 1.5 looks sharp and saves ~45% fill vs 2.0). */
  pixelRatioCap: number;
  shadows: boolean;
  /** Shadow map size (outdoor: per cascade, SunLight renders 2 cascades into one atlas). */
  shadowMapSize: number;
  /** PCF softness radius (texels). */
  shadowRadius: number;
  /** Re-render shadow maps every N frames (1 = every frame). People move slowly, 30 Hz shadows are invisible. */
  shadowEvery: number;
  /** Outdoor sun-shadow reach relative to the default fit (fewer distant casters on Low). */
  shadowDistance: number;
  /** People cast sun shadows (off on Low: a dozen skinned draws saved in every shadow pass). */
  characterShadows: boolean;
  /** Furniture casts sun shadows indoors (off on Low: the shell still shapes the window light). */
  furnitureShadows: boolean;
  ao: 'off' | 'half' | 'full';
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High';
  bloom: boolean;
  /** Bloom mip levels (fewer = cheaper, tighter glow). */
  bloomLevels: number;
  smaa: 'low' | 'medium' | 'high';
  anisotropy: number;
  /** Interior global illumination (light probe grid). */
  gi: GIQuality;
  /** Depth of field focused on the orbit target (miniature look). 0 = off, otherwise the bokeh scale. */
  dof: number;
  /** Film grain amount (hides banding in dark skies). */
  grain: number;
  /** Max practical point lights with cube shadows in a house (0 = lamps cast no shadows). */
  lampShadows: number;
  /** Cube shadow map size of the lamp that casts shadows (Ultra: crisper). */
  lampShadowSize: number;
  /** AO radius multiplier (Ultra reaches further). */
  aoScale: number;
  /** The neighbours' houses and the hedge sprig cards around the house lot (off on Low: six draws). */
  lotDetail: boolean;
}

export const QUALITY_PRESETS: Record<Quality, QualitySettings> = {
  low: {
    pixelRatioCap: 1, shadows: true, shadowMapSize: 1024, shadowRadius: 1.5, shadowEvery: 2, shadowDistance: 0.36, characterShadows: false, furnitureShadows: false,
    ao: 'off', aoQuality: 'Performance', bloom: false, bloomLevels: 4, smaa: 'low', anisotropy: 2,
    gi: { enabled: true, probes: [6, 2, 5], cubemapSize: 8, bounces: 0, budgetMs: 3 },
    dof: 0, grain: 0, lampShadows: 0, lampShadowSize: 512, aoScale: 1, lotDetail: false,
  },
  medium: {
    pixelRatioCap: 1.25, shadows: true, shadowMapSize: 2048, shadowRadius: 2, shadowEvery: 2, shadowDistance: 0.8, characterShadows: true, furnitureShadows: true,
    ao: 'half', aoQuality: 'Low', bloom: true, bloomLevels: 5, smaa: 'medium', anisotropy: 4,
    gi: { enabled: true, probes: [8, 3, 7], cubemapSize: 12, bounces: 0, budgetMs: 4 },
    dof: 1.1, grain: 0.012, lampShadows: 0, lampShadowSize: 512, aoScale: 1, lotDetail: true,
  },
  high: {
    pixelRatioCap: 1.5, shadows: true, shadowMapSize: 2048, shadowRadius: 2, shadowEvery: 1, shadowDistance: 1, characterShadows: true, furnitureShadows: true,
    ao: 'half', aoQuality: 'Medium', bloom: true, bloomLevels: 6, smaa: 'high', anisotropy: 8,
    gi: { enabled: true, probes: [10, 3, 7], cubemapSize: 16, bounces: 2, budgetMs: 6 },
    dof: 1.5, grain: 0.016, lampShadows: 1, lampShadowSize: 512, aoScale: 1, lotDetail: true,
  },
  ultra: {
    pixelRatioCap: 2, shadows: true, shadowMapSize: 4096, shadowRadius: 2.5, shadowEvery: 1, shadowDistance: 1.15, characterShadows: true, furnitureShadows: true,
    ao: 'full', aoQuality: 'High', bloom: true, bloomLevels: 7, smaa: 'high', anisotropy: 16,
    gi: { enabled: true, probes: [14, 4, 9], cubemapSize: 16, bounces: 2, budgetMs: 8 },
    dof: 1.8, grain: 0.018, lampShadows: 1, lampShadowSize: 1024, aoScale: 1.5, lotDetail: true,
  },
};

/** Phones and tablets: the OS kills a tab (iOS: "A problem repeatedly occurred") long before a laptop runs out of
 *  memory, and every preset loads the same assets — so asset sizes are capped per device, not per preset. */
export const MEMORY_TIGHT = isMemoryTight();
/** Longest side of a loaded texture on this device (1k art becomes 512 px on phones: a quarter of the memory). */
export const TEXTURE_CAP = MEMORY_TIGHT ? 512 : Infinity;

function isMemoryTight(): boolean {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  if (!nav) return false;
  if (/iPhone|iPad|iPod|Android/i.test(nav.userAgent)) return true;
  if (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1) return true; // iPadOS asks for the desktop site
  return typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 4;
}

const STORAGE_KEY = 'rlt.quality';
const QUALITIES: Quality[] = ['low', 'medium', 'high', 'ultra'];

export function isQuality(v: unknown): v is Quality {
  return typeof v === 'string' && (QUALITIES as string[]).includes(v);
}

/** Graphics quality is a property of this device (its GPU), so every city shares it. */
export function loadSavedQuality(): Quality | null {
  const v = deviceStorage.get(STORAGE_KEY);
  return isQuality(v) ? v : null;
}

export function saveQuality(q: Quality): void {
  deviceStorage.set(STORAGE_KEY, q); // blocked storage: quality just isn't remembered
}

/** Rough GPU tiering from the unmasked renderer string. Conservative: unknown → medium. */
export function detectQuality(renderer: WebGLRenderer): Quality {
  const gl = renderer.getContext();
  let name = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    /* ignore */
  }
  const n = name.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(n)) return 'low';
  if (/apple m\d+ (pro|max|ultra)/.test(n)) return 'high';
  if (/apple m\d+/.test(n) || /apple gpu/.test(n)) return 'medium';
  if (/rtx|radeon rx [6-9]\d{3}|rx 7\d{3}|arc a7/.test(n)) return 'ultra';
  if (/nvidia|geforce|radeon|quadro/.test(n)) return 'high';
  if (/intel|mali|adreno|powervr/.test(n)) return 'low';
  return 'medium';
}

/** A phone or tablet (touch, no hover). They start on Low: battery and heat matter more there, and Safari names every
 *  Apple GPU "Apple GPU", so the renderer string can't tell an iPhone from a Mac. The More menu raises it. */
function touchDevice(): boolean {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Quality from URL (?q=high), then localStorage, then Low on phones / tablets, then GPU detection. */
export function initialQuality(renderer: WebGLRenderer): Quality {
  try {
    const q = new URLSearchParams(location.search).get('q');
    if (isQuality(q)) return q;
  } catch {
    /* ignore */
  }
  return loadSavedQuality() ?? (touchDevice() ? 'low' : detectQuality(renderer));
}

// ── active settings, for modules without an engine handle (house lighting) ─────────────────────
let active: QualitySettings = QUALITY_PRESETS.high;
const activeListeners = new Set<(q: QualitySettings) => void>();

export function activeQualitySettings(): QualitySettings {
  return active;
}

export function onQualitySettings(fn: (q: QualitySettings) => void): () => void {
  activeListeners.add(fn);
  fn(active);
  return () => activeListeners.delete(fn);
}

export function publishQualitySettings(q: QualitySettings) {
  active = q;
  for (const fn of activeListeners) fn(q);
}
