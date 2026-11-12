// What the Hermes bridge says about the town, and how it reads what Hermes (or the user, through Hermes) names: houses
// and jobs by name, waiting requests by a short code, answers by their words. Pure functions over a TownView, so the
// MCP server (mcp.ts), the notifier (notify.ts) and the tests share them.
import { createHash } from 'node:crypto';
import type { AgentInfo, ApprovalRequest, AskAnswer, CityState, Job, Project, TeamPlan, TranscriptItem, WorkflowRun } from '../shared/protocol';
import { houseNext } from '../server/app-routes';

/** The part of CastLink the views read. */
export interface TownView {
  url: string;
  city: CityState;
  jobs: Job[];
  agents: ReadonlyMap<string, AgentInfo>;
  approvals: ReadonlyMap<string, ApprovalRequest>;
  plans: ReadonlyMap<string, TeamPlan>;
  runs: ReadonlyMap<string, WorkflowRun>;
}

export type Lang = 'en' | 'th';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ───────────────────────── waiting requests ─────────────────────────

/** Short codes a person can type on a phone: no 0/o, 1/l/i. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A request's code: 'a' (approval or question) or 'p' (plan card) and four characters from the id's hash. The same
 *  id always gives the same code, in every bridge process. */
export function shortCode(prefix: 'a' | 'p', id: string): string {
  const h = createHash('sha256').update(id).digest();
  let s = prefix;
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[h[i]! % CODE_ALPHABET.length];
  return s;
}

/** Something waiting for the user, whatever card it is. */
export interface Pending {
  kind: 'approval' | 'question' | 'plan';
  id: string;
  code: string;
  projectId: string;
  jobId: string;
  agentId: string;
  house: string;
  job: string;
  person: string;
  ts: number;
  approval?: ApprovalRequest;
  plan?: TeamPlan;
}

/** An approval card that is a question to the user (an agent's ask, an extension's choice or confirm) rather than
 *  permission for a tool. */
export function isQuestion(a: ApprovalRequest): boolean {
  return a.tool === 'ask' || a.tool === 'choice' || a.tool === 'confirm';
}

/** Every request waiting for the user, oldest first. */
export function pendingItems(v: TownView): Pending[] {
  const place = (projectId: string, agentId: string, jobId?: string) => {
    const agent = v.agents.get(agentId);
    const j = jobId ?? agent?.jobId ?? '';
    return {
      projectId,
      jobId: j,
      agentId,
      house: v.city.projects.find((p) => p.id === projectId)?.name ?? projectId,
      job: v.jobs.find((x) => x.projectId === projectId && x.id === j)?.name ?? j,
      person: agent?.name ?? 'Someone',
    };
  };
  const items: Pending[] = [];
  for (const a of v.approvals.values()) {
    items.push({ kind: isQuestion(a) ? 'question' : 'approval', id: a.id, code: shortCode('a', a.id), ts: a.ts, approval: a, ...place(a.projectId, a.agentId) });
  }
  for (const p of v.plans.values()) {
    if (p.status !== 'pending') continue;
    items.push({ kind: 'plan', id: p.id, code: shortCode('p', p.id), ts: p.ts, plan: p, ...place(p.projectId, p.agentId, p.jobId) });
  }
  return items.sort((a, b) => a.ts - b.ts);
}

/** The waiting request a code or id names, or why none. */
export function findPending(items: Pending[], ref: string): Pending | { error: string } {
  const r = ref.trim().toLowerCase();
  if (!r) return { error: 'Say which request: its code (e.g. a7k2q) or id. The pending tool lists them.' };
  const hits = items.filter((i) => i.code === r || i.id.toLowerCase() === r);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return { error: `Code ${ref} matches ${hits.length} requests; use the full id from the pending tool.` };
  const known = items.map((i) => i.code).join(', ');
  return { error: `Nothing waits under “${ref}” (it may have been answered already, in CAST or elsewhere). ${items.length ? `Waiting now: ${known}.` : 'Nothing waits for an answer now.'}` };
}

// ───────────────────────── houses, jobs, leads ─────────────────────────

function pickNamed<T extends { id: string; name: string }>(list: T[], ref: string): T[] {
  const r = ref.trim().toLowerCase();
  const exact = list.filter((x) => x.id.toLowerCase() === r || x.name.toLowerCase() === r);
  if (exact.length) return exact;
  return list.filter((x) => x.name.toLowerCase().includes(r));
}

const names = (list: { name: string }[]) => list.map((x) => `“${x.name}”`).join(', ');

