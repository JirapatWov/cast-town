// Living-room TV: renders the project's git diff into a CanvasTexture and slowly auto-scrolls it,
// like a code-review channel. Clicking the TV opens the real diff viewer (handled by the UI).
import * as THREE from 'three';
import type { GitSummary } from '../../../shared/protocol';

const W = 1280, H = 736;
const LINE_H = 23;
const BODY_TOP = 112;

type Row =
  | { t: 'file'; path: string; add: number; del: number }
  | { t: 'hunk'; text: string }
  | { t: 'line'; kind: '+' | '-' | ' '; text: string; oldNo?: number; newNo?: number };

export class TvScreen {
  readonly material: THREE.MeshBasicMaterial;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private summary: GitSummary | null = null;
  private projectName = '';
  private rows: Row[] = [];
  private scroll = 0;
  private pause = 1.5;
  private acc = 0;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.material = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false, color: new THREE.Color(1.15, 1.15, 1.15) });
    this.draw();
  }

  setProject(name: string) {
    this.projectName = name;
    this.draw();
  }

  setSummary(summary: GitSummary | null) {
    this.summary = summary;
    this.rows = summary ? parseDiff(summary.diff) : [];
    this.scroll = 0;
    this.pause = 1.5;
    this.draw();
  }

  update(dt: number) {
    this.acc += dt;
    if (this.acc < 0.12) return; // ~8 fps redraw
    const step = this.acc;
    this.acc = 0;
    const visible = Math.floor((H - BODY_TOP - 10) / LINE_H);
    if (this.rows.length > visible) {
      if (this.pause > 0) this.pause -= step;
      else {
        const before = Math.floor(this.scroll);
        this.scroll += step * 2.4;
        const crossed = this.rows.slice(before + 1, Math.floor(this.scroll) + 1).some((r) => r.t === 'file');
        if (crossed) { this.scroll = Math.floor(this.scroll); this.pause = 2.2; }
        if (this.scroll > this.rows.length - visible + 4) { this.scroll = 0; this.pause = 2.5; }
      }
    }
    this.draw();
  }

  private draw() {
    const g = this.g;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#16181d');
    bg.addColorStop(1, '#0f1114');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const s = this.summary;
    if (!s || !s.isGit || !s.files.length) { this.drawIdle(s); this.tex.needsUpdate = true; return; }

    // header
    const adds = s.files.reduce((n, f) => n + f.additions, 0);
    const dels = s.files.reduce((n, f) => n + f.deletions, 0);
    g.fillStyle = '#1d2026';
    g.fillRect(0, 0, W, 64);
    g.font = '600 26px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillStyle = '#F4F1EC';
    g.fillText(`⎇ ${s.branch ?? 'HEAD'}`, 28, 33);
    const bw = g.measureText(`⎇ ${s.branch ?? 'HEAD'}`).width;
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillStyle = '#A8A29E';
    const filesTxt = `${s.files.length} file${s.files.length === 1 ? '' : 's'} changed`;
    g.fillText(filesTxt, 52 + bw, 34);
    let x = 64 + bw + g.measureText(filesTxt).width;
    g.fillStyle = '#3FB37F'; g.fillText(`+${adds}`, x, 34); x += g.measureText(`+${adds}`).width + 12;
    g.fillStyle = '#E5484D'; g.fillText(`−${dels}`, x, 34);
    // live pill
    g.textAlign = 'right';
    g.fillStyle = '#E5484D';
    g.beginPath(); g.arc(W - 118, 33, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#F4F1EC';
    g.font = '600 20px Inter, system-ui, sans-serif';
    g.fillText('LIVE DIFF', W - 26, 34);
    // file chips
    g.textAlign = 'left';
    g.font = '500 17px "JetBrains Mono", ui-monospace, monospace';
    let cx = 24;
    for (const f of s.files.slice(0, 6)) {
      const label = `${statusGlyph(f.status)} ${f.path}`;
      const w = g.measureText(label).width + 22;
      if (cx + w > W - 24) break;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      roundRect(g, cx, 74, w, 28, 8); g.fill();
      g.fillStyle = f.status === '??' || f.status === 'A' ? '#7fd3a8' : f.status === 'D' ? '#f08b8e' : '#d6dae2';
      g.fillText(label, cx + 11, 89);
      cx += w + 8;
    }

    // body
    g.save();
    g.beginPath(); g.rect(0, BODY_TOP, W, H - BODY_TOP); g.clip();
    const first = Math.floor(this.scroll), frac = this.scroll - first;
    const visible = Math.ceil((H - BODY_TOP) / LINE_H) + 1;
    for (let i = 0; i < visible; i++) {
      const row = this.rows[first + i];
      if (!row) break;
      const y = BODY_TOP + (i - frac) * LINE_H;
      this.drawRow(row, y);
    }
    g.restore();
    // fade at the bottom
    const fade = g.createLinearGradient(0, H - 60, 0, H);
    fade.addColorStop(0, 'rgba(15,17,20,0)');
    fade.addColorStop(1, 'rgba(15,17,20,0.95)');
    g.fillStyle = fade;
    g.fillRect(0, H - 60, W, 60);
    this.tex.needsUpdate = true;
  }

  private drawRow(row: Row, y: number) {
    const g = this.g;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    if (row.t === 'file') {
      g.fillStyle = '#232730';
      g.fillRect(0, y, W, LINE_H);
      g.font = '600 17px "JetBrains Mono", ui-monospace, monospace';
      g.fillStyle = '#F4F1EC';
      g.fillText(row.path, 24, y + LINE_H / 2 + 1);
      g.textAlign = 'right';
      g.fillStyle = '#3FB37F';
      g.fillText(`+${row.add}`, W - 80, y + LINE_H / 2 + 1);
      g.fillStyle = '#E5484D';
      g.fillText(`−${row.del}`, W - 24, y + LINE_H / 2 + 1);
      return;
    }
    if (row.t === 'hunk') {
      g.fillStyle = 'rgba(110,140,255,0.08)';
      g.fillRect(0, y, W, LINE_H);
      g.font = '500 15px "JetBrains Mono", ui-monospace, monospace';
      g.fillStyle = '#8ea2ff';
      g.fillText(row.text.slice(0, 110), 24, y + LINE_H / 2 + 1);
      return;
    }
    if (row.kind === '+') { g.fillStyle = 'rgba(63,179,127,0.16)'; g.fillRect(0, y, W, LINE_H); g.fillStyle = '#3FB37F'; g.fillRect(0, y, 4, LINE_H); }
    if (row.kind === '-') { g.fillStyle = 'rgba(229,72,77,0.16)'; g.fillRect(0, y, W, LINE_H); g.fillStyle = '#E5484D'; g.fillRect(0, y, 4, LINE_H); }
    g.font = '400 15px "JetBrains Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.textAlign = 'right';
    if (row.oldNo) g.fillText(String(row.oldNo), 62, y + LINE_H / 2 + 1);
    if (row.newNo) g.fillText(String(row.newNo), 108, y + LINE_H / 2 + 1);
    g.textAlign = 'left';
    g.fillStyle = row.kind === '+' ? '#b9f0d2' : row.kind === '-' ? '#ffc4c6' : '#c9ced8';
    g.fillText(`${row.kind === ' ' ? ' ' : row.kind} ${row.text.replace(/\t/g, '  ')}`.slice(0, 118), 124, y + LINE_H / 2 + 1);
  }

  private drawIdle(s: GitSummary | null) {
    const g = this.g;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const glow = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.6);
    glow.addColorStop(0, 'rgba(63,179,127,0.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#F4F1EC';
    g.font = '600 54px Inter, system-ui, sans-serif';
    g.fillText(this.projectName || 'CAST', W / 2, H / 2 - 50);
    g.font = '500 28px Inter, system-ui, sans-serif';
    g.fillStyle = '#A8A29E';
    const msg = !s ? 'Waiting for changes…' : !s.isGit ? 'Not a git repository' : `${s.branch ?? 'HEAD'} · working tree clean ✓`;
    g.fillText(msg, W / 2, H / 2 + 22);
    g.font = '500 20px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(244,241,236,0.45)';
    g.fillText('Edits made by your agents appear here live', W / 2, H / 2 + 74);
  }
}

function statusGlyph(st: string): string {
  if (st === '??' || st === 'A') return '+';
  if (st === 'D') return '−';
  if (st.startsWith('R')) return '→';
  return '●';
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function parseDiff(diff: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0, newNo = 0;
  let current: Extract<Row, { t: 'file' }> | null = null;
  for (const raw of diff.split('\n').slice(0, 4000)) {
    if (raw.startsWith('diff --git')) {
      const m = raw.match(/ b\/(.+)$/);
      current = { t: 'file', path: m ? m[1] : raw.slice(11), add: 0, del: 0 };
      rows.push(current);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) continue;
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldNo = m ? +m[1] : 0;
      newNo = m ? +m[2] : 0;
      rows.push({ t: 'hunk', text: raw });
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) { rows.push({ t: 'line', kind: '+', text: raw.slice(1), newNo: newNo++ }); current.add++; }
    else if (raw.startsWith('-')) { rows.push({ t: 'line', kind: '-', text: raw.slice(1), oldNo: oldNo++ }); current.del++; }
    else if (raw.startsWith(' ')) rows.push({ t: 'line', kind: ' ', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}
