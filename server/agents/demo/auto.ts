// The lead decides how to work (work style 'ask' / 'auto' — `[rlt-work-style:…]` in its persona): staged asks like
// "fix the failing tests and get it reviewed", "แก้…แล้วรีวิว", "write chapter 5" or "เขียนบทที่ 5" go to a team
// without the user naming one — workflow_list first, then team_start with the job's team (only when its models are
// connected, or nothing is), else a one-off team on the connected models; always with a one-line why. The reply
// reads team_start's result: started (and what the user changed on the plan card), cancelled, or why it couldn't
// start. Everything else (a typo fix, a question) the lead still does alone.
// Two independent parts and a merge — "research X and Y in parallel then summarize", "ค้นคว้า X กับ Y พร้อมกันแล้วสรุป" —
// get a one-off team whose two researchers work at the same time (parallel: true) before a summarizer.
import { viewProject, type ProjectKind } from './describe';
import { gist, runScript, type Ctx, type Step, type TurnPlan } from './script';
import { startedReply, thaiChat } from './team';

export type AutoIntent = 'auto-team';

const WORK_STYLE = /\[rlt-work-style:(ask|auto|solo)\]/;
// "fix … and (get it) review(ed)", "add X, then have it reviewed"
const EN_FIX_REVIEW =
  /\b(?:fix|repair|solve|implement|add|build)\b[\s\S]*?(?:\band\b|\bthen\b|,)\s*(?:then\s+)?(?:(?:get|have)\s+(?:it|them|this|that|the (?:fix|fixes|change|changes|work))\s+)?review(?:ed)?\b/i;
const EN_CHAPTER = /\bwrite\s+(?:the\s+)?(?:next\s+chapter|chapter\s+\d+)\b/i;
// "แก้เทสต์ที่พังแล้วรีวิวด้วย", "แก้บั๊กแล้วให้ตรวจ"
const TH_FIX_REVIEW = /แก้[\s\S]*?แล้ว[\s\S]*?(?:รีวิว|ตรวจ)/;
const TH_CHAPTER = /เขียน\s*บท(?:ที่)?\s*\d+/;
// "research X and Y in parallel, then summarize" — the two parts are captured
const EN_PARALLEL =
  /\b(?:research|look into|investigate|study|explore|compare|check out|find out about)\s+(.+?)\s+and\s+(.+?)\s*,?\s+(?:in parallel|at the same time|side by side|simultaneously)\b[\s\S]*?\b(?:summari[sz]e|sum (?:it |them |that )?up|combine|merge|(?:write|give me) (?:a |the )?summary)/i;
// "ค้นคว้าเรื่อง X กับ Y พร้อมกันแล้วสรุป"
const TH_PARALLEL = /(?:ค้นคว้า|หาข้อมูล|ศึกษา|เทียบ|สำรวจ)\s*(?:เรื่อง)?\s*(.+?)\s*(?:กับ|และ)\s*(?:เรื่อง)?\s*(.+?)\s*(?:ไป)?(?:พร้อม\s*ๆ?\s*กัน|คู่ขนาน)[\s\S]*?สรุป/;

/** The two parts of a "do X and Y at the same time, then merge" ask, or null. */
export function parallelParts(text: string): [string, string] | null {
  const m = text.trim().match(EN_PARALLEL) ?? text.trim().match(TH_PARALLEL);
  if (!m) return null;
  const part = (s: string) => s.trim().replace(/^(?:the|เรื่อง)\s*/i, '').replace(/[\s,.;:]+$/, '');
  const a = part(m[1]!);
  const b = part(m[2]!);
  return a && b ? [a, b] : null;
}

/** The job's work style from the lead's persona (null: not a lead, or a persona from before work styles). */
export function workStyleOf(system: string): 'ask' | 'auto' | 'solo' | null {
  return (system.match(WORK_STYLE)?.[1] as 'ask' | 'auto' | 'solo' | undefined) ?? null;
}

/** Staged work the lead hands to a team on its own when the work style lets it decide. */
export function isAutoAsk(text: string): boolean {
  const t = text.trim();
  return EN_FIX_REVIEW.test(t) || EN_CHAPTER.test(t) || TH_FIX_REVIEW.test(t) || TH_CHAPTER.test(t) || parallelParts(t) !== null;
}

// ───────────────────────── reading workflow_list ─────────────────────────

export interface ListedWorkflow {
  id: string;
  name: string;
  builtin: boolean; // ", built-in" after the id (only an older CAST's list says it)
  connected: boolean; // none of its steps is marked "(not connected)"
}

export interface WorkflowList {
  teamId: string | null; // this job's team
  workflows: ListedWorkflow[]; // this house's (not the library's)
  models: string[] | null; // "Models you can use" — null when nothing is connected (any model runs on the scripted model)
  /** "The user's model choices": the model the user picked on a plan card for a person (by name). */
  prefs: { name: string; model: string }[];
}