/** A house by id or name (a unique part of the name is enough); absent → the only house. */
export function resolveHouse(v: TownView, ref?: string): Project | { error: string } {
  const all = v.city.projects;
  if (!all.length) return { error: 'CAST has no houses yet.' };
  if (!ref?.trim()) return all.length === 1 ? all[0]! : { error: `Which house? CAST has ${all.length}: ${names(all)}.` };
  const hits = pickNamed(all, ref);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return { error: `“${ref}” fits ${hits.length} houses: ${names(hits)}. Say which.` };
  return { error: `No house is called “${ref}”. Houses: ${names(all)}.` };
}

/** A job of the house by id or name; absent → the house's only job. */
export function resolveJob(v: TownView, house: Project, ref?: string): Job | { error: string } {
  const all = v.jobs.filter((j) => j.projectId === house.id);
  if (!all.length) return { error: `House “${house.name}” has no jobs.` };
  if (!ref?.trim()) return all.length === 1 ? all[0]! : { error: `Which job in “${house.name}”? It has ${all.length}: ${names(all)}.` };
  const hits = pickNamed(all, ref);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) return { error: `“${ref}” fits ${hits.length} jobs in “${house.name}”: ${names(hits)}. Say which.` };
  return { error: `House “${house.name}” has no job called “${ref}”. Jobs: ${names(all)}.` };
}

/** The job's lead: the person the user talks to in that room. */
export function leadOf(v: TownView, projectId: string, jobId: string): AgentInfo | undefined {
  for (const a of v.agents.values()) if (a.kind === 'resident' && a.projectId === projectId && a.jobId === jobId) return a;
  return undefined;
}

// ───────────────────────── answers ─────────────────────────

const YES = ['approve', 'approved', 'allow', 'yes', 'y', 'ok', 'okay', 'accept', 'อนุมัติ', 'ตกลง', 'ใช่', 'ได้', 'โอเค'];
const NO = ['deny', 'denied', 'reject', 'no', 'n', 'decline', 'ไม่', 'ไม่อนุมัติ', 'ปฏิเสธ', 'ไม่ได้'];
const RUN = [...YES, 'run', 'start', 'go', 'เริ่ม', 'รัน'];
const CANCEL = [...NO, 'cancel', 'stop', 'ยกเลิก', 'หยุด'];

/** One of the card's options from what the user said: the option itself (any case), its number (1-based), a yes/no
 *  word (the plainest option of that kind: "Approve", not "Approve bash for this session"), or a unique start of one.
 *  null when nothing fits — never a guess, since CAST denies an answer it doesn't know. */
export function pickOption(options: string[], choice: string): string | null {
  const c = choice.trim().toLowerCase();
  if (!c) return null;
  const exact = options.find((o) => o.toLowerCase() === c);
  if (exact) return exact;
  if (/^\d+$/.test(c)) return options[Number(c) - 1] ?? null;
  const kind = YES.includes(c) ? ['approve', 'allow', 'yes', 'ok'] : NO.includes(c) ? ['deny', 'reject', 'no', 'cancel'] : null;
  if (kind) {
    const fits = options.filter((o) => kind.some((k) => o.toLowerCase().startsWith(k)));
    if (fits.length) return fits.reduce((a, b) => (b.length < a.length ? b : a));
    return null;
  }
  const starts = options.filter((o) => o.toLowerCase().startsWith(c));
  return starts.length === 1 ? starts[0]! : null;
}

/** An answer to one question of an agent's ask. */
export interface QuestionAnswer {
  question?: string; // the question's id or its number (1-based); absent → the only question
  choose?: string[]; // option labels or numbers
  text?: string; // the user's own words
}

export type Resolved =
  | { kind: 'approve'; value: string; answers?: AskAnswer[]; said: string }
  | { kind: 'plan'; run: boolean; said: string }
  | { error: string };

