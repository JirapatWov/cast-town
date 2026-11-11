// Job board: a cork pinboard showing the workflow pipeline — one pinned card per role (vendor stripe,
// model, live status, verdict stamp), red yarn between them, a loop-back string with the round count,
// and the task note. Clicking it opens the Workflow panel (handled by the UI).
import * as THREE from 'three';
import { VENDOR_COLORS, type Vendor, type Workflow, type WorkflowRun, type WorkflowRunStep } from '../../../shared/protocol';
import { mulberry32 } from '../people/rng';
import { pointWord } from '../ui/touch';

const W = 1024, H = 640;

export class Corkboard {
  readonly material: THREE.MeshStandardMaterial;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private cork: HTMLCanvasElement;
  private run: WorkflowRun | null = null;
  private workflow: Workflow | null = null;
  private t = 0;
  private acc = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.cork = makeCork();
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.material = new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.92, emissive: '#ffffff', emissiveMap: this.tex, emissiveIntensity: 0.12 });
    this.draw();
  }

  set(run: WorkflowRun | null, workflow: Workflow | null) {
    this.run = run;
    this.workflow = workflow;
    this.draw();
  }

  /** Free the canvas texture and material (the room that showed this board was torn down). */
  dispose() {
    this.run = null;
    this.workflow = null;
    this.tex.dispose();
    this.material.dispose();
  }

  update(dt: number) {
    this.t += dt;
    if (!this.run || !['running', 'waiting_approval'].includes(this.run.status)) return;
    this.acc += dt;
    if (this.acc < 0.2) return; // gentle pulse on the active card
    this.acc = 0;
    this.draw();
  }

  private draw() {
    const g = this.g;
    g.drawImage(this.cork, 0, 0);
    const wf = this.workflow;
    if (!wf) { this.drawEmpty(); this.tex.needsUpdate = true; return; }
    const run = this.run;
    const steps = wf.steps;
    const latest = new Map<string, WorkflowRunStep>();
    for (const s of run?.steps ?? []) latest.set(s.stepId, s);

    // task note (top-left paper)
    this.paper(40, 34, 560, 128, -0.012, '#fbf6ea');
    g.fillStyle = '#6b6259';
    g.font = '600 20px Inter, system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillText(`${wf.icon}  ${wf.name}`, 64, 72);
    g.fillStyle = '#2b2622';
    g.font = '500 25px Inter, "IBM Plex Sans Thai", system-ui, sans-serif';
    wrap(g, run?.task ?? `No run yet — ${pointWord().toLowerCase()} to plan one`, 64, 110, 510, 30, 2);
    this.pin(320, 44, '#E5484D');

    // status sticky (top-right)
    const st = run?.status ?? 'idle';
    const stColor: Record<string, string> = { running: '#cfe3ff', waiting_approval: '#ffe2a8', completed: '#c9efd9', failed: '#ffd0d1', aborted: '#e5e0d8', idle: '#f3edc4' };
    const stLabel: Record<string, string> = { running: 'RUNNING', waiting_approval: 'NEEDS YOU', completed: 'DONE ✓', failed: 'FAILED', aborted: 'STOPPED', idle: 'READY' };
    this.paper(700, 40, 270, 120, 0.03, stColor[st] ?? '#f3edc4');
    g.fillStyle = '#2b2622';
    g.font = '700 30px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(stLabel[st] ?? st.toUpperCase(), 835, 96);
    g.font = '500 20px Inter, system-ui, sans-serif';
    g.fillStyle = '#5d554d';
    const maxLoops = steps.find((s) => s.loopBackTo)?.maxLoops ?? 2;
    g.fillText(run ? `Round ${run.loop + 1}/${maxLoops + 1}  ·  $${run.costUsd.toFixed(2)}` : `${pointWord()} to run`, 835, 132);
    this.pin(835, 50, '#3FB37F');

    // role cards: up to 3 at full size; bigger teams (up to 12) shrink to fit one row
    const n = steps.length;
    const cw = 250, ch = 290, minGap = 14;
    const k = Math.min(1, (W - 80 + minGap) / (n * (cw + minGap)));
    const sw = cw * k, sh = ch * k;
    const gap = n > 1 ? Math.min(80, (W - 80 - n * sw) / (n - 1)) : 0;
    const x0 = (W - (n * sw + (n - 1) * gap)) / 2;
    const y0 = 238;
    const working = new Set(run?.currentStepIds?.length ? run.currentStepIds : run?.currentStepId ? [run.currentStepId] : []); // a parallel group has several
    const centers: [number, number][] = [];
    steps.forEach((step, i) => {
      const x = x0 + i * (sw + gap);
      const r = mulberry32(i * 97 + 3);
      const rot = (r() - 0.5) * 0.05;
      const rs = latest.get(step.id);
      const active = working.has(step.id) && (run?.status === 'running' || run?.status === 'waiting_approval');
      const vendor = vendorOf(step.model);
      const vc = VENDOR_COLORS[vendor];
      centers.push([x + sw / 2, y0 + 16 * k]);
      g.save();
      g.translate(x + sw / 2, y0 + sh / 2);
      g.rotate(rot);
      g.scale(k, k);
      // glow for the active card
      if (active) {
        const pulse = 0.55 + 0.45 * Math.sin(this.t * 3.2);
        g.shadowColor = run?.status === 'waiting_approval' ? `rgba(245,165,36,${0.9 * pulse})` : `rgba(77,155,255,${0.9 * pulse})`;
        g.shadowBlur = 34;
      } else {
        g.shadowColor = 'rgba(0,0,0,0.35)';
        g.shadowBlur = 14;
        g.shadowOffsetY = 6;
      }
      g.fillStyle = '#fffdf8';
      g.fillRect(-cw / 2, -ch / 2, cw, ch);
      g.shadowColor = 'transparent';
      g.fillStyle = vc;
      g.fillRect(-cw / 2, -ch / 2, cw, 46);
      g.fillStyle = '#ffffff';
      g.font = '700 22px Inter, system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText(`${i + 1}`, -cw / 2 + 16, -ch / 2 + 31);
      g.font = '600 18px Inter, system-ui, sans-serif';
      g.textAlign = 'right';
      g.fillText(step.kind === 'review' ? 'REVIEW' : 'WORK', cw / 2 - 16, -ch / 2 + 30);
      g.textAlign = 'center';
      g.fillStyle = '#211d1a';
      g.font = '700 32px Inter, system-ui, sans-serif';
      g.fillText(step.name, 0, -ch / 2 + 98);
      g.fillStyle = '#6b6259';
      g.font = '500 19px Inter, system-ui, sans-serif';
      g.fillText(shortModel(step.model), 0, -ch / 2 + 130);
      // status line
      const status = rs?.status ?? 'pending';
      const sc: Record<string, string> = { pending: '#a8a29e', running: '#4d9bff', done: '#3FB37F', failed: '#E5484D', skipped: '#a8a29e' };
      const label: Record<string, string> = { pending: 'waiting', running: active && run?.status === 'waiting_approval' ? 'needs approval' : 'working…', done: 'done', failed: 'failed', skipped: 'skipped' };
      g.fillStyle = active && run?.status === 'waiting_approval' ? '#F5A524' : sc[status];
      g.beginPath(); g.arc(-58, -ch / 2 + 178, 8, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3b3530';
      g.font = '600 21px Inter, system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillText(label[status], -42, -ch / 2 + 185);
      if (rs?.startedAt) {
        const secs = Math.round(((rs.endedAt ?? Date.now()) - rs.startedAt) / 1000);
        g.fillStyle = '#8a827a';
        g.font = '500 17px Inter, system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`, 0, -ch / 2 + 220);
      }
      // verdict stamp
      if (rs?.verdict) {
        g.save();
        g.translate(10, ch / 2 - 46);
        g.rotate(-0.18);
        const ok = rs.verdict === 'approve';
        g.strokeStyle = ok ? 'rgba(46,150,100,0.85)' : 'rgba(205,50,55,0.85)';
        g.fillStyle = g.strokeStyle;
        g.lineWidth = 4;
        g.strokeRect(-86, -24, 172, 48);
        g.font = '800 28px Inter, system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(ok ? 'APPROVED' : 'REVISE', 0, 2);
        g.restore();
      }
      g.restore();
    });
    // yarn between cards, then the pins on top
    g.strokeStyle = 'rgba(190,40,45,0.9)';
    g.lineWidth = 3;
    for (let i = 0; i < centers.length - 1; i++) {
      const [ax, ay] = centers[i], [bx, by] = centers[i + 1];
      g.beginPath();
      g.moveTo(ax, ay);
      g.quadraticCurveTo((ax + bx) / 2, ay + 26, bx, by);
      g.stroke();
    }
    steps.forEach((step, i) => {
      if (!step.loopBackTo) return;
      const j = steps.findIndex((s) => s.id === step.loopBackTo);
      if (j < 0) return;
      const [ax] = centers[i], [bx] = centers[j];
      const yb = y0 + sh + 30;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.moveTo(ax, y0 + sh - 4);
      g.bezierCurveTo(ax, yb + 30, bx, yb + 30, bx, y0 + sh - 4);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(190,40,45,0.95)';
      g.beginPath();
      g.moveTo(bx, y0 + sh - 6); g.lineTo(bx - 9, y0 + sh + 10); g.lineTo(bx + 9, y0 + sh + 10); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = '600 18px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('if revise ↺', (ax + bx) / 2, yb + 30);
    });
    centers.forEach(([x, y], i) => this.pin(x, y, ['#F5A524', '#4D6BFE', '#10A37F', '#8E75F0'][i % 4]));
    this.tex.needsUpdate = true;
  }

  private drawEmpty() {
    const g = this.g;
    this.paper(300, 190, 420, 250, -0.02, '#fbf6ea');
    g.fillStyle = '#2b2622';
    g.textAlign = 'center';
    g.font = '700 34px Inter, system-ui, sans-serif';
    g.fillText('Job board', 510, 270);
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillStyle = '#6b6259';
    g.fillText('No workflow yet.', 510, 320);
    g.fillText(`${pointWord()} to plan a team run →`, 510, 356);
    this.pin(510, 205, '#E5484D');
    this.paper(110, 120, 150, 150, 0.06, '#f6e7a0');
    this.paper(780, 380, 150, 150, -0.05, '#cfe3ff');
  }

  private paper(x: number, y: number, w: number, h: number, rot: number, color: string) {
    const g = this.g;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(rot);
    g.shadowColor = 'rgba(0,0,0,0.3)';
    g.shadowBlur = 12;
    g.shadowOffsetY = 5;
    g.fillStyle = color;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.restore();
  }

  private pin(x: number, y: number, color: string) {
    const g = this.g;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 5;
    g.shadowOffsetX = 3;
    g.shadowOffsetY = 4;
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.arc(x - 3.5, y - 3.5, 3.5, 0, Math.PI * 2); g.fill();
  }
}

