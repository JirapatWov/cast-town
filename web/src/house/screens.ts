// Small canvas screens for monitors / laptops: a dim lock screen when idle, scrolling syntax-colored
// code (tinted with the user's vendor color) while someone types at that desk.
// The screens of one room draw into a shared ScreenAtlas: one texture and one material, so the batcher merges every
// screen of the room into a single draw call instead of one per screen (each had a texture of its own).
import * as THREE from 'three';
import { mulberry32 } from '../people/rng';

const W = 384, H = 224;
/** Gap between atlas cells, so the smaller mip levels of one screen never bleed into its neighbour. */
const GUTTER = 8;

/** One canvas texture for up to `capacity` screens (2 columns). Uploads are coalesced to ~5 per second. */
export class ScreenAtlas {
  readonly material: THREE.MeshBasicMaterial;
  readonly g: CanvasRenderingContext2D;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private used = 0;
  private dirty = false;
  private acc = 0;

  constructor(readonly capacity = 6) {
    this.canvas.width = 2 * W + GUTTER;
    this.canvas.height = Math.ceil(capacity / 2) * (H + GUTTER) - GUTTER;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    this.material.name = 'screens';
  }

  /** A free cell (canvas px offset and its uv rectangle), or null when the atlas is full. */
  alloc(): { x: number; y: number; uv: [number, number, number, number] } | null {
    if (this.used >= this.capacity) return null;
    const i = this.used++;
    const x = (i % 2) * (W + GUTTER), y = Math.floor(i / 2) * (H + GUTTER);
    const cw = this.canvas.width, ch = this.canvas.height;
    // canvas textures are flipped: v = 1 is the canvas top
    return { x, y, uv: [x / cw, 1 - (y + H) / ch, (x + W) / cw, 1 - y / ch] };
  }

  markDirty() {
    if (!this.dirty && this.acc >= 0.2) this.flush(); // idle for a while: show the change at once
    else this.dirty = true;
  }

  update(dt: number) {
    this.acc += dt;
    if (this.dirty && this.acc >= 0.2) this.flush();
  }

  private flush() {
    this.dirty = false;
    this.acc = 0;
    this.tex.needsUpdate = true;
  }

  dispose() {
    this.tex.dispose();
    this.material.dispose();
  }
}
const TOKENS = ['const', 'await', 'return', 'export', 'function', 'if', 'for', 'import', 'type', 'new', '=>', '{', '}', '(', ')', ';'];
const IDENTS = ['todos', 'markDone', 'req', 'json', 'title', 'id', 'store', 'validate', 'server', 'route', 'res', 'status', 'body', 'error'];

export class Screen {
  readonly material: THREE.MeshBasicMaterial;
  private g: CanvasRenderingContext2D;
  /** Own texture (no atlas, or the atlas was full). */
  private tex: THREE.CanvasTexture | null = null;
  private atlas: ScreenAtlas | null = null;
  private ox = 0;
  private oy = 0;
  private uv: [number, number, number, number] = [0, 0, 1, 1];
  private active = false;
  private tint = '#D97757';
  private scroll = 0;
  private acc = 0;
  private lines: { indent: number; parts: { w: number; c: string }[] }[] = [];

  constructor(seed: number, atlas?: ScreenAtlas) {
    const cell = atlas?.alloc() ?? null;
    if (atlas && cell) {
      this.atlas = atlas;
      this.g = atlas.g;
      this.material = atlas.material;
      this.ox = cell.x;
      this.oy = cell.y;
      this.uv = cell.uv;
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      this.g = canvas.getContext('2d')!;
      this.tex = new THREE.CanvasTexture(canvas);
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.material = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    }
    const r = mulberry32(seed);
    let indent = 0;
    for (let i = 0; i < 80; i++) {
      const parts: { w: number; c: string }[] = [];
      const n = 2 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) {
        const kw = r() < 0.35;
        const word = kw ? TOKENS[Math.floor(r() * TOKENS.length)] : IDENTS[Math.floor(r() * IDENTS.length)];
        parts.push({ w: word.length * 6.2 + 5, c: kw ? 'kw' : r() < 0.2 ? 'str' : 'id' });
      }
      this.lines.push({ indent, parts });
      if (r() < 0.25) indent = Math.min(4, indent + 1); else if (r() < 0.25) indent = Math.max(0, indent - 1);
    }
    this.draw();
  }

  setActive(on: boolean, tint?: string) {
    if (tint) this.tint = tint;
    if (on === this.active) return;
    this.active = on;
    this.draw();
  }

  /** The screen's glass: a w × h plane showing this screen's part of the texture. */
  faceGeometry(w: number, h: number): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(w, h);
    const [u0, v0, u1, v1] = this.uv;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return geo;
  }

  /** Frees the screen's own texture (an atlas is freed by its owner). */
  dispose() {
    this.active = false;
    if (!this.tex) return;
    this.tex.dispose();
    this.material.dispose();
  }

  update(dt: number) {
    if (!this.active) return;
    this.acc += dt;
    if (this.acc < 0.25) return; // ~4 fps is plenty for a far-away screen
    this.scroll += this.acc * 2.2;
    this.acc = 0;
    this.draw();
  }

  private draw() {
    const g = this.g;
    g.save();
    g.translate(this.ox, this.oy);
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    this.paint(g);
    g.restore();
    if (this.atlas) this.atlas.markDirty();
    else if (this.tex) this.tex.needsUpdate = true;
  }

  private paint(g: CanvasRenderingContext2D) {
    g.fillStyle = this.active ? '#15171c' : '#0e1013';
    g.fillRect(0, 0, W, H);
    if (!this.active) {
      const grd = g.createLinearGradient(0, 0, W, H);
      grd.addColorStop(0, '#20242c');
      grd.addColorStop(1, '#101216');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = '600 34px Inter, sans-serif';
      g.textAlign = 'center';
      const d = new Date();
      g.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, W / 2, H / 2 + 8);
      return;
    }
    // editor chrome
    g.fillStyle = '#1d2027';
    g.fillRect(0, 0, W, 16);
    g.fillStyle = this.tint;
    g.fillRect(0, 15, 90, 2);
    g.fillStyle = '#1a1c22';
    g.fillRect(0, 16, 26, H);
    const lh = 11;
    const first = Math.floor(this.scroll);
    const frac = this.scroll - first;
    for (let i = 0; i < 20; i++) {
      const line = this.lines[(first + i) % this.lines.length];
      const y = 22 + (i - frac) * lh;
      if (y < 16) continue;
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(8, y + 3, 12, 3);
      let x = 32 + line.indent * 14;
      for (const p of line.parts) {
        g.fillStyle = p.c === 'kw' ? this.tint : p.c === 'str' ? '#9fd38a' : '#cfd6e2';
        g.globalAlpha = p.c === 'id' ? 0.75 : 0.95;
        g.fillRect(x, y + 2, p.w - 5, 5);
        x += p.w;
      }
      g.globalAlpha = 1;
    }
    // caret line
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(26, 22 + 12 * lh, W, lh);
  }
}