/** What to send CAST for this request, from the user's words. */
export function resolveAnswer(item: Pending, choice: string, answers?: QuestionAnswer[]): Resolved {
  if (item.kind === 'plan') {
    const c = choice.trim().toLowerCase();
    if (RUN.includes(c)) return { kind: 'plan', run: true, said: 'Run' };
    if (CANCEL.includes(c)) return { kind: 'plan', run: false, said: 'Cancel' };
    return { error: `A plan card takes “run” or “cancel”, not “${choice}”.` };
  }
  const a = item.approval!;
  const qs = a.tool === 'ask' ? a.questions : undefined;
  if (!qs?.length) {
    const value = pickOption(a.options, choice);
    if (!value) return { error: `“${choice}” is not one of this request's answers: ${a.options.map((o, i) => `${i + 1}) ${o}`).join(', ')}.` };
    return { kind: 'approve', value, said: value };
  }
  const given: QuestionAnswer[] = answers?.length ? answers : choice.trim() ? [{ text: choice }] : [];
  const out: AskAnswer[] = [];
  for (const [i, q] of qs.entries()) {
    const g = qs.length === 1 && given.length === 1 && !given[0]!.question ? given[0] : given.find((x) => x.question === q.id || x.question === String(i + 1));
    if (!g) return { error: `Question ${i + 1} (“${clip(q.question, 80)}”) has no answer yet. Answer every question: ${qs.length}.` };
    const labels = q.options.map((o) => o.label);
    const picked: string[] = [];
    for (const c of g.choose ?? []) {
      const label = pickOption(labels, c);
      if (!label) return { error: `“${c}” is not an option of question ${i + 1}: ${labels.map((l, n) => `${n + 1}) ${l}`).join(', ')}.` };
      picked.push(label);
    }
    // a lone text that names an option is that option
    if (!picked.length && g.text && !g.choose?.length) {
      const label = pickOption(labels, g.text);
      if (label) {
        out.push({ id: q.id, selectedOptions: [label] });
        continue;
      }
    }
    out.push({ id: q.id, selectedOptions: picked, ...(g.text?.trim() ? { customInput: g.text.trim() } : {}) });
  }
  const first = out[0]!;
  const said = out.map((x) => [...x.selectedOptions, ...(x.customInput ? [x.customInput] : [])].join(', ')).join(' / ');
  return { kind: 'approve', value: (first.selectedOptions[0] ?? first.customInput ?? '').slice(0, 500), answers: out, said };
}

// ───────────────────────── text ─────────────────────────

function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function personState(a: AgentInfo, waiting: boolean): string {
  if (waiting || a.activity === 'waiting_approval') return 'waiting for your answer';
  switch (a.status) {
    case 'busy':
      return a.available ? 'its helpers are working (it can take a message)' : `working${a.detail ? `: ${a.detail}` : ''}`;
    case 'starting':
      return 'starting';
    case 'error':
      return `stopped with an error${a.detail ? `: ${a.detail}` : ''}`;
    case 'offline':
      return 'not started (starts with the next message)';
    default:
      return 'idle';
  }
}

function runLine(r: WorkflowRun, now = Date.now()): string {
  const team = r.team ?? [];
  const current = (r.currentStepIds ?? (r.currentStepId ? [r.currentStepId] : [])).map((id) => team.find((m) => m.id === id)?.name ?? id);
  const done = r.steps.filter((s) => s.status === 'done').length;
  const name = `team run “${r.workflowName}”`;
  if (r.status === 'running' || r.status === 'waiting_approval') {
    const waits = r.status === 'waiting_approval' ? ', waiting for your answer' : '';
    return `${name}: running${waits} — now ${current.join(' + ') || '…'} (${done} step${done === 1 ? '' : 's'} done of ${team.length || '?'}), started ${ago(r.startedAt, now)}`;
  }
  return `${name}: ${r.status}${r.endedAt ? ` ${ago(r.endedAt, now)}` : ''}`;
}

const RECENT_RUN_MS = 12 * 3600_000;

