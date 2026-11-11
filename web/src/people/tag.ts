// CSS2D name tag above each person: vendor badge (shape per vendor), name, status dot, model label
// (+ "not connected" chip), current detail; plus speech / thought / "!" bubbles. Glass styling per the UI direction.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { VENDOR_COLORS, type Activity, type AgentInfo, type Vendor } from '../../../shared/protocol';
import { tagNotConnected } from './tag-state';

const BADGE: Record<Vendor, string> = { anthropic: '●', openai: '⬢', deepseek: '◆', google: '✦', openrouter: '■', other: '▲' };

const CSS = /* css */ `
.rlt-pt { position: absolute; width: 0; height: 0; font-family: Inter, system-ui, sans-serif; }
.rlt-pt * { box-sizing: border-box; }
.rlt-pt__stack { position: absolute; left: 0; bottom: 0; width: max-content; transform: translateX(-50%); display: flex; flex-direction: column;
  align-items: center; gap: 0.375rem; transition: opacity .2s ease-out, transform .2s ease-out, translate .25s ease-out; }
.rlt-pt__plate { pointer-events: auto; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 0.25rem 0.5625rem 0.25rem; border-radius: 0.6875rem; background: rgba(20,20,24,.72); color: #F4F1EC;
  backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid rgba(255,255,255,.08); box-shadow: 0 6px 18px rgba(0,0,0,.22); white-space: nowrap;
  transition: transform .15s ease-out, border-color .15s ease-out; }
.rlt-pt__plate:hover, .rlt-pt.is-hover .rlt-pt__plate { transform: translateY(-0.125rem); border-color: color-mix(in srgb, var(--v) 70%, transparent); }
.rlt-pt__row { display: flex; align-items: center; gap: 0.3125rem; font-size: 0.75rem; font-weight: 600; letter-spacing: .01em; line-height: 1rem; }
.rlt-pt__badge { color: var(--v); font-size: 0.625rem; line-height: 1; }
.rlt-pt__dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: #8b8f94; margin-left: 0.125rem; }
.rlt-pt[data-status=busy] .rlt-pt__dot { background: #3FB37F; box-shadow: 0 0 0 0 rgba(63,179,127,.6); animation: rlt-pt-pulse 1.6s infinite; }
.rlt-pt[data-status=starting] .rlt-pt__dot { background: #F5A524; }
.rlt-pt[data-status=error] .rlt-pt__dot { background: #E5484D; }
.rlt-pt[data-status=idle] .rlt-pt__dot { background: #A8A29E; }
.rlt-pt[data-attn=1] .rlt-pt__dot { background: #F5A524; animation: rlt-pt-pulse-a 1.2s infinite; }
.rlt-pt__meta { font-size: 0.65625rem; color: #A8A29E; line-height: 0.875rem; display: flex; gap: 0.25rem; align-items: center; }
.rlt-pt__off { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: .06em; padding: 0 0.25rem; border-radius: 0.25rem;
  background: rgba(245,165,36,.16); color: #F5C26B; line-height: 0.8125rem; }
.rlt-pt__detail { font-size: 0.65625rem; color: #d9d4cc; max-width: 190px; overflow: hidden; text-overflow: ellipsis; line-height: 0.875rem; }
.rlt-pt__detail:empty { display: none; }
.rlt-pt.is-far .rlt-pt__meta, .rlt-pt.is-far .rlt-pt__detail { display: none; }
.rlt-pt.is-far .rlt-pt__plate { padding: 0.1875rem 0.5rem; }
@media (max-width: 640px) { .rlt-pt__meta, .rlt-pt__detail { display: none; } .rlt-pt__plate { padding: 0.1875rem 0.5rem; } }
.rlt-pt__bubble { position: relative; max-width: 230px; padding: 0.4375rem 0.6875rem; border-radius: 0.8125rem; background: rgba(255,253,249,.96);
  color: #26221e; font-size: 0.78125rem; line-height: 1.0625rem; box-shadow: 0 8px 22px rgba(0,0,0,.2); white-space: normal;
  animation: rlt-pt-pop .22s cubic-bezier(.2,.9,.3,1.3); }
.rlt-pt__say { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.rlt-pt__bubble::after { content: ''; position: absolute; left: 50%; bottom: -0.375rem; width: 0.75rem; height: 0.75rem; margin-left: -0.375rem;
  background: inherit; transform: rotate(45deg); border-radius: 0.125rem; }
.rlt-pt__bubble[hidden], .rlt-pt__think[hidden], .rlt-pt__alert[hidden] { display: none; }
.rlt-pt__think { display: flex; flex-direction: column; align-items: center; gap: 0.1875rem; animation: rlt-pt-pop .22s ease-out; }
.rlt-pt__think-cloud { display: flex; gap: 0.25rem; padding: 0.375rem 0.625rem; border-radius: 0.875rem; background: rgba(255,253,249,.92);
  box-shadow: 0 6px 16px rgba(0,0,0,.16); }
.rlt-pt__think-cloud i { width: 0.375rem; height: 0.375rem; border-radius: 50%; background: #7d756c; animation: rlt-pt-dots 1.2s infinite; }
.rlt-pt__think-cloud i:nth-child(2) { animation-delay: .15s; } .rlt-pt__think-cloud i:nth-child(3) { animation-delay: .3s; }
.rlt-pt__think-tail { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: rgba(255,253,249,.9); margin-left: -1rem; }
.rlt-pt__alert { width: 1.75rem; height: 1.75rem; border-radius: 50%; background: #F5A524; color: #1d1404; font-weight: 800; font-size: 1.0625rem;
  display: grid; place-items: center; box-shadow: 0 0 0 4px rgba(245,165,36,.28), 0 8px 18px rgba(0,0,0,.25); animation: rlt-pt-bob 1s ease-in-out infinite; }
@keyframes rlt-pt-pulse { 0% { box-shadow: 0 0 0 0 rgba(63,179,127,.55); } 70% { box-shadow: 0 0 0 6px rgba(63,179,127,0); } 100% { box-shadow: 0 0 0 0 rgba(63,179,127,0); } }
@keyframes rlt-pt-pulse-a { 0% { box-shadow: 0 0 0 0 rgba(245,165,36,.6); } 70% { box-shadow: 0 0 0 6px rgba(245,165,36,0); } 100% { box-shadow: 0 0 0 0 rgba(245,165,36,0); } }
@keyframes rlt-pt-pop { from { opacity: 0; transform: translateY(0.375rem) scale(.92); } to { opacity: 1; transform: none; } }
@keyframes rlt-pt-dots { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-0.125rem); } }
@keyframes rlt-pt-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-0.25rem); } }
`;

