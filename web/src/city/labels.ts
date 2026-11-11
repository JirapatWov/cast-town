// DOM for the city's CSS2D overlays: building name tags (with status + "Needs you" badge), the agency tag,
// "Place here" chips for placement mode, and the driving HUD. Styles are injected once by the city.
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const CSS = `
.rlt-city-tag{--amber:#F5A524;font:500 0.75rem/1.25 Inter,"Helvetica Neue",Arial,sans-serif;color:#F4F1EC;pointer-events:auto;cursor:pointer;
  user-select:none;-webkit-user-select:none;transform-origin:50% 100%;transition:transform .18s ease,opacity .25s ease;display:flex;flex-direction:column;align-items:center;gap:0.25rem}
.rlt-city-tag__card{background:rgba(20,20,24,.72);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);
  border:1px solid rgba(255,255,255,.10);border-radius:0.75rem;padding:0.375rem 0.6875rem 0.4375rem;box-shadow:0 6px 22px rgba(0,0,0,.28);white-space:nowrap;text-align:center;
  transition:border-color .18s ease,background .18s ease}
.rlt-city-tag__name{font-weight:650;font-size:0.8125rem;letter-spacing:.01em}
.rlt-city-tag__meta{display:flex;align-items:center;justify-content:center;gap:0.375rem;margin-top:0.125rem;font-size:0.6875rem;color:rgba(244,241,236,.68)}
.rlt-city-tag__dot{width:0.4375rem;height:0.4375rem;border-radius:50%;background:#8a8f98;flex:none}
.rlt-city-tag[data-state=busy] .rlt-city-tag__dot{background:#F2C14E;box-shadow:0 0 8px #F2C14E}
.rlt-city-tag[data-state=approval] .rlt-city-tag__dot{background:var(--amber);box-shadow:0 0 8px var(--amber);animation:rlt-pulse 1.1s ease-in-out infinite}
.rlt-city-tag[data-state=error] .rlt-city-tag__dot{background:#E5484D}
.rlt-city-tag__badge{display:none;background:var(--amber);color:#1b1408;font-weight:700;font-size:0.6875rem;letter-spacing:.02em;padding:0.1875rem 0.5625rem;border-radius:999px;
  box-shadow:0 0 0 0 rgba(245,165,36,.6);animation:rlt-ring 1.6s ease-out infinite}
.rlt-city-tag[data-state=approval] .rlt-city-tag__badge{display:block}
.rlt-city-tag[data-state=approval] .rlt-city-tag__card{border-color:rgba(245,165,36,.55)}
.rlt-city-tag__stem{width:1px;height:0.875rem;background:linear-gradient(rgba(244,241,236,.55),rgba(244,241,236,0))}
.rlt-city-tag.is-hover{transform:scale(1.08)}
.rlt-city-tag.is-hover .rlt-city-tag__card{border-color:rgba(255,255,255,.38);background:rgba(28,28,33,.84)}
.rlt-city-tag.is-far .rlt-city-tag__meta{display:none}
.rlt-city-tag.is-landmark .rlt-city-tag__dot{background:conic-gradient(#D97757 0 25%,#10A37F 0 50%,#4D6BFE 0 75%,#8E75F0 0)}
.rlt-city-tag.is-landmark .rlt-city-tag__name{font-size:0.75rem;letter-spacing:.08em;text-transform:uppercase}
.rlt-city-chip{font:650 0.75rem/1 Inter,"Helvetica Neue",Arial,sans-serif;color:#1b1408;background:#F5A524;border-radius:999px;padding:0.4375rem 0.75rem 0.4375rem 0.625rem;
  pointer-events:auto;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:0.375rem;box-shadow:0 6px 18px rgba(0,0,0,.3);transition:transform .15s ease;
  user-select:none;-webkit-user-select:none}
.rlt-city-chip:hover,.rlt-city-chip.is-hover{transform:scale(1.08)}
.rlt-city-chip.is-far:not(.is-hover):not(:hover){padding:0.3125rem}
.rlt-city-chip.is-far:not(.is-hover):not(:hover) .rlt-city-chip__text{display:none}
.rlt-city-chip__plus{width:1rem;height:1rem;border-radius:50%;background:rgba(27,20,8,.16);display:grid;place-items:center;font-size:0.8125rem;font-weight:800}
.rlt-drive-hud{position:absolute;inset:0;z-index:100000;pointer-events:none;font:500 0.8125rem/1.3 Inter,"Helvetica Neue",Arial,sans-serif;color:#F4F1EC}
.rlt-drive-glass{background:rgba(20,20,24,.72);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);
  border:1px solid rgba(255,255,255,.10);border-radius:0.875rem;box-shadow:0 10px 30px rgba(0,0,0,.3)}
.rlt-drive-exit{position:absolute;top:1rem;right:1rem;pointer-events:auto;cursor:pointer;padding:0.5625rem 0.875rem;display:flex;gap:0.5rem;align-items:center;
  color:#F4F1EC;font:inherit;font-weight:600}
.rlt-drive-exit:hover{background:rgba(36,36,42,.86)}
.rlt-drive-kbd{display:inline-block;min-width:1.125rem;padding:1px 0.3125rem;border-radius:0.3125rem;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.07);
  font-size:0.6875rem;font-weight:650;text-align:center;color:#F4F1EC}
.rlt-drive-speed{position:absolute;left:1rem;bottom:1rem;padding:0.625rem 1rem 0.6875rem;min-width:96px}
.rlt-drive-speed b{display:block;font-size:1.875rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.rlt-drive-speed span{font-size:0.6875rem;color:rgba(244,241,236,.6);letter-spacing:.08em}
.rlt-drive-help{position:absolute;right:1rem;bottom:1rem;padding:0.5625rem 0.8125rem;display:flex;gap:0.75rem;align-items:center;color:rgba(244,241,236,.75);font-size:0.75rem}
.rlt-drive-prompt{position:absolute;left:50%;bottom:22%;transform:translate(-50%,0.5rem);opacity:0;transition:opacity .2s ease,transform .2s ease;padding:0.6875rem 1.125rem;
  display:flex;gap:0.625rem;align-items:center;font-size:0.875rem;font-weight:600;white-space:nowrap;border-color:rgba(245,165,36,.5)}
.rlt-drive-prompt.is-on{opacity:1;transform:translate(-50%,0)}
.rlt-drive-prompt .rlt-drive-kbd{background:#F5A524;color:#1b1408;border-color:#F5A524;font-size:0.75rem;padding:0.125rem 0.4375rem}
@keyframes rlt-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
@keyframes rlt-ring{0%{box-shadow:0 0 0 0 rgba(245,165,36,.55)}100%{box-shadow:0 0 0 10px rgba(245,165,36,0)}}
@media (prefers-reduced-motion:reduce){.rlt-city-tag__badge,.rlt-city-tag__dot{animation:none!important}}
`;

