// What marks the homeowner without shouting: a soft contact shadow with a thin warm ring and a small notch that
// points where you face, a tiny "You" chip that shows when you arrive or walk somewhere and then fades, and a
// ripple where you clicked. None of it is pickable and the chip ignores the pointer (never steals a click).
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const CSS = /* css */ `
.rlt-you { position: absolute; width: 0; height: 0; pointer-events: none; font-family: Inter, system-ui, sans-serif; }
.rlt-you__chip { position: absolute; left: 0; bottom: 0; transform: translate(-50%, 0); display: flex; align-items: center; gap: 0.3125rem;
  padding: 0.125rem 0.5rem 0.125rem 0.375rem; border-radius: 999px; background: rgba(20,20,24,.62); color: #F4F1EC; white-space: nowrap;
  font-size: 0.6875rem; font-weight: 600; letter-spacing: .02em; line-height: 1rem; border: 1px solid rgba(245,194,107,.35);
  backdrop-filter: blur(10px) saturate(140%); -webkit-backdrop-filter: blur(10px) saturate(140%);
  box-shadow: 0 4px 14px rgba(0,0,0,.2); opacity: 0; transition: opacity .35s ease-out, transform .35s ease-out; }
.rlt-you__chip i { width: 0.375rem; height: 0.375rem; border-radius: 50%; background: #F5C26B; box-shadow: 0 0 0 2px rgba(245,194,107,.22); }
.rlt-you.is-on .rlt-you__chip { opacity: 1; transform: translate(-50%, -0.1875rem); }
.rlt-you.is-dim .rlt-you__chip { opacity: .55; }
@media (prefers-reduced-motion: reduce) { .rlt-you__chip { transition: opacity .2s linear; transform: translate(-50%, 0) !important; } }
`;

let styled = false;
function ensureStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.rlt = 'player-marker';
  el.textContent = CSS;
  document.head.appendChild(el);
}

