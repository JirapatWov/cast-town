// Room name plates: a CSS2D pill above each room's display wall — room code, job name, lead vendor color and a
// status light (busy green / approval amber), or "Available · click to start a job" for empty rooms.
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import './plates.css';
import { pointWord } from '../ui/touch';

export interface PlateInfo {
  code: string;
  /** Job name; null → the room is available. */
  name: string | null;
  color?: string;
  status?: 'idle' | 'busy' | 'wait';
  current?: boolean;
}

type Clutter = 'full' | 'compact' | 'faded';

export class RoomPlate {
  readonly obj: CSS2DObject;
  private el: HTMLDivElement;
  private last = '';
  private clutter: Clutter = 'full';
  /** Last time (ms) the plate was found overlapping a person's tag. */
  private overlapAt = -Infinity;
  private fullW = 0;
  private occluded = false;
  /** Sideways shift that keeps the pill on screen (px). */
  private dx = 0;

  constructor(onClick: () => void) {
    const anchor = document.createElement('div');
    anchor.className = 'rlt-plate-anchor';
    const el = document.createElement('div');
    el.className = 'rlt-plate';
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    anchor.appendChild(el);
    this.el = el;
    this.obj = new CSS2DObject(anchor);
    this.obj.center.set(0.5, 1);
    this.obj.name = 'room-plate';
  }

  set(info: PlateInfo) {
    const key = JSON.stringify(info);
    if (key === this.last) return;
    this.last = key;
    const el = this.el;
    el.replaceChildren();
    el.className = 'rlt-plate';
    this.applyClutter();
    const span = (cls: string, text = '') => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      el.appendChild(s);
      return s;
    };
    span('rlt-plate__code', info.code);
    if (info.name === null) {
      el.classList.add('is-empty');
      span('rlt-plate__plus', '+');
      const verb = pointWord().toLowerCase(); // a phone says tap
      span('rlt-plate__name', `Available · ${verb} to start a job`);
      el.title = `Room ${info.code} is free — ${verb} to start a job here`;
      return;
    }
    const dot = span('rlt-plate__dot');
    dot.style.setProperty('--c', info.color ?? '#9ca3af');
    span('rlt-plate__name', info.name);
    span('rlt-plate__status');
    if (info.status === 'busy') el.classList.add('is-busy');
    if (info.status === 'wait') el.classList.add('is-wait');
    if (info.current) el.classList.add('is-current');
    el.title = `${info.name} · room ${info.code}${info.status === 'wait' ? ' · needs your approval' : info.status === 'busy' ? ' · working' : ''}`;
  }

  /** Declutter step: `hit` = the plate currently overlaps a person's tag. Overlapping plates first shrink to their
   *  room code (people's tags matter more than the room name), then fade if they still overlap; they come back
   *  only after a quiet moment, so someone walking past does not make them flicker. Hover always restores them. */
  declutter(hit: boolean, now: number) {
    if (hit) this.overlapAt = now;
    let next: Clutter = this.clutter;
    if (hit) next = this.clutter === 'full' ? 'compact' : 'faded';
    else if (now - this.overlapAt > 1400) next = 'full';
    if (next === this.clutter) return;
    this.clutter = next;
    this.applyClutter();
  }

  /** Hidden while a standing wall is between the camera and the plate (a back room's plate would otherwise float
   *  over the wall of the room in front of it, reading as that room's label). */
  setOccluded(on: boolean) {
    if (on === this.occluded) return;
    this.occluded = on;
    this.applyClutter();
  }

  private applyClutter() {
    this.el.classList.toggle('is-compact', this.clutter !== 'full');
    this.el.classList.toggle('is-faded', this.clutter === 'faded');
    this.el.classList.toggle('is-occluded', this.occluded);
  }

  /** Slide the pill sideways so it stays inside a view `viewW` px wide (a phone cuts off a room's plate at the edge).
   *  Through the CSS `translate` property: the hover transform still applies. */
  clampX(viewW: number, margin = 6) {
    if (!this.el.isConnected || !this.obj.visible) return;
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0) return;
    const left = r.left - this.dx;
    const right = r.right - this.dx;
    let dx = 0;
    if (right > viewW - margin) dx = viewW - margin - right;
    if (left + dx < margin) dx = margin - left;
    dx = Math.round(dx);
    if (dx === this.dx) return;
    this.dx = dx;
    this.el.style.translate = dx ? `${dx}px 0` : '';
  }

  /** Screen rectangle of the pill at full size (null while not displayed): a shrunk plate is tested as if
   *  expanded (it stays centred on its anchor), so it does not pop back over the tag it just made room for. */
  rect(): DOMRect | null {
    if (!this.el.isConnected || !this.obj.visible || this.occluded) return null;
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0) return null;
    if (this.clutter === 'full') {
      this.fullW = r.width;
      return r;
    }
    const w = Math.max(r.width, this.fullW), cx = (r.left + r.right) / 2;
    return new DOMRect(cx - w / 2, r.top, w, r.height);
  }

  dispose() {
    this.obj.removeFromParent();
    this.obj.element.remove();
  }
}

/** Shrink / fade room plates that overlap people's name tags (CSS2D labels in `layer`). */
export function declutterPlates(plates: RoomPlate[], layer: HTMLElement, now: number) {
  const tags: DOMRect[] = [];
  // the tag root is a 0×0 anchor; its pill (name plate) is what covers the plate. The homeowner's "You" chip
  // (player/marker.ts) counts while it shows.
  for (const el of layer.querySelectorAll<HTMLElement>('.rlt-pt__plate, .rlt-you.is-on .rlt-you__chip')) {
    const r = el.getBoundingClientRect(); // 0×0 while the tag (or a parent) is display: none
    if (r.width > 0) tags.push(r);
  }
  const pad = 4;
  const viewW = layer.clientWidth || innerWidth;
  for (const p of plates) {
    p.clampX(viewW);
    const r = p.rect();
    if (!r) continue;
    const hit = tags.some((t) => r.left - pad < t.right && r.right + pad > t.left && r.top - pad < t.bottom && r.bottom + pad > t.top);
    p.declutter(hit, now);
  }
}