/** Every house (or one), its jobs and their leads, team runs going or recently ended, and what waits for the user. */
export function renderStatus(v: TownView, only?: Project, now = Date.now()): string {
  const pending = pendingItems(v);
  const houses = only ? [only] : v.city.projects;
  const lines: string[] = [`CAST at ${v.url} — ${v.city.projects.length} house${v.city.projects.length === 1 ? '' : 's'}`];
  for (const h of houses) {
    lines.push('', `House “${h.name}” (${h.path}) — approval mode: ${h.approvalMode}`);
    for (const j of v.jobs.filter((x) => x.projectId === h.id)) {
      const lead = leadOf(v, h.id, j.id);
      const waits = pending.filter((p) => p.projectId === h.id && p.jobId === j.id);
      const state = lead ? `${lead.name} (${lead.modelLabel}) — ${personState(lead, waits.some((p) => p.agentId === lead.id))}` : 'nobody there yet (starts with the next message)';
      lines.push(`  • Job “${j.name}”: ${state}`);
      if (lead?.queue?.length) lines.push(`      ${lead.queue.length} message${lead.queue.length === 1 ? '' : 's'} queued for it`);
      if (lead?.goal) lines.push(`      goal (${lead.goal.status}): ${clip(lead.goal.objective, 160)}`);
      const team = [...v.agents.values()].filter((a) => a.projectId === h.id && a.jobId === j.id && a.kind !== 'resident' && (a.status === 'busy' || a.status === 'starting'));
      if (team.length) lines.push(`      working with it: ${team.map((a) => `${a.name}${a.detail ? ` (${clip(a.detail, 60)})` : ''}`).join(', ')}`);
      const runs = [...v.runs.values()]
        .filter((r) => r.projectId === h.id && r.jobId === j.id && (r.status === 'running' || r.status === 'waiting_approval' || (r.endedAt ?? 0) > now - RECENT_RUN_MS))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 3);
      for (const r of runs) lines.push(`      ${runLine(r, now)}`);
      if (waits.length) lines.push(`      waiting for you: ${waits.map((p) => p.code).join(', ')}`);
    }
  }
  const mine = only ? pending.filter((p) => p.projectId === only.id) : pending;
  lines.push('', mine.length ? `Waiting for the user: ${mine.length} — the pending tool shows them in full.` : 'Nothing waits for the user.');
  for (const p of mine) lines.push(`  ${p.code} ${p.kind} · ${p.house} / ${p.job} · ${p.person}: ${clip(headline(p), 120)}`);
  return lines.join('\n');
}

function headline(p: Pending): string {
  if (p.plan) return `start the team “${p.plan.title}”`;
  return p.approval!.title;
}

const DIFF_LINES = 30;