let decalTex: THREE.Texture | null = null;
/** Contact shadow + ring + front notch on one texture (one draw). Canvas top = −Z (behind), bottom = +Z (front). */
function decalTexture(): THREE.Texture {
  if (decalTex) return decalTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const m = S / 2;
  const px = S / 1.0; // canvas px per meter (plane is 1 m wide)
  // contact shadow
  const sh = g.createRadialGradient(m, m, 0, m, m, 0.36 * px);
  sh.addColorStop(0, 'rgba(0,0,0,0.5)');
  sh.addColorStop(0.5, 'rgba(0,0,0,0.26)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh;
  g.fillRect(0, 0, S, S);
  // soft glow under the ring
  const r0 = 0.36 * px, r1 = 0.395 * px;
  const glow = g.createRadialGradient(m, m, r0 - 10, m, m, r1 + 12);
  glow.addColorStop(0, 'rgba(255,226,170,0)');
  glow.addColorStop(0.45, 'rgba(255,226,170,0.28)');
  glow.addColorStop(1, 'rgba(255,226,170,0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(m, m, r1 + 12, 0, Math.PI * 2);
  g.fill();
  // the ring, with a gap at the front where the notch sits
  g.strokeStyle = 'rgba(255,244,224,0.95)';
  g.lineWidth = r1 - r0;
  g.lineCap = 'round';
  const front = Math.PI / 2; // canvas +y = front
  const gap = 0.2;
  g.beginPath();
  g.arc(m, m, (r0 + r1) / 2, front + gap, front - gap + Math.PI * 2);
  g.stroke();
  // notch: a small chevron just outside the gap, pointing forward
  const ny = m + (r0 + r1) / 2;
  g.fillStyle = 'rgba(255,236,200,0.98)';
  g.beginPath();
  g.moveTo(m, ny + 0.06 * px);
  g.lineTo(m - 0.045 * px, ny - 0.012 * px);
  g.lineTo(m, ny + 0.012 * px);
  g.lineTo(m + 0.045 * px, ny - 0.012 * px);
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  decalTex = t;
  return t;
}

let rippleTex: THREE.Texture | null = null;
function rippleTexture(): THREE.Texture {
  if (rippleTex) return rippleTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const m = S / 2;
  const grd = g.createRadialGradient(m, m, m * 0.62, m, m, m * 0.98);
  grd.addColorStop(0, 'rgba(255,240,214,0)');
  grd.addColorStop(0.55, 'rgba(255,240,214,0.95)');
  grd.addColorStop(1, 'rgba(255,240,214,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(255,240,214,0.9)';
  g.beginPath();
  g.arc(m, m, S * 0.05, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  rippleTex = t;
  return t;
}

const DECAL_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const RIPPLE_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

export class PlayerMarker {
  readonly decal: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly chip: CSS2DObject;
  private el: HTMLDivElement;
  private showFor = 0;
  private on = false;
  private seated = false;

  constructor() {
    ensureStyles();
    const mat = new THREE.MeshBasicMaterial({ map: decalTexture(), transparent: true, depthWrite: false, opacity: 0.9, toneMapped: false });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    this.decal = new THREE.Mesh(DECAL_GEO, mat);
    this.decal.position.y = 0.01;
    this.decal.renderOrder = 2;
    this.decal.name = 'player-decal';
    this.decal.raycast = () => {}; // never in the way of a pick
    const el = document.createElement('div');
    el.className = 'rlt-you';
    el.innerHTML = '<div class="rlt-you__chip" aria-hidden="true"><i></i>You</div>';
    this.el = el;
    this.chip = new CSS2DObject(el);
    this.chip.center.set(0.5, 1);
  }

  /** Show the chip for a while (arrived, walking somewhere). */
  flash(seconds = 3.5) {
    this.showFor = Math.max(this.showFor, seconds);
  }

  setSeated(on: boolean) {
    this.seated = on;
  }

  tick(dt: number, walking: boolean) {
    if (this.showFor > 0) this.showFor -= dt;
    const on = walking || this.showFor > 0;
    if (on !== this.on) {
      this.on = on;
      this.el.classList.toggle('is-on', on);
    }
    // quieter when standing still, a touch brighter on the move, faint when seated (the chair covers it)
    const target = this.seated ? 0.45 : on ? 0.95 : 0.78;
    const m = this.decal.material;
    m.opacity += (target - m.opacity) * Math.min(1, dt * 4);
  }

  setVisible(on: boolean) {
    this.decal.visible = on;
    this.chip.visible = on;
    this.el.style.display = on ? '' : 'none';
  }

  dispose() {
    this.decal.material.dispose();
    this.decal.removeFromParent();
    this.chip.removeFromParent();
    this.el.remove();
  }
}

/** A short ripple where you clicked to walk (static and brief with reduced motion). */
export class Ripple {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private t = 1;

  constructor(private still: () => boolean) {
    const mat = new THREE.MeshBasicMaterial({ map: rippleTexture(), transparent: true, depthWrite: false, opacity: 0, toneMapped: false });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    this.mesh = new THREE.Mesh(RIPPLE_GEO, mat);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.name = 'player-ripple';
    this.mesh.raycast = () => {};
  }

  play(parent: THREE.Object3D, at: THREE.Vector3) {
    parent.add(this.mesh);
    this.mesh.position.set(at.x, at.y + 0.015, at.z);
    this.t = 0;
    this.mesh.visible = true;
  }

  tick(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / 0.75);
    const still = this.still();
    const s = still ? 0.55 : 0.25 + 0.5 * (1 - Math.pow(1 - this.t, 3));
    this.mesh.scale.setScalar(s);
    this.mesh.material.opacity = still ? (this.t < 0.6 ? 0.8 : 0.8 * (1 - (this.t - 0.6) / 0.4)) : 0.85 * (1 - this.t);
    if (this.t >= 1) this.mesh.visible = false;
  }

  dispose() {
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