/** The cork backdrop is the same for every board (fixed seed): drawn once (26k specks, ~0.1 s), shared read-only. */
let corkCanvas: HTMLCanvasElement | null = null;

function makeCork(): HTMLCanvasElement {
  if (corkCanvas) return corkCanvas;
  const c = (corkCanvas = document.createElement('canvas'));
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b98c5c';
  g.fillRect(0, 0, W, H);
  const r = mulberry32(5);
  for (let i = 0; i < 26000; i++) {
    const v = r();
    g.fillStyle = v < 0.5 ? `rgba(90,55,25,${0.12 + r() * 0.2})` : `rgba(235,195,140,${0.1 + r() * 0.2})`;
    const s = 1 + r() * 3;
    g.fillRect(r() * W, r() * H, s, s);
  }
  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(60,35,15,0.25)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
  return c;
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number) {
  const words = text.split(/\s+/);
  let line = '';
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) { g.fillText(`${line}…`, x, y); return; }
      g.fillText(line, x, y);
      y += lh;
      line = words[i];
    } else line = test;
  }
  if (line) g.fillText(line, x, y);
}

export function vendorOf(model: string): Vendor {
  const [prefix, rest = ''] = model.split('/');
  if (prefix in VENDOR_COLORS && prefix !== 'other') return prefix as Vendor;
  const m = (rest || prefix).toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt') || /^o\d/.test(m)) return 'openai';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gemini')) return 'google';
  return 'other';
}

export function shortModel(model: string): string {
  const name = model.split('/').pop() ?? model;
  const special: Record<string, string> = { gpt: 'GPT', deepseek: 'DeepSeek', claude: 'Claude', gemini: 'Gemini' };
  const parts = name.split('-');
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(p) && prev && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else out.push(special[p] ?? (p.length <= 2 && /\d/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  return out.join(' ');
}