export function parseWorkflowList(text: string): WorkflowList {
  const teamId = text.match(/^This job's team: “[^”]*” \(id ([a-z0-9][a-z0-9-]*)\)/m)?.[1] ?? null;
  const workflows: ListedWorkflow[] = [];
  let cur: ListedWorkflow | null = null;
  for (const line of text.split('\n')) {
    if (/^The library\b/.test(line)) break; // the shared library: not this house's (it runs only once imported)
    const head = line.match(/^- .*?“([^”]+)” \(id ([a-z0-9][a-z0-9-]*)(, built-in)?\)/);
    if (head) {
      cur = { id: head[2]!, name: head[1]!, builtin: !!head[3], connected: true };
      workflows.push(cur);
    } else if (cur && /^\s/.test(line)) {
      if (/\(not connected\)/.test(line)) cur.connected = false;
    } else {
      cur = null;
    }
  }
  const usable = text.match(/^Models you can use: (.+?)\.?$/m)?.[1];
  const models = usable ? usable.split(/,\s*(?=[\w.-]+\/)/).map((m) => m.trim().split(/\s+/)[0]!).filter(Boolean) : null;
  // "The user's model choices (…): Reviewer (Judge the …) → anthropic/claude-sonnet-5-5, Writer (…) → …."
  const chosen = text.match(/^The user's model choices[^:]*: (.+)$/m)?.[1] ?? '';
  const prefs = [...chosen.matchAll(/(?:^|, )(.+?) \(.*?\) → ([\w.-]+\/[\w./:@-]+?)(?=, |\.?$)/g)].map((m) => ({ name: m[1]!.trim(), model: m[2]! }));
  return { teamId, workflows, models: /^No AI account is connected/m.test(text) ? null : (models ?? []), prefs };
}

// ───────────────────────── choosing the team ─────────────────────────

const provider = (model: string) => model.split('/')[0] ?? model;

/** A one-off team on connected models: a worker, then a reviewer from another vendor when there is one. */
function oneOffSteps(kind: ProjectKind, models: string[]): Record<string, unknown>[] {
  const worker = models.find((m) => provider(m) === 'anthropic') ?? models[0] ?? 'anthropic/claude-opus-5-5';
  const reviewer = models.find((m) => provider(m) !== provider(worker)) ?? worker;
  if (kind === 'novel' || kind === 'docs') {
    return [
      { name: 'Writer', model: worker, persona: 'You write the chapter the task asks for, in the voice, language and continuity of what is already written. Put the text in the chapter file.' },
      { name: 'Editor', model: reviewer, kind: 'review', loopBackTo: 'Writer', persona: 'You edit the new chapter: continuity, voice and pacing. Send it back with concrete notes when it needs another pass.' },
    ];
  }
  return [
    { name: 'Fixer', model: worker, persona: 'You make the change the task asks for: read the code and the failing tests first, make small focused edits that match the style, and run the tests.' },
    { name: 'Reviewer', model: reviewer, kind: 'review', loopBackTo: 'Fixer', persona: 'You review the change: read the diff and the tests, run them, and send it back with concrete notes when something is wrong.' },
  ];
}

/** Two researchers at the same time (the second has parallel: true), then a summarizer — on connected models, each
 *  researcher from another vendor when there are several (any model when nothing is connected: all run on the
 *  scripted model). */
function parallelSteps(parts: [string, string], models: string[] | null, thai: boolean): Record<string, unknown>[] {
  const all = models?.length ? models : ['anthropic/claude-opus-5-5', 'google/gemini-4-argon', 'openai/gpt-6.1-terra'];
  const lead = all.find((m) => provider(m) === 'anthropic') ?? all[0]!;
  const others = all.filter((m) => provider(m) !== provider(lead));
  const r1 = others[0] ?? lead;
  const r2 = others.find((m) => provider(m) !== provider(r1)) ?? others[1] ?? r1;
  const [a, b] = parts;
  const researcher = (mine: string, theirs: string) =>
    thai
      ? `คุณค้นคว้าเรื่อง “${mine}” เท่านั้น (อีกคนทำเรื่อง “${theirs}” ไปพร้อมกัน) — อ่านไฟล์ในโปรเจกต์ (และเว็บถ้ามี) แล้วรายงานสิ่งที่พบพร้อมที่มา`
      : `You research “${mine}” only — someone else covers “${theirs}” at the same time. Read the project's files (and the web when you have it) and report what you found, with file paths or links.`;
  const summarizer = thai
    ? 'คุณรวมผลของนักค้นคว้าทั้งสองเป็นสรุปสั้น ๆ สำหรับผู้ใช้: แต่ละคนพบอะไร ตรงกันหรือต่างกันตรงไหน และควรทำอะไรต่อ'
    : "You merge the researchers' findings into one short summary for the user: what each found, where they agree or differ, and what to do next.";
  return [
    { name: thai ? 'นักค้นคว้า 1' : 'Researcher 1', model: r1, thinking: 'medium', persona: researcher(a, b) },
    { name: thai ? 'นักค้นคว้า 2' : 'Researcher 2', model: r2, thinking: 'medium', parallel: true, persona: researcher(b, a) },
    { name: thai ? 'ผู้สรุป' : 'Summarizer', model: lead, thinking: 'high', persona: summarizer },
  ];
}

interface Choice {
  args: Record<string, unknown>;
  label: string; // what the reply calls the team
}

/** The user's earlier model picks (workflow_list) for one-off people of the same name, when that model can be used.
 *  (A saved team gets them from RLT itself.) */
function withPrefs(steps: Record<string, unknown>[], list: WorkflowList): Record<string, unknown>[] {
  return steps.map((s) => {
    const pref = list.prefs.find((p) => p.name === s.name);
    return pref && (list.models === null || list.models.includes(pref.model)) ? { ...s, model: pref.model } : s;
  });
}

export function chooseTeam(list: WorkflowList, kind: ProjectKind, task: string, thai: boolean, parts: [string, string] | null = null): Choice {
  const anyModel = list.models === null;
  if (parts) {
    // Independent parts: no saved team fits better than two people at the same time and one who merges.
    const steps = withPrefs(parallelSteps(parts, list.models, thai), list);
    const chain = `${steps.slice(0, 2).map((s) => `${String(s.name)} (${String(s.model)})`).join(' + ')} → ${String(steps[2]!.name)} (${String(steps[2]!.model)})`;
    const why = thai
      ? `สองเรื่องนี้แยกกันได้ — ให้นักค้นคว้าสองคนทำพร้อมกัน แล้วให้ผู้สรุปรวมผลให้`
      : 'Two independent parts — two researchers work on them at the same time, then a summarizer merges what they found.';
    return { args: { task, steps, name: thai ? 'ค้นคว้าพร้อมกัน → สรุป' : 'Research in parallel → Summary', why }, label: chain };
  }
  const usable = (w: ListedWorkflow | undefined): w is ListedWorkflow => !!w && (anyModel || w.connected);
  const team = list.workflows.find((w) => w.id === list.teamId);
  const why = (name: string) =>
    thai
      ? kind === 'novel'
        ? `บทใหม่ต้องมีทั้งรอบเขียนและรอบเกลา — ${name} ทำได้ครบ`
        : `งานนี้ต้องแก้แล้วมีคนตรวจ — ${name} ทำแล้วมีผู้ตรวจอีกคนเช็ก`
      : kind === 'novel'
        ? `A chapter needs a writing pass and an edit pass — ${name} does both.`
        : `Staged work that must be right — ${name} makes the change and a reviewer checks it.`;
  if (usable(team)) return { args: { task, why: why(`“${team.name}”`) }, label: team.name };
  const steps = withPrefs(oneOffSteps(kind, list.models ?? []), list);
  const chain = steps.map((s) => `${String(s.name)} (${String(s.model)})`).join(' → ');
  return { args: { task, steps, name: kind === 'novel' ? 'Write → Edit' : 'Fix → Review', why: why(chain) }, label: chain };
}

/** The brief the team gets: the ask plus what the lead knows about the project (the team doesn't see the chat). */
function brief(ctx: Ctx, kind: ProjectKind, name: string, parts: [string, string] | null = null): string {
  const how = parts
    ? `Two parts, done at the same time: “${parts[0]}” and “${parts[1]}”; then one short summary of both.`
    : kind === 'code'
      ? 'Run the tests first, fix what fails with small focused changes that match the existing style, and run them again.'
      : kind === 'novel'
        ? 'Keep continuity with outline.md, characters.md and the chapters already written; follow style-guide.md.'
        : 'Keep changes focused on the ask.';
  return `${gist(ctx.conv.userText, 600)}\n\nProject “${name}” (the team works in its folder). ${how}`;
}

function autoSteps(thai: boolean): Step[] {
  return [
    {
      name: 'auto-look',
      plan: (ctx) => ({
        thinking: parallelParts(ctx.conv.userText)
          ? `"${gist(ctx.conv.userText)}" — two independent parts and a merge: two people can do them at the same time. Let me see which models are connected.`
          : `"${gist(ctx.conv.userText)}" — staged work that must be right: make it, then have it checked. Let me see which teams fit and which models are connected.`,
        calls: [{ name: 'workflow_list', args: { i: 'look at the teams' } }],
      }),
    },
    {
      name: 'auto-start',
      plan(ctx) {
        const v = viewProject(ctx.cwd);
        const parts = parallelParts(ctx.conv.userText);
        const choice = chooseTeam(parseWorkflowList(ctx.result('auto-look')), v.kind, brief(ctx, v.kind, v.name, parts), thai, parts);
        return {
          thinking: `${choice.label} fits. I'll hand it over with team_start — a complete brief, since the team doesn't see this chat — and stay free to talk.`,
          text: thai ? `ให้ทีมทำดีกว่าค่ะ — ${String(choice.args.why)}\n\n` : `I'll hand this to a team — ${String(choice.args.why)}\n\n`,
          calls: [{ name: 'team_start', args: { i: 'start a team', ...choice.args } }],
        };
      },
    },
    { name: 'auto-done', plan: (ctx) => ({ text: startedReply(ctx.result('auto-start'), thai) }) },
  ];
}

export function autoTurn(ctx: Ctx): TurnPlan {
  const thai = thaiChat(ctx.conv);
  return runScript(ctx, autoSteps(thai), thai ? 'เรียบร้อยค่ะ' : 'Done.');
}