export function injectCityCss(): void {
  if (typeof document === 'undefined' || document.getElementById('rlt-city-css')) return;
  const s = document.createElement('style');
  s.id = 'rlt-city-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export type TagState = 'idle' | 'busy' | 'approval' | 'error';

export class BuildingTag {
  readonly object: CSS2DObject;
  readonly root: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private metaText: HTMLSpanElement;
  private state: TagState | null = null;
  private meta = '';

  constructor(name: string, onClick: () => void, opts: { landmark?: boolean; badge?: string } = {}) {
    this.root = el('div', 'rlt-city-tag' + (opts.landmark ? ' is-landmark' : ''));
    const badge = el('div', 'rlt-city-tag__badge', opts.badge ?? 'Needs you');
    const card = el('div', 'rlt-city-tag__card');
    this.nameEl = el('div', 'rlt-city-tag__name', name);
    const meta = el('div', 'rlt-city-tag__meta');
    meta.append(el('i', 'rlt-city-tag__dot'), (this.metaText = el('span', '')));
    card.append(this.nameEl, meta);
    this.root.append(badge, card, el('div', 'rlt-city-tag__stem'));
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    this.object = new CSS2DObject(this.root);
    this.object.center.set(0.5, 1);
  }

  setName(name: string): void {
    if (this.nameEl.textContent !== name) this.nameEl.textContent = name;
  }

  set(state: TagState, meta: string): void {
    if (state !== this.state) this.root.dataset.state = this.state = state;
    if (meta !== this.meta) this.metaText.textContent = this.meta = meta;
  }

  setHover(on: boolean): void {
    this.root.classList.toggle('is-hover', on);
  }

  /** Distance-based detail level and fade. */
  setDistance(d: number): void {
    this.root.classList.toggle('is-far', d > 170);
    const o = d < 420 ? 1 : Math.max(0, 1 - (d - 420) / 160);
    this.root.style.opacity = o.toFixed(2);
    this.root.style.visibility = o <= 0.01 ? 'hidden' : '';
  }
}

export function placeChip(onClick: () => void, onHover: (on: boolean) => void): CSS2DObject {
  const c = el('div', 'rlt-city-chip');
  c.append(el('span', 'rlt-city-chip__plus', '+'), el('span', 'rlt-city-chip__text', 'Place here'));
  c.addEventListener('pointerdown', (e) => e.stopPropagation());
  c.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  c.addEventListener('pointerenter', () => onHover(true));
  c.addEventListener('pointerleave', () => onHover(false));
  const o = new CSS2DObject(c);
  o.center.set(0.5, 1);
  return o;
}

export interface DriveHud {
  readonly root: HTMLDivElement;
  setSpeed(kmh: number): void;
  setPrompt(text: string | null): void;
  show(on: boolean): void;
}

export function createDriveHud(onExit: () => void): DriveHud {
  const root = el('div', 'rlt-drive-hud');
  root.style.display = 'none';
  const exit = el('button', 'rlt-drive-glass rlt-drive-exit');
  exit.type = 'button';
  exit.append(document.createTextNode('Exit car'), el('span', 'rlt-drive-kbd', 'Esc'));
  exit.addEventListener('click', (e) => {
    e.stopPropagation();
    onExit();
  });
  const speed = el('div', 'rlt-drive-glass rlt-drive-speed');
  const num = el('b', '', '0');
  speed.append(num, el('span', '', 'KM/H'));
  const help = el('div', 'rlt-drive-glass rlt-drive-help');
  const kv = (k: string, v: string) => {
    const s = el('span', '');
    s.append(el('span', 'rlt-drive-kbd', k), document.createTextNode(' ' + v));
    return s;
  };
  help.append(kv('W A S D', 'drive'), kv('Space', 'brake'), kv('E', 'enter'));
  const prompt = el('div', 'rlt-drive-glass rlt-drive-prompt');
  const promptKey = el('span', 'rlt-drive-kbd', 'E');
  const promptText = el('span', '');
  prompt.append(promptKey, promptText);
  root.append(exit, speed, help, prompt);
  let lastSpeed = -1;
  let lastPrompt: string | null = null;
  return {
    root,
    setSpeed(kmh) {
      const v = Math.round(Math.abs(kmh));
      if (v !== lastSpeed) num.textContent = String((lastSpeed = v));
    },
    setPrompt(text) {
      if (text === lastPrompt) return;
      lastPrompt = text;
      if (text) promptText.textContent = text;
      prompt.classList.toggle('is-on', !!text);
    },
    show(on) {
      root.style.display = on ? '' : 'none';
    },
  };
}
