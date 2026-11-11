// Formatting + domain helpers shared across panels.
import {
  VENDOR_COLORS, type Activity, type AgentInfo, type Lot, type ModelInfo, type ThinkingLevel, type Vendor,
} from '../../../shared/protocol';

export const VENDOR_LABEL: Record<Vendor, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  google: 'Google',
  openrouter: 'OpenRouter',
  other: 'Other',
};

export const VENDOR_ORDER: Vendor[] = ['anthropic', 'openai', 'deepseek', 'google', 'openrouter', 'other'];

export function vendorColor(v: Vendor | undefined): string {
  return VENDOR_COLORS[v ?? 'other'] ?? VENDOR_COLORS.other;
}

export function vendorOfModel(id: string, models: ModelInfo[]): Vendor {
  const m = models.find((x) => x.id === id);
  if (m) return m.vendor;
  const prefix = id.split('/')[0] as Vendor;
  return prefix in VENDOR_COLORS ? prefix : 'other';
}

export function modelLabel(id: string, models: ModelInfo[]): string {
  const m = models.find((x) => x.id === id);
  if (m) return modelNames(models).get(id) ?? m.label;
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const namesOf = new WeakMap<ModelInfo[], Map<string, string>>();

/** What pickers call each model: its name, plus the sign-in it runs through when another listed model has the same
 *  name ("Claude Opus 5.5 · via Antigravity" next to "Claude Opus 5.5"). Kept per list (the store replaces it). */
export function modelNames(models: ModelInfo[]): Map<string, string> {
  const known = namesOf.get(models);
  if (known) return known;
  const count = new Map<string, number>();
  for (const m of models) count.set(m.label.toLowerCase(), (count.get(m.label.toLowerCase()) ?? 0) + 1);
  const names = new Map(models.map((m) => [m.id, m.route && (count.get(m.label.toLowerCase()) ?? 0) > 1 ? `${m.label} · via ${m.route}` : m.label]));
  namesOf.set(models, names);
  return names;
}

/** One section of a model picker: a maker's models reached directly (or not connected), or the ones another sign-in
 *  brings (route), e.g. Antigravity's Claude and Gemini models under Google. */
export interface ModelGroup {
  vendor: Vendor;
  route?: string;
  models: ModelInfo[];
}

/** Picker sections in VENDOR_ORDER: each maker's own models first, then one section per other sign-in. */
export function modelGroups(models: ModelInfo[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const vendor of VENDOR_ORDER) {
    const mine = models.filter((m) => m.vendor === vendor);
    const direct = mine.filter((m) => !m.route);
    if (direct.length) out.push({ vendor, models: direct });
    for (const route of [...new Set(mine.map((m) => m.route).filter((r): r is string => !!r))]) {
      out.push({ vendor, route, models: mine.filter((m) => m.route === route) });
    }
  }
  return out;
}

/** "Google", "Google · via Antigravity"; a provider without a card is named by itself ("Xai"). */
export function modelGroupTitle(g: Pick<ModelGroup, 'vendor' | 'route'>): string {
  if (!g.route || g.route === VENDOR_LABEL[g.vendor]) return VENDOR_LABEL[g.vendor];
  return g.vendor === 'other' ? g.route : `${VENDOR_LABEL[g.vendor]} · via ${g.route}`;
}

export function modelAvailable(id: string, models: ModelInfo[]): boolean {
  return models.find((x) => x.id === id)?.available ?? false;
}

export const THINKING_LABEL: Record<ThinkingLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max' };

/** Off plus the levels a model offers (omp's ladder; unknown → low…high). A picked level the model lacks stays
 *  listed — omp lowers it to the nearest one the model has. */
export function thinkingChoices(model: string, models: ModelInfo[], current?: ThinkingLevel): ThinkingLevel[] {
  const out: ThinkingLevel[] = ['off', ...(models.find((m) => m.id === model)?.thinking ?? ['low', 'medium', 'high'])];
  if (current && !out.includes(current)) out.push(current);
  return out;
}

/** Some AI account is signed in (a model it lists is available). With none, nobody can work. */
export function anyConnected(models: ModelInfo[]): boolean {
  return models.some((m) => m.available);
}

/** The model can't be picked: something is connected, but not this model's provider. With nothing connected every
 *  model can still be picked (people work once an account is connected), so nothing is blocked then. */
export function modelBlocked(id: string, models: ModelInfo[]): boolean {
  return anyConnected(models) && !modelAvailable(id, models);
}

/** A person the server won't start: their model isn't connected, whether another account is connected or none is.
 *  The server says so (AgentInfo.notConnected: it knows every connected model, the list only some); an older server
 *  doesn't, so then the list decides. Helpers never: omp runs them on a connected model. `scripted`: the server runs
 *  people on its scripted test model (hello.demoMode, CAST_MOCK_LLM only). `checking`: the first account check still
 *  runs — the server holds a message until it is done, so nothing is locked yet. */
export function agentBlocked(a: Pick<AgentInfo, 'model'> & Partial<Pick<AgentInfo, 'kind' | 'notConnected'>>, models: ModelInfo[], o: { scripted?: boolean; checking?: boolean } = {}): boolean {
  if (o.scripted || o.checking || a.kind === 'subagent') return false;
  return a.notConnected ?? !modelAvailable(a.model, models);
}

/** "A", "A and B", "A, B and C". */
export function listJoin(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function fmtUsd(n: number | undefined): string {
  const v = n ?? 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '<$0.01';
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const ACTIVITY_TEXT: Record<Activity, string> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  reading: 'Reading',
  writing: 'Writing',
  running: 'Running a command',
  searching: 'Searching the web',
  delegating: 'Briefing helpers',
  waiting_approval: 'Waiting for you',
  error: 'Hit an error',
  done: 'Done',
  handoff: 'Handing off',
  chore: 'Helping out',
};

export type StatusTone = 'idle' | 'work' | 'wait' | 'error' | 'ok' | 'off';

export function agentTone(a: AgentInfo): StatusTone {
  if (a.activity === 'waiting_approval') return 'wait';
  if (a.status === 'error' || a.activity === 'error') return 'error';
  if (a.status === 'offline') return 'off';
  if (a.activity === 'done') return 'ok';
  if (a.status === 'busy' || a.status === 'starting') return 'work';
  if (a.activity !== 'idle') return 'work';
  return 'idle';
}

/** What "Set up git" does, in the same words at Place project and in the Changes tab: a local first commit, nothing
 *  uploaded, and what is left out (server: git.ts SETUP_EXCLUDES). */
export const SET_UP_GIT_TEXT =
  'Makes this folder a git repository with one local commit of its files — nothing is uploaded, and your files stay as they are. Left out: node_modules, venv, .env files and logs.';

/** What "Off duty" means, for tooltips next to it (the town's word for a person whose omp isn't running). */
export const OFF_DUTY_HINT = 'Off duty: not running right now. They start as soon as you give them a task.';

/** `helpers`: how many of the person's helpers are still working, when the caller counted them (the chat header does). */
export function agentStatusText(a: AgentInfo, helpers?: number): string {
  // one story with the red dot (agentTone): "Couldn’t start", "Interrupted by a restart", … — never a red "Idle"
  if (agentTone(a) === 'error') return a.detail || ACTIVITY_TEXT.error || 'Hit an error';
  if (a.status === 'offline') return 'Off duty';
  if (a.status === 'starting') return a.detail || 'Getting ready'; // "Checking AI accounts…", "Still getting ready (50 s)…"
  // busy only because helpers work in the background: a new message starts a turn right away
  if (a.available && a.status === 'busy') return helpers ? `Free to talk · ${helpers} helper${helpers === 1 ? '' : 's'} working` : 'Free to talk · helpers working';
  if (a.detail && a.activity !== 'idle' && a.activity !== 'done') return a.detail;
  return ACTIVITY_TEXT[a.activity] ?? a.activity;
}

/** One word for a person's trouble (a job's status in the switcher): "Couldn’t start", "Interrupted", "Crashed". */
export function problemWord(a: AgentInfo): string {
  if (a.interrupted) return 'Interrupted';
  if (a.detail === 'Couldn’t start') return a.detail;
  if (a.detail?.startsWith('Crashed')) return 'Crashed';
  return 'Error';
}

/** Mid-turn (or waiting for helpers). The composer also checks `available`: a lead whose helpers run in the
 *  background is busy here (no New chat) but free to talk. */
export function isAgentBusy(a: AgentInfo | undefined): boolean {
  if (!a) return false;
  return a.status === 'busy' || a.status === 'starting';
}

/** A reason as the start of a sentence: its first letter up — but a command's name ("cast-agent", or "omp" from an
 *  older server in another city) stays as it is written. */
export function sentenceStart(s: string): string {
  if (!s || /^(?:cast-agent|omp)\b/.test(s)) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

export function initial(name: string): string {
  const ch = [...name.trim()][0] ?? '?';
  return ch.toUpperCase();
}

/** "Main Ave · lot A-N1": the street, then which plot on it (the id alone means nothing to people). */
export function lotLabel(lot: Lot): string {
  return `${lot.district} · lot ${lot.id}`;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'project'
  );
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function splitPath(p: string): { dir: string; file: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', file: p } : { dir: p.slice(0, i + 1), file: p.slice(i + 1) };
}