let styled = false;

function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.rlt = 'person-tag';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export class PersonTag {
  readonly object: CSS2DObject;
  private root: HTMLDivElement;
  private nameEl: HTMLSpanElement;
  private badgeEl: HTMLSpanElement;
  private metaEl: HTMLDivElement;
  private detailEl: HTMLDivElement;
  private bubbleEl: HTMLDivElement;
  private thinkEl: HTMLDivElement;
  private alertEl: HTMLDivElement;
  private bubbleTimer = 0;
  private lastKey = '';

  constructor(onClick: () => void) {
    ensureStyles();
    const root = document.createElement('div');
    root.className = 'rlt-pt';
    root.innerHTML = `<div class="rlt-pt__stack">
      <div class="rlt-pt__bubble" hidden><span class="rlt-pt__say"></span></div>
      <div class="rlt-pt__think" hidden><div class="rlt-pt__think-cloud"><i></i><i></i><i></i></div><div class="rlt-pt__think-tail"></div></div>
      <div class="rlt-pt__alert" hidden>!</div>
      <div class="rlt-pt__plate">
        <div class="rlt-pt__row"><span class="rlt-pt__badge"></span><span class="rlt-pt__name"></span><span class="rlt-pt__dot"></span></div>
        <div class="rlt-pt__meta"></div>
        <div class="rlt-pt__detail"></div>
      </div></div>`;
    const q = <T extends HTMLElement>(c: string) => root.querySelector(`.rlt-pt__${c}`) as T;
    this.root = root;
    this.nameEl = q('name');
    this.badgeEl = q('badge');
    this.metaEl = q('meta');
    this.detailEl = q('detail');
    this.bubbleEl = q('bubble');
    this.thinkEl = q('think');
    this.alertEl = q('alert');
    q<HTMLDivElement>('plate').addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    this.object = new CSS2DObject(root);
    this.object.center.set(0.5, 1);
  }

  update(agent: AgentInfo, activity: Activity) {
    const off = tagNotConnected(agent);
    const key = [agent.name, agent.vendor, agent.modelLabel, off, agent.status, agent.detail, activity].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.root.style.setProperty('--v', VENDOR_COLORS[agent.vendor] ?? VENDOR_COLORS.other);
    this.root.dataset.status = agent.status;
    this.root.dataset.attn = activity === 'waiting_approval' ? '1' : '0';
    this.badgeEl.textContent = BADGE[agent.vendor] ?? BADGE.other;
    this.nameEl.textContent = agent.name;
    this.metaEl.textContent = agent.modelLabel;
    if (off) {
      // nobody is signed in to this person's model: they can't work until someone is
      const chip = document.createElement('span');
      chip.className = 'rlt-pt__off';
      chip.textContent = 'not connected';
      this.metaEl.appendChild(chip);
    }
    const busy = agent.status === 'busy' || activity !== 'idle';
    this.detailEl.textContent = busy && agent.detail ? agent.detail : '';
    this.thinkEl.hidden = activity !== 'thinking' || !this.bubbleEl.hidden;
    this.alertEl.hidden = activity !== 'waiting_approval';
  }

  say(text: string, ms: number) {
    (this.bubbleEl.firstElementChild as HTMLElement).textContent = text;
    this.bubbleEl.hidden = false;
    this.thinkEl.hidden = true;
    this.bubbleTimer = ms / 1000;
    // restart the pop animation
    this.bubbleEl.style.animation = 'none';
    void this.bubbleEl.offsetWidth;
    this.bubbleEl.style.animation = '';
  }

  tick(dt: number, camDistance: number, hover: boolean) {
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubbleEl.hidden = true;
        this.lastKey = ''; // let update() restore the thought bubble
      }
    }
    // the model line, "not connected" chip and activity detail only show up close (or on hover): from the default framing a
    // room of people reads as a row of names, not a wall of cards
    this.root.classList.toggle('is-far', !hover && camDistance > 9);
    this.root.classList.toggle('is-hover', hover);
  }

  setVisible(on: boolean) {
    this.object.visible = on;
    this.root.style.display = on ? '' : 'none';
  }

  dispose() {
    this.object.removeFromParent();
    this.root.remove();
  }
}

