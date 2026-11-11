// The lead designs a team from chat: "Create a workflow: Planner → Builder → Checker" or "สร้าง workflow: นักวิจัย →
// นักเขียน → บรรณาธิการ แล้วใช้กับงานนี้เลย" → one workflow_save call (RLT host tool, see lead-tools.ts; with
// use_for_this_job when they want it for this job), then a few lines from its result. A design ask without steps gets
// "which steps?", and the steps in the next message complete it. Asks to change an existing workflow get a text-only
// "edit it in the Workflow tab" (the demo model can't). Only the lead has workflow_save; without it these asks stay
// what they were ('change'). GitHub Actions / CI "workflows" are never team designs.
import type { Conversation } from './conversation';
import { hasThai } from './project-scan';
import { gist, runScript, type Ctx, type Step, type TurnPlan } from './script';
import { thaiChat } from './team';
import { DEFAULT_CATALOG } from '../models';
import { describeTeam } from '../../../shared/team-text';

export type WorkflowIntent = 'workflow-design' | 'workflow-change';

export const isWorkflowIntent = (intent: string): intent is WorkflowIntent => intent.startsWith('workflow-');

export interface WorkflowAskStep {
  id: string;
  name: string;
  kind: 'work' | 'review';
  loopBackTo?: string;
}

export interface WorkflowAsk {
  name: string; // the workflow's name: “called X” or the chain itself
  steps: WorkflowAskStep[];
  assign: boolean; // also make it this job's team
}

const MODEL = 'anthropic/claude-opus-5-5';
/** Reviewers check another vendor's work: a different model catches different mistakes. */
const REVIEW_MODEL = 'openai/gpt-6.1-sol';

/** "Claude Opus 5.5", not "anthropic/claude-opus-5-5". */
function modelName(id: string): string {
  return DEFAULT_CATALOG.find((m) => m.id === id)?.label ?? (id.split('/').pop() ?? id).replace(/-/g, ' ');
}
const MAX_STEPS = 8;

const CI = /github|gitlab|bitbucket|\bactions?\b|\bci\b|ci\/cd|\.ya?ml\b|\byaml\b|pipeline|\bcron\b|\bon (?:push|pull[_ ]request)\b/i;

