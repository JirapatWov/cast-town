// Click + hover picking inside the house: people (invisible capsules), props (TV, job boards, computers, the front
// door) and rooms (room doors, the floor of an empty room). Priority: people > props > room doors > room floors,
// so a room's floor never steals a click from someone standing on it.
// A click is a press/release with little movement, so orbit drags never trigger it.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { STOREY_H } from '../../../shared/house-plan';
import type { Engine } from '../core/types';
import type { HouseCamera } from './camera';
import type { PickTarget } from './furniture/kit';

export interface PickEntry { obj: THREE.Object3D; target: PickTarget }

export interface PickerOptions {
  people(): THREE.Object3D[];
  /** Pickable props of the floors on show (re-read on every pick). */
  props(): PickEntry[];
  hoverPerson(agentId: string | null): void;
  hoverProp?(target: PickTarget | null): void;
  clickPerson(agentId: string): void;
  clickProp(target: PickTarget): void;
}

type Hit = { kind: 'person'; agentId: string } | { kind: 'prop'; target: PickTarget } | null;

const CLICK_SLOP = 6; // px
const CLICK_MS = 650;

export class HousePicker {
  readonly tooltip: CSS2DObject;
  private tipEl: HTMLDivElement;
  private down: { x: number; y: number; t: number } | null = null;
  private move: PointerEvent | null = null;
  private hover: Hit = null;
  private connected = false;

  constructor(
    private engine: Engine,
    private cam: HouseCamera,
    private opts: PickerOptions,
  ) {
    const el = document.createElement('div');
    Object.assign(el.style, {
      padding: '0.3125rem 0.625rem', borderRadius: '0.625rem', background: 'rgba(20,20,24,.78)', color: '#F4F1EC',
      font: '600 0.75rem Inter, system-ui, sans-serif', whiteSpace: 'nowrap', border: '1px solid rgba(255,255,255,.1)',
      boxShadow: '0 6px 18px rgba(0,0,0,.25)', backdropFilter: 'blur(12px)', marginTop: '-0.875rem',
      pointerEvents: 'none', transition: 'opacity .15s ease-out',
    } satisfies Partial<CSSStyleDeclaration>);
    this.tipEl = el;
    this.tooltip = new CSS2DObject(el);
    this.tooltip.visible = false;
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    const c = this.engine.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerleave', this.onLeave);
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    const c = this.engine.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerleave', this.onLeave);
    this.setHover(null);
  }

  /** Once per frame: resolve the latest pointer move into a hover state. */
  update() {
    if (!this.move) return;
    const ev = this.move;
    this.move = null;
    if (this.down || ev.buttons) return; // dragging the camera
    this.setHover(this.pick(ev));
  }

  /** Forget the hover (the floor on show changed under the pointer). */
  clearHover() {
    this.setHover(null);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; // event time: a slow frame between down and up is not a long press
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP || e.timeStamp - d.t > CLICK_MS) return;
    const hit = this.pick(e);
    if (hit?.kind === 'person') this.opts.clickPerson(hit.agentId);
    else if (hit?.kind === 'prop') {
      this.opts.clickProp(hit.target);
      this.setHover(null); // the click opened something (terminal, dialog, panel): drop the tooltip until the pointer moves
    }
  };

  private onMove = (e: PointerEvent) => {
    this.move = e;
  };

  private onLeave = () => {
    this.move = null;
    this.setHover(null);
  };

  /** What a click at this screen point would hit (dev probes). */
  pickAt(clientX: number, clientY: number): Hit {
    return this.pick({ clientX, clientY });
  }

  private pick(ev: { clientX: number; clientY: number }): Hit {
    // the raycaster ignores visibility: skip props hidden by the cutaway (e.g. door leaves) or on hidden floors
    const props = this.opts.props().filter((p) => shown(p.obj));
    const isRoomDoor = (p: PickEntry) => p.target.kind === 'room' && p.target.roomPart === 'door';
    const isRoomFloor = (p: PickEntry) => p.target.kind === 'room' && p.target.roomPart !== 'door';
    const passes: THREE.Object3D[][] = [
      [...this.opts.people(), ...props.filter((p) => p.target.kind !== 'room').map((p) => p.obj)],
      props.filter(isRoomDoor).map((p) => p.obj),
      props.filter(isRoomFloor).map((p) => p.obj),
    ];
    for (const objs of passes) {
      if (!objs.length) continue;
      const hit = this.engine.pick(ev, this.cam.camera, objs);
      if (!hit) continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (o.userData.agentId) return { kind: 'person', agentId: o.userData.agentId as string };
        const prop = props.find((p) => p.obj === o);
        if (prop) return { kind: 'prop', target: prop.target };
      }
    }
    return null;
  }

  private setHover(h: Hit) {
    const same = h?.kind === this.hover?.kind &&
      (h?.kind === 'person' ? h.agentId === (this.hover as { agentId: string }).agentId : h?.kind === 'prop' ? h.target === (this.hover as { target: PickTarget }).target : true);
    if (same) return;
    this.hover = h;
    this.engine.canvas.style.cursor = h ? 'pointer' : '';
    this.opts.hoverPerson(h?.kind === 'person' ? h.agentId : null);
    this.opts.hoverProp?.(h?.kind === 'prop' ? h.target : null);
    if (h?.kind === 'prop') {
      this.tipEl.textContent = h.target.label;
      this.tooltip.position.copy(h.target.anchor);
      this.tooltip.position.y += (h.target.floor ?? 0) * STOREY_H;
      this.tooltip.visible = true;
    } else {
      this.tooltip.visible = false;
    }
  }
}

function shown(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}