/** Everything about one waiting request, as the user needs it to decide (the answers last). */
export function renderPendingDetail(p: Pending, lang: Lang = 'en'): string {
  const th = lang === 'th';
  const lines: string[] = [];
  if (p.plan) {
    const pl = p.plan;
    lines.push(th ? `ทีม “${pl.title}”${pl.why ? ` — ${pl.why}` : ''}` : `Team “${pl.title}”${pl.why ? ` — ${pl.why}` : ''}`);
    pl.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.name} (${s.model}${s.kind === 'review' ? ', review' : ''}${s.parallel ? ', parallel' : ''}) — ${clip(s.duty, 140)}`));
    if (pl.continues) lines.push(th ? `ทำต่อจากรอบก่อน: ใช้ผลเดิมของ ${pl.continues.kept.map((k) => k.name).join(', ') || '-'}` : `Continues an earlier run: keeps the results of ${pl.continues.kept.map((k) => k.name).join(', ') || 'no step'}`);
    lines.push(`${th ? 'งาน' : 'Task'}: ${clip(pl.task, 700)}`);
    lines.push(th ? 'ตอบได้: run หรือ cancel' : 'Answers: run, cancel');
    return lines.join('\n');
  }
  const a = p.approval!;
  lines.push(a.title);
  if (a.detail) lines.push(clip(a.detail, 1500));
  if (a.from) lines.push(`${th ? 'มาจากโค้ดใน' : 'From code in'} ${a.from.tool}${a.from.intent ? ` (${a.from.intent})` : ''}:\n${clip(a.from.code, 600)}`);
  if (a.change) {
    const c = a.change;
    lines.push(`${th ? 'จะแก้' : 'Changes'} ${c.files.length} ${th ? 'ไฟล์' : `file${c.files.length === 1 ? '' : 's'}`} (+${c.added} −${c.removed}): ${clip(c.files.join(', '), 300)}`);
    const diff = c.diff.split('\n');
    // a chat bubble holds ~5000 characters: one minified line must not eat it
    lines.push(diff.slice(0, DIFF_LINES).map((l) => clip(l, 200)).join('\n') + (diff.length > DIFF_LINES || c.truncated ? `\n… (${th ? 'ดูทั้งหมดใน CAST' : 'more in CAST'})` : ''));
  }
  if (a.autoReason) lines.push(`${th ? 'โหมด Auto ถามเพราะ' : 'Auto mode asks because'}: ${a.autoReason}`);
  if (a.tool === 'ask' && a.questions?.length) {
    a.questions.forEach((q, i) => {
      lines.push(`${a.questions!.length > 1 ? `Q${i + 1}. ` : ''}${q.header ? `[${q.header}] ` : ''}${q.question}${q.multi ? (th ? ' (เลือกได้หลายข้อ)' : ' (pick any number)') : ''}`);
      q.options.forEach((o, n) => lines.push(`   ${n + 1}) ${o.label}${o.description ? ` — ${clip(o.description, 120)}` : ''}${q.recommended === n ? (th ? ' (แนะนำ)' : ' (recommended)') : ''}`));
    });
    lines.push(th ? 'ตอบเป็นตัวเลือก หรือพิมพ์คำตอบเองก็ได้' : 'Answer with an option, or in your own words.');
  } else {
    lines.push(`${th ? 'ตอบได้' : 'Answers'}: ${a.options.map((o, i) => `${i + 1}) ${o}${a.optionNotes?.[i] ? ` — ${a.optionNotes[i]}` : ''}`).join('  ')}`);
  }
  return lines.join('\n');
}

/** The pending tool's answer. */
export function renderPending(items: Pending[]): string {
  if (!items.length) return 'Nothing waits for the user.';
  return items
    .map((p) => `[${p.code}] ${p.kind} — ${p.house} / ${p.job} · ${p.person}, ${ago(p.ts)} (id ${p.id})\n${renderPendingDetail(p)}`)
    .join('\n\n');
}

/** The message the user gets on their phone about one request (sent through Hermes as is). openUrl: the CAST address
 *  the phone opens (null: no link — a loopback address would only work on the CAST machine). */
export function notificationText(p: Pending, lang: Lang, openUrl: string | null): string {
  const th = lang === 'th';
  const where = `${p.person} · ${p.house} / ${p.job}`;
  const head =
    p.kind === 'plan'
      ? th ? `👥 CAST: ${where} ขอเริ่มทีม` : `👥 CAST: ${where} wants to start a team`
      : p.kind === 'question'
        ? th ? `❓ CAST: ${where} ถามคุณ` : `❓ CAST: ${where} asks you`
        : th ? `🔔 CAST: ${where} ขออนุมัติ` : `🔔 CAST: ${where} asks for approval`;
  const reply =
    p.kind === 'plan'
      ? th ? `ตอบในแชทนี้: "run ${p.code}" หรือ "cancel ${p.code}"` : `Reply here: "run ${p.code}" or "cancel ${p.code}"`
      : p.kind === 'question'
        ? th ? `ตอบในแชทนี้: "answer ${p.code} <คำตอบ>"` : `Reply here: "answer ${p.code} <your answer>"`
        : th ? `ตอบในแชทนี้: "approve ${p.code}" หรือ "deny ${p.code}"` : `Reply here: "approve ${p.code}" or "deny ${p.code}"`;
  const open = openUrl ? [`${th ? 'เปิดใน CAST' : 'Open in CAST'}: ${openUrl.replace(/\/+$/, '')}${houseNext(p.projectId, p.jobId)}`] : [];
  return [`${head} [${p.code}]`, renderPendingDetail(p, lang), '', reply, ...open].join('\n');
}

/** What the user confirms in Hermes before the bridge answers CAST for them. */
export function confirmText(p: Pending, said: string): string {
  return [`Answer “${said}” in CAST to ${p.person} (${p.house} / ${p.job}) [${p.code}]?`, '', renderPendingDetail(p)].join('\n');
}

const ASSISTANT_CHARS = 2000;

/** The latest items of a chat, oldest first, as lines Hermes can read. */
export function renderTranscript(items: TranscriptItem[], limit: number, leadName: string): string {
  const shown = items.filter((i) => !(i.kind === 'assistant' && !i.text.trim()) && i.kind !== 'advisor').slice(-limit);
  if (!shown.length) return '(the chat is empty)';
  return shown
    .map((i) => {
      switch (i.kind) {
        case 'user':
          return `User${i.notSent ? ' (not sent)' : ''}: ${clip(i.text, 1200)}`;
        case 'assistant':
          return `${leadName}${i.streaming ? ' (still writing)' : ''}: ${clip(i.text, ASSISTANT_CHARS)}`;
        case 'tool':
          return `  · ${i.title} [${i.status}]`;
        case 'system':
          return `  ! ${clip(i.text, 400)}`;
        case 'plan':
          return `  plan card “${i.plan.title}”: ${i.plan.status}`;
        case 'helper':
          return `  · helper ${i.name}: ${i.status} — ${clip(i.task, 140)}`;
        case 'changes':
          return `  · changed ${i.count} file${i.count === 1 ? '' : 's'}: ${clip(i.files.join(', '), 200)}${i.undoneAt ? ' (undone)' : ''}`;
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

/** A person's state in one line (the tell and read tools). */
export function personLine(v: TownView, a: AgentInfo): string {
  const waiting = pendingItems(v).some((p) => p.agentId === a.id);
  return `${a.name} (${a.modelLabel}) is ${personState(a, waiting)}.`;
}