// The ask leads with the design: "create/make/design/build/set up a (new) workflow|team …", "new workflow: …".
const EN_OPENER = /^(?:(?:please|pls|ok|okay|hey|so|now|can you|could you|would you|will you|let's|lets|go ahead and|i want you to|i'd like you to|help me)[\s,]+)*/i;
const EN_DESIGN =
  /^(?:(?:create|make|design|build|set\s*up|setup|put together|draft|define|assemble)\s+(?:me\s+|us\s+)?(?:(?:a|an|the|my|our|one|this|another)\s+)?|(?:i\s+(?:want|need|would like|'d like)|give me)\s+(?:a|an)\s+|(?=new\b))(?:(?:new|custom|different|fresh)\s+)?(?:team\s+workflow|workflow|team)\b(?![-'’])/i;
// "Make my own version of the “Decode → Implement → Review” workflow …" (as a person might ask it)
const EN_OWN =
  /^(?:make|create|build|design|set\s*up)\s+(?:me\s+)?(?:my|our)\s+own\s+(?:version|copy|take|variant)\s+of\s+(?:(?:the|this|that)\s+)?(?:(?:[“"][^“”"\n]*[”"]|[^\n:：“”"]{1,60}?)\s+)?(?:team\s+workflow|workflow|team)\b(?![-'’])/i;
// "สร้าง / ออกแบบ / ตั้ง / จัด … workflow|เวิร์กโฟลว์|ทีม" (not ตั้งค่า "settings", not จัดการ "manage")
const TH_OPENER = /^(?:(?:โอเค|ok|งั้น|ถ้างั้น|ช่วย|รบกวน|ลอง|กรุณา|ขอ|อยากให้|ฝาก)\s*)*/i;
const TH_DESIGN = /^(?:สร้าง|ออกแบบ|ตั้ง(?!ค่า)|จัด(?!การ)|อยากได้)\s*(?:ให้\s*)?(?:(?:ทีม|workflow|เวิร์[กค]โฟลว์)\s*)?(?:workflow|เวิร์[กค]โฟลว์|ทีม(?:งาน)?)/i;

// What may follow the noun, so it is the team itself and not "a team page", "a workflow file", "team-based …".
const EN_TAIL =
  /^(?:\s*$|\s*[:：,.!?;(“"—–→>]|\s+(?:-|->|=>)\s|\s*\n\s*(?:[-*•]|\d{1,2}[.)])\s|\s+(?:for|of|with|called|named|and|then|where|like|please|pls|now|that|which)\b)/i;
const TH_TAIL =
  /^(?:\s*$|\s*[:：,.!?;(“"—–→>]|\s*\n\s*(?:[-*•]|\d{1,2}[.)])\s|\s*(?:ใหม่|ขึ้น|อีก|ให้|หน่อย|ที่|มี|ประกอบ|แบบ|คือ|สำหรับ|ไว้|เพื่อ|ของ|ชื่อ|นะ|ค่ะ|คะ|ครับ|จ้า|แล้ว|และ|โดย|with|for|of|called|named)|\s+[^\s:]+\s*(?:→|->|=>|>))/i;
// …and the ones that make it a plain "make me a workflow" with nothing more to it (we then ask for the steps).
const EN_BARE = /^(?:\s*[.!?]*\s*$|\s*[:：]|\s+(?:for|please|pls|now)\b|\s+(?:and|then)\s+(?:use|set|make|assign)\b)/i;
const TH_BARE = /^(?:\s*[:：.!?]|\s*$|\s*(?:ใหม่|ขึ้นมา|ขึ้น|อีก|ให้|หน่อย|สำหรับ|ไว้|ของ|นะ|ค่ะ|คะ|ครับ|จ้า|แล้ว(?:ก็)?ใช้|ใช้)|\s+for\b)/i;

// "Change the “X” workflow: …" (the Workflow tab's link), "edit my workflow", "update this job's team: …" / "แก้ workflow …",
// "เปลี่ยนทีม …". Not "update the workflow docs", "edit the team page".
const CHANGE_EN = String.raw`^(?:change|edit|update|modify|tweak|adjust|alter|rework|revise)\s+(?:(?:the|my|our|this|that|this\s+job['’]?s|the\s+job['’]?s)\s+)?`;
const CHANGE_TAIL = String.raw`(?:['’]s\b|(?=\s*$|\s*[:：,.!?;(—–]|\s+(?:to|so|and|by|with|for|that|which|now|please|steps?)\b))`;
const EN_CHANGE = new RegExp(
  `${CHANGE_EN}(?:(?:[“"][^“”"\\n]*[”"]|[^\\n:：“”"]*?(?:→|->)[^\\n:：“”"]*?)\\s+)?(?:team\\s+)?workflow${CHANGE_TAIL}` +
    `|${CHANGE_EN}(?:[“"][^“”"\\n]*[”"]\\s+team${CHANGE_TAIL}|team(?=\\s*[:：]))`,
  'i',
);
const TH_CHANGE = /^(?:แก้(?:ไข)?|เปลี่ยน|ปรับ(?:ปรุง|แก้)?)\s*(?:ขั้นตอน\s*(?:ของ|ใน)?\s*)?(?:workflow|เวิร์[กค]โฟลว์|ทีม(?:งาน)?)(?=\s*$|[\s:：“"(,.!?]|นี้|ให้|หน่อย|ของ|ใหม่|ที่|เป็น)/i;

// "use it for this job", "set it as the team", "make it this job's team" / "ใช้กับงานนี้", "ตั้งเป็นทีมของงานนี้"
const EN_ASSIGN =
  /\b(?:use|set|make|assign)\b[^.]{0,30}?\b(?:for|as|on|to)\s+(?:this|the|my|our)\s+(?:job|team|room|house)\b|\bas\s+(?:the|this job's|my|our)\s+team\b|\b(?:make|set)\s+it\s+(?:this|the)\s+job'?s\s+team\b/i;
const TH_ASSIGN = /ใช้\s*(?:มัน|อันนี้|เลย)?\s*(?:กับ|ใน|สำหรับ|เป็นทีม(?:ของ|ใน|ให้)?)\s*(?:งาน|ห้อง|บ้าน)\s*นี้|(?:ใช้|ตั้ง)(?:มัน)?(?:ให้)?เป็นทีม/;
const ASSIGN_ALL = [new RegExp(EN_ASSIGN.source, 'gi'), new RegExp(TH_ASSIGN.source, 'g')];
// …said right after "but don't" / "ยังไม่ต้อง": "…, but don't use it for this job yet", "อย่าเพิ่งใช้กับงานนี้"
const EN_NEG =
  /(?:[\s,;]*\b(?:but|and|so)\b)?[\s,;]*\b(?:please\s+)?(?:don['’]?t|do\s+not|not|never|no\s+need\s+to|won['’]?t|shouldn['’]?t)\s+(?:(?:yet|really|actually|need\s+to|have\s+to)\s+)?$/i;
const TH_NEG = /(?:[\s,]*แต่)?[\s,]*(?:ยัง)?(?:ไม่|อย่า|ห้าม)(?:ต้อง|ได้|ควร)?\s*(?:เพิ่ง)?\s*$/;

const ARROW = /\s*(?:→|->|=>|⇒|>)\s*/;
const LIST_SEP = /\s*(?:[,;、]|\bthen\b|\band\b|แล้ว(?:ก็)?|และ|ต่อด้วย)\s*/i;
const TRAILING_JOINERS = /(?:\s*(?:[,;.]|\band\b|\bthen\b|แล้ว(?:ก็)?|และ|เลย))+\s*$/i;
// "- A", "* A", "• A", "1. A", "2) A"
const BULLET = /^(?:[-*•]|\d{1,2}[.)])\s+/;
// Before the steps when there is no colon: "a team of …", "a workflow with …", "ทีมที่มี …"
const EN_LIST_LEAD = /^\s*(?:[—–-]+\s*|(?:of|with|like|where|going|that goes|to be|steps?|roles?|people|members?)\s+)+/i;
const TH_LIST_LEAD = /^\s*(?:(?:ใหม่|ที่มี|มี|ประกอบด้วย|ประกอบไปด้วย|แบบ|คือ|โดยมี|ให้มี|ให้|หน่อย|with|of)\s*)+/i;
// "a workflow called Ship It with Planner → Builder"
const CALLED_WITH = /^\s*(?:called|named|ชื่อ)\s+[^→>]*?\s(?:with|of|มี)\s+/i;
// "a workflow “Ship It”: …", "called Ship It: …", "ชื่อ ทีมข่าว: …"
const QUOTED_NAME = /^\s*(?:(?:called|named|ชื่อ)\s*)?[“"]([^“”"\n]{1,60})[”"]/i;
const CALLED_NAME = /^\s*(?:called|named|ชื่อ)\s*([^:：“”"\n]{1,60}?)\s*(?=[:：,.\n]|\s+(?:with|and|for|of)\b|$)/i;

// "a team of two helpers to review …" is the helpers (the `task` tool), not a team design.
const HELPER_WORDS = /\b(?:helpers?|sub-?agents?|parallel|delegate)\b|ผู้ช่วย/i;
// Without a colon, arrows or bullets, a list is a team only when it names roles: "a team of a planner, two coders and
// QA" — not "a team with name and members fields", "with id, name and createdAt", "with the API key and the database".
const ROLE_HEAD = /(?:er|or|ist|ian|ant)s?$|^(?:qa|dev|devops|pm|po|ux|ui|sre|lead|head|chief|admin|expert|critic|judge|coach|agent|analyst|architect|staff|crew)s?$/i;
const THING_HEAD =
  /^(?:user|member|owner|folder|header|footer|server|router|filter|parameter|number|order|container|counter|timer|handler|controller|provider|wrapper|layer|border|buffer|banner|loader|parser|logger|listener|adapter|trigger|marker|poster|chapter|character|player|other|letter|answer|paper|power|water|center|corner|cover|register|cluster|identifier|modifier|computer|browser|error|colou?r|cursor|selector|vector|factor|mirror|anchor|floor|door|monitor|constant|variant|(?:check|play|wish|white|black|allow|deny|task|todo|word|mailing)?list)s?$/i;
const ROLE_TH = /^(?:นัก|ผู้|ช่าง|หัวหน้า|คน|เจ้าหน้าที่|ที่ปรึกษา|บรรณาธิการ|บก|โปรแกรมเมอร์|ดีไซเนอร์|เทสเตอร์|ฝ่าย)/;
const NOT_ROLE = /\b(?:to|in|into|on|from|at|with|for|fields?|columns?)\b/i;
const CODEISH = /\b[a-z]+[A-Z]|[_./\\`#@$={}<>[\]]|[a-z]\d|\d[a-z]/;
// Not steps: "ok, thanks", "ไม่เป็นไร ขอบคุณ"
const CHAT_WORD =
  /^(?:ok(?:ay)?|yes|yeah|yep|no|nope|sure|thanks?|thank you|cool|great|nice|fine|good|never ?mind|nvm|hi|hello|hey|please|wait|stop|cancel|later|โอเค|ได้|ได้เลย|ใช่|ไม่|ไม่เป็นไร|ขอบคุณ|ช่างมัน|ยกเลิก|เดี๋ยว(?:ก่อน)?)$/i;

// Thai role names → ASCII role ids (RLT ids are [a-z0-9-]); any other Thai name becomes step-N.
const THAI_IDS: [RegExp, string][] = [
  [/^นักวิจัย/, 'researcher'],
  [/^นักเขียน/, 'writer'],
  [/^บรรณาธิการ/, 'editor'],
  [/^ผู้ตรวจ/, 'reviewer'],
];
const REVIEW = /\b(?:review|editor|check|qa|test)|ตรวจ|รีวิว|บรรณาธิการ|ทดสอบ/i;
const RESERVED = new Set(['assistant', 'jobs', 'sub']);
const UPDATE = /^\s*\[RLT team update\]/i;

interface Found {
  rest: string; // the ask after the "workflow"/"team" noun (spaces collapsed, line breaks kept)
  masked: string; // the same with quoted names blanked out
  thai: boolean;
  own: boolean; // "make my own version of the “X” workflow"
}

const SHAPES = [
  { opener: EN_OPENER, noun: EN_DESIGN, tail: EN_TAIL, thai: false, own: false },
  { opener: EN_OPENER, noun: EN_OWN, tail: EN_TAIL, thai: false, own: true },
  { opener: TH_OPENER, noun: TH_DESIGN, tail: TH_TAIL, thai: true, own: false },
];

/** Spaces collapsed, line breaks kept: they separate steps ("Create a workflow:\n- Planner\n- Builder"). */
function tidyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n\s*/g, '\n').trim();
}

/** Quoted names blanked out (same length), so “Q3: Launch” has no colon and "github-readme-stats" is no CI word. */
function maskQuotes(s: string): string {
  return s.replace(/“[^“”\n]*”|"[^"\n]*"/g, (q) => `${q[0]}${'x'.repeat(q.length - 2)}${q.at(-1)}`);
}

function findDesign(text: string): Found | null {
  const t = tidyText(text);
  const masked = maskQuotes(t);
  if (!t || CI.test(masked)) return null;
  for (const s of SHAPES) {
    const lead = masked.match(s.opener)?.[0].length ?? 0;
    const noun = masked.slice(lead).match(s.noun);
    if (!noun) continue;
    const end = lead + noun[0].length;
    if (s.tail.test(masked.slice(end))) return { rest: t.slice(end), masked: masked.slice(end), thai: s.thai, own: s.own };
  }
  return null;
}

/** "Change the “X” workflow: …", "แก้ workflow …" — an existing workflow, which the demo model can't change. */
function changesWorkflow(text: string): boolean {
  const masked = maskQuotes(tidyText(text));
  if (CI.test(masked)) return false;
  return EN_CHANGE.test(masked.replace(EN_OPENER, '')) || TH_CHANGE.test(masked.replace(TH_OPENER, ''));
}

/** Does the ask say "use it for this job"? true, false ("but don't use it for this job yet") or null (not said). */
function assignOf(text: string): boolean | null {
  const t = maskQuotes(text.replace(/\s+/g, ' ').trim());
  let said: boolean | null = null;
  for (const re of ASSIGN_ALL) {
    for (const m of t.matchAll(re)) {
      const before = t.slice(0, m.index);
      if (!EN_NEG.test(before) && !TH_NEG.test(before)) return true;
      said = false;
    }
  }
  return said;
}

/** A step name as the user wrote it, without articles, numbering, quotes and trailing particles; ≤ 40 chars. */
function cleanName(raw: string): string {
  const s = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[*`“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:\d+[.)]\s*|step\s*\d+\s*[:.)-]?\s*)/i, '')
    .replace(/^(?:(?:a|an|the|one|then|and|finally|first|next)\s+)+/i, '')
    .replace(/(?:\s*(?:please|thanks|เลย|หน่อย|ด้วย|(?:นะ)?(?:ค่ะ|คะ|ครับ|จ้า|จ้ะ)))+$/i, '')
    .replace(/[\s,;:.!?—–-]+$/, '')
    .replace(/^[\s,;:—–•-]+/, '')
    .trim();
  const name = s.length > 40 ? s.slice(0, 40).trim() : s;
  return /^[a-z]/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function stepId(name: string, n: number): string {
  if (hasThai(name)) return THAI_IDS.find(([re]) => re.test(name))?.[1] ?? `step-${n}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || `step-${n}`;
}

/** A short role name: "a planner", "two senior engineers", "QA", "นักเขียน". */
function roleLike(raw: string): boolean {
  const name = cleanName(raw);
  if (hasThai(name)) return ROLE_TH.test(name);
  const words = name.split(' ');
  const head = words.at(-1) ?? '';
  return words.length <= 3 && !CODEISH.test(raw.trim()) && !NOT_ROLE.test(name) && ROLE_HEAD.test(head) && !THING_HEAD.test(head);
}

const thaiOnly = (s: string) => hasThai(s) && !/[a-z]/i.test(s);

/** `seg` up to "use it for this job" — and without a "but don't" before it. */
function cutAssign(seg: string): string {
  const m = EN_ASSIGN.exec(seg) ?? TH_ASSIGN.exec(seg);
  return m ? seg.slice(0, m.index).replace(EN_NEG, '').replace(TH_NEG, '') : seg;
}

/** One step per bulleted / numbered line; plain lines too unless `bulletsOnly`. */
function itemLines(seg: string, bulletsOnly: boolean): string[] | null {
  const lines = seg.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulleted = lines.filter((l) => BULLET.test(l));
  if (bulleted.length >= 2) return bulleted.map((l) => l.replace(BULLET, ''));
  if (!bulletsOnly && lines.length >= 2 && !ARROW.test(seg)) return lines;
  return null;
}

/** "1. A 2. B 3. C", "- A - B - C", "• A • B" on one line. */
function inlineItems(seg: string): string[] | null {
  const s = seg.trim();
  const head = s.match(/^(?:([-*•])|1[.)])\s+/);
  if (!head) return null;
  const parts = s.slice(head[0].length).split(head[1] ? /\s+[-*•]\s+/ : /\s+\d{1,2}[.)]\s+/);
  return parts.length >= 2 ? parts : null;
}

type ListShape = 'colon' | 'loose' | 'reply';

/** A plain list: "A, B and C", "A then B", "ก แล้ว ข"; Thai-only parts split at spaces too ("นักวิจัย นักเขียน"). */
function listParts(seg: string, shape: ListShape): string[] {
  return seg.split(LIST_SEP).flatMap((p) => {
    if (!thaiOnly(p)) return [p];
    const words = p.trim().split(/\s+/);
    // As a reply only role names split ("นักวิจัย นักเขียน"): "ไม่เป็นไร ขอบคุณ" is no list of steps.
    return shape !== 'reply' || words.every((w) => ROLE_TH.test(w) || !cleanName(w)) ? words : [p];
  });
}

/** No colon, arrows or bullets: only "a team of / with A, B and C" (Thai "ทีมที่มี A B และ C") naming roles. */
function looseParts(seg: string, thai: boolean): string[] | null {
  if (HELPER_WORDS.test(seg)) return null;
  const lead = seg.match(EN_LIST_LEAD) ?? (thai ? seg.match(TH_LIST_LEAD) : null);
  if (!lead) return null;
  const parts = seg
    .slice(lead[0].length)
    .split(LIST_SEP)
    .flatMap((p) => (hasThai(p) ? p.split(/\s+/) : [p]))
    .filter((p) => cleanName(p));
  return parts.length >= 2 && parts.every(roleLike) ? parts : null;
}

/** The step names in `raw`: bullets or lines, an arrow chain, or a list (how strict depends on where it came from). */
function splitSteps(raw: string, shape: ListShape, thai = false): string[] {
  const seg = cutAssign(raw).replace(TRAILING_JOINERS, '');
  let parts = itemLines(seg, shape === 'loose');
  if (!parts && ARROW.test(seg)) {
    const list = shape === 'loose' ? seg.replace(CALLED_WITH, '').replace(EN_LIST_LEAD, '').replace(TH_LIST_LEAD, '') : seg;
    parts = list.split(ARROW);
    // "… → Editor, and keep it short" / "… → Editor. Thanks!": the clause after the last step isn't in its name.
    parts.push((parts.pop() ?? '').split(/[,;\n]|\s+but\b|\.(?=\s|$)/i)[0]);
  }
  if (!parts && shape === 'loose') parts = looseParts(seg, thai) ?? [];
  if (!parts) {
    parts = inlineItems(seg) ?? listParts(seg, shape);
    // A reply is a list of steps only when every part is short and plain (not "fix server.ts, then explain it").
    if (shape === 'reply' && parts.some((p) => p.trim().split(/\s+/).length > 5 || CODEISH.test(p))) parts = [];
  }
  return parts.map(cleanName).filter(Boolean).slice(0, MAX_STEPS);
}

/** The step names in a design ask: after the colon (not one inside a quoted name), or after the noun. */
function stepNames(found: Found): string[] {
  const colon = found.masked.search(/[:：]/);
  return colon >= 0 ? splitSteps(found.rest.slice(colon + 1), 'colon') : splitSteps(found.rest, 'loose', found.thai);
}

/** The steps in a reply to "which steps?": "Planner → Builder", "- A\n- B", "research, write, review". */
function replyNames(text: string): string[] {
  const t = tidyText(text);
  const masked = maskQuotes(t);
  if (!t || CI.test(masked) || HELPER_WORDS.test(masked) || masked.includes('?')) return [];
  const colon = masked.search(/[:：]/);
  const names = splitSteps(colon >= 0 ? t.slice(colon + 1) : t, 'reply');
  return names.length >= 2 && !names.some((n) => CHAT_WORD.test(n)) ? names : [];
}

/** A design ask without steps that the demo answers with "which steps?" (or, for "my own version of X", with how). */
function asksForSteps(f: Found): boolean {
  return !stepNames(f).length && (f.own || (!HELPER_WORDS.test(f.masked) && (f.thai ? TH_BARE : EN_BARE).test(f.masked)));
}

/** The earlier ask, when it was a design ask without steps: this message may be its steps. */
function stepless(earlier: string): Found | null {
  const f = earlier ? findDesign(earlier) : null;
  return f && asksForSteps(f) ? f : null;
}

/** The user's ask before this one (RLT's team updates aside) — what a "which steps?" answer completes. */
export function previousAsk(conv: Conversation): string {
  return conv.userTexts.filter((t) => !UPDATE.test(t)).at(-2) ?? '';
}

/** The steps, ids, kinds and "use it for this job" of a design ask, or of the steps sent after one without them. */
export function parseWorkflowAsk(text: string, earlier = ''): WorkflowAsk {
  const found = findDesign(text);
  const prev = found ? null : stepless(earlier);
  const names = found ? stepNames(found) : prev ? replyNames(text) : [];
  // "use it for this job" carries over from the ask the steps complete, unless this message says otherwise.
  const assign = assignOf(text) ?? (prev && names.length ? assignOf(earlier) : null) ?? false;
  const from = found ?? prev;
  if (!from || !names.length) return { name: '', steps: [], assign };
  const seen = new Set<string>();
  const steps: WorkflowAskStep[] = [];
  for (const [i, name] of names.entries()) {
    const slug = stepId(name, i + 1);
    const base = RESERVED.has(slug) ? `${slug}-role` : slug;
    let id = base;
    for (let k = 2; seen.has(id); k++) id = `${base}-${k}`;
    seen.add(id);
    const review = i > 0 && REVIEW.test(name);
    // A reviewer sends the work back to the nearest earlier step that does the work.
    const back = review ? [...steps].reverse().find((s) => s.kind === 'work')?.id : undefined;
    steps.push({ id, name, kind: review ? 'review' : 'work', ...(back ? { loopBackTo: back } : {}) });
  }
  const called = (from.rest.match(QUOTED_NAME)?.[1] ?? from.rest.match(CALLED_NAME)?.[1])?.trim();
  const chain = steps.map((s) => s.name).join(' → ');
  const name = called || (chain.length > 80 ? `${chain.slice(0, 79)}…` : chain);
  return { name, steps, assign };
}

/** Is this a "design a team / workflow" ask, or one to change an existing workflow? Only for the lead (workflow_save). */
export function workflowIntent(text: string, tools: ReadonlySet<string>): WorkflowIntent | null {
  if (!tools.has('workflow_save')) return null;
  const found = findDesign(text);
  if (found && stepNames(found).length) return 'workflow-design';
  // "Make my own version of the “X” workflow" without steps: the demo can't copy and change one.
  if (found?.own) return 'workflow-change';
  // "Make a workflow for this job" — a design ask without the steps: ask for them.
  if (found && asksForSteps(found)) return 'workflow-design';
  return changesWorkflow(text) ? 'workflow-change' : null;
}

/** "Planner → Builder → Reviewer" right after a design ask without steps (the demo asked which steps). */
export function workflowFollowUp(text: string, tools: ReadonlySet<string>, earlier: string): boolean {
  return tools.has('workflow_save') && !findDesign(text) && !!stepless(earlier) && replyNames(text).length > 0;
}

// ───────────────────────── the save ─────────────────────────

function persona(s: WorkflowAskStep, steps: WorkflowAskStep[]): string {
  const chain = steps.map((x) => x.name).join(' → ');
  const team = steps.length === 1 ? 'a one-person team' : `a ${steps.length}-person team (${chain})`;
  if (s.kind === 'review') {
    const back = steps.find((x) => x.id === s.loopBackTo)?.name;
    return `You are the ${s.name} on ${team}. You check the work before it moves on: read what was made, compare it with the task, and be specific about anything that must change${back ? ` — it goes back to the ${back}` : ''}. Approve when it is good enough; don't nitpick.`;
  }
  return `You are the ${s.name} on ${team}. Do your part of the task well, keep notes short, and hand the next person something clear to work from.`;
}

function saveArgs(ask: WorkflowAsk, _conv: Conversation): Record<string, unknown> {
  const steps = ask.steps.map((s) => ({ id: s.id, name: s.name, model: s.kind === 'review' ? REVIEW_MODEL : MODEL, kind: s.kind, persona: persona(s, ask.steps), ...(s.loopBackTo ? { loopBackTo: s.loopBackTo } : {}) }));
  return {
    i: 'save the team workflow',
    name: ask.name,
    description: describeTeam(steps, modelName), // what the team is, not the chat line that asked for it
    icon: '🧭',
    steps,
    ...(ask.assign ? { use_for_this_job: true } : {}),
  };
}

interface SavedStep {
  name: string;
  model: string;
  kind?: string;
  loopBackTo?: string;
  id?: string;
}

/** workflow_save's result → a few lines: who does what with which model, and whether it is this job's team now. */
export function savedReply(result: string, args: Record<string, unknown> | undefined, thai: boolean): string {
  const first = result.trim().split('\n')[0] ?? '';
  if (!/^Saved\b/.test(first)) {
    const why = gist(result.trim().replace(/^(?:error|failed):\s*/i, ''), 300) || 'no answer from CAST';
    return thai ? `บันทึก workflow ไม่ได้ค่ะ: ${why}` : `I couldn't save the workflow: ${why}`;
  }
  const name = first.match(/“([^”]+)”/)?.[1] ?? String(args?.name ?? '');
  const steps = (Array.isArray(args?.steps) ? args.steps : []) as SavedStep[];
  const nameOf = (ref: string | undefined) => steps.find((s) => s.id === ref)?.name ?? ref ?? '';
  const who = steps
    .map((s) => {
      const model = modelName(s.model);
      if (s.kind !== 'review') return `- **${s.name}** — ${model}`;
      const back = nameOf(s.loopBackTo);
      if (thai) return `- **${s.name}** — ${model} ตรวจงาน${back ? ` ถ้าต้องแก้จะส่งกลับให้${back}` : ''}`;
      return `- **${s.name}** — ${model}, checks the work${back ? ` and sends it back to the ${back} if it needs changes` : ''}`;
    })
    .join('\n');
  const assigned = /team is now\b/i.test(result);
  const blocked = !assigned && args?.use_for_this_job === true && /running/i.test(result);
  const demo = /demo model/i.test(result);
  const head = thai ? `บันทึก workflow **${name}** แล้วค่ะ` : `Saved the **${name}** workflow.`;
  const team = thai
    ? assigned
      ? 'ตั้งเป็นทีมของงานนี้แล้วค่ะ — บอกว่า “ให้ทีม…” แล้วจะเริ่มให้เลยค่ะ'
      : blocked
        ? 'ตอนนี้ทีมของงานนี้กำลังทำงานอยู่ เลยยังตั้งเป็นทีมไม่ได้ค่ะ — รอรอบนี้จบก่อนนะคะ'
        : 'ยังไม่ได้ตั้งเป็นทีมของงานนี้นะคะ — เลือกได้ในแท็บ Workflow ค่ะ'
    : assigned
      ? "It's this job's team now — say “have the team …” and I'll start it."
      : blocked
        ? "The job's team is running right now, so I couldn't make it this job's team yet — ask again when the run ends."
        : "It isn't this job's team yet — pick it in the Workflow tab when you want it here.";
  const note = demo ? (thai ? '\n\n(ยังไม่ได้เชื่อม provider ทุกขั้นตอนจะรันบนโมเดลเดโมไปก่อนค่ะ)' : '\n\n(No provider is connected yet, so every step runs on the demo model for now.)') : '';
  return `${head}${who ? `\n\n${who}` : ''}\n\n${team}${note}`;
}

function designSteps(thai: boolean): Step[] {
  return [
    {
      name: 'wf-save',
      plan(ctx) {
        const ask = parseWorkflowAsk(ctx.conv.userText, previousAsk(ctx.conv));
        if (!ask.steps.length) {
          return {
            text: thai
              ? 'ได้เลยค่ะ — อยากให้ทีมมีขั้นตอนอะไรบ้างคะ? เช่น นักวิจัย → นักเขียน → บรรณาธิการ (คนสุดท้ายตรวจงาน แล้วส่งกลับไปแก้ได้)'
              : 'Sure — which steps should the team have? For example: Researcher → Writer → Editor (the last one reviews and can send the work back).',
          };
        }
        const reviews = ask.steps.filter((s) => s.loopBackTo).map((s) => `${s.name} reviews and sends work back to ${ask.steps.find((x) => x.id === s.loopBackTo)?.name}`);
        return {
          thinking: `They want a new team: ${ask.steps.map((s) => s.name).join(' → ')}.${reviews.length ? ` ${reviews.join('; ')}.` : ''} I'll save it with workflow_save${ask.assign ? ' and make it this job\'s team' : ''} — CAST writes the step instructions.`,
          calls: [{ name: 'workflow_save', args: saveArgs(ask, ctx.conv) }],
        };
      },
    },
    { name: 'wf-done', plan: (ctx) => ({ text: savedReply(ctx.result('wf-save'), ctx.calls('wf-save')[0]?.args, thai) }) },
  ];
}

/** The demo model can't change an existing workflow (or copy one and change it): say where to do it instead. */
function changeReply(own: boolean, thai: boolean): string {
  if (thai) {
    return own
      ? 'ตอนนี้เป็นโมเดล**เดโม** เลยคัดลอกแล้วแก้ workflow ที่มีอยู่ไม่ได้ค่ะ — แก้ได้ในแท็บ **Workflow** หรือเชื่อม provider ใน **Models & providers** ก่อนนะคะ หรือบอกขั้นตอนที่อยากได้มาเลย (เช่น นักวิจัย → นักเขียน → บรรณาธิการ) แล้วจะบันทึกเป็น workflow ใหม่ให้ค่ะ'
      : 'ตอนนี้เป็นโมเดล**เดโม** เลยแก้ workflow ที่มีอยู่ไม่ได้ค่ะ — แก้ได้ในแท็บ **Workflow** หรือเชื่อม provider ใน **Models & providers** แล้วสั่งใหม่อีกครั้งนะคะ ถ้าอยากได้ workflow ใหม่ พิมพ์เช่น “สร้าง workflow: นักวิจัย → นักเขียน → บรรณาธิการ” ได้เลยค่ะ';
  }
  return own
    ? "I'm the offline **demo** model, so I can't copy and change an existing workflow — edit it in the **Workflow** tab, or connect a provider in **Models & providers**. Or list the steps you want (e.g. Planner → Builder → Reviewer) and I'll save them as a new workflow."
    : "I'm the offline **demo** model, so I can't change an existing workflow — edit it in the **Workflow** tab, or connect a provider in **Models & providers** and ask me again. I can save a new one, though: say e.g. “Create a workflow: Planner → Builder → Reviewer”.";
}

export function workflowTurn(ctx: Ctx, intent: WorkflowIntent = 'workflow-design'): TurnPlan {
  const thai = thaiChat(ctx.conv);
  if (intent === 'workflow-change') {
    const own = !!findDesign(ctx.conv.userText)?.own;
    return { thinking: "They want an existing workflow changed. The demo model can't do that — no file edits; point them at the Workflow tab.", text: changeReply(own, thai) };
  }
  return runScript(ctx, designSteps(thai), thai ? 'เรียบร้อยค่ะ' : 'Done.');
}