// ── floor markers: soft contact shadow + status ring ─────────────────────────────────────────────
let blob: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (blob) return blob;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.3)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  blob = new THREE.CanvasTexture(c);
  blob.colorSpace = THREE.SRGBColorSpace;
  return blob;
}

const RING_GEO = new THREE.RingGeometry(0.355, 0.385, 48).rotateX(-Math.PI / 2);
const SHADOW_GEO = new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2);

export class FloorMarkers {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private shadowMat: THREE.MeshBasicMaterial;
  private t = 0;
  private mode: 'normal' | 'attn' | 'error' = 'normal';
  private base = new THREE.Color();

  constructor(vendorColor: string) {
    this.shadowMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.8 });
    const shadow = new THREE.Mesh(SHADOW_GEO, this.shadowMat);
    shadow.position.y = 0.006;
    shadow.renderOrder = 1;
    this.base.set(vendorColor);
    this.ring = new THREE.Mesh(RING_GEO as unknown as THREE.RingGeometry, new THREE.MeshBasicMaterial({ color: this.base, transparent: true, opacity: 0.55, depthWrite: false }));
    this.ring.position.y = 0.012;
    this.ring.renderOrder = 2;
    this.group.add(shadow, this.ring);
  }

  setMode(mode: 'normal' | 'attn' | 'error') {
    this.mode = mode;
  }

  tick(dt: number, hover: boolean, seated: boolean, camDistance = 20) {
    this.t += dt;
    const m = this.ring.material;
    // a quiet ring: it fades out as the camera comes close (the person is the subject there, not the marker)
    const near = THREE.MathUtils.smoothstep(camDistance, 4, 8);
    if (this.mode === 'attn') {
      m.color.set('#F5A524');
      const p = 0.5 + 0.5 * Math.sin(this.t * 5);
      m.opacity = 0.65 + 0.35 * p;
      this.ring.scale.setScalar(1 + 0.12 * p);
    } else if (this.mode === 'error') {
      m.color.set('#E5484D');
      m.opacity = 0.85;
      this.ring.scale.setScalar(1);
    } else {
      m.color.copy(this.base);
      m.opacity = hover ? 0.9 : 0.35 * near;
      this.ring.scale.setScalar(hover ? 1.08 : 1);
    }
    this.shadowMat.opacity = seated ? 0.35 : 0.8;
    this.ring.visible = m.opacity > 0.01;
  }

  dispose() {
    this.ring.material.dispose();
    this.shadowMat.dispose();
    this.group.removeFromParent();
  }
}
