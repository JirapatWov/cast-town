// The lead's team tools (RLT host tools, see lead-tools.ts): hand an ask to the job's team with team_start, check
// on the run with team_status, stop it with team_stop, redo only a later part of the last run with team_continue,
// change a running team's later steps with team_edit (it keeps going),
// and turn RLT's "[RLT team update]" message into a few lines for the user. Only the lead (the house Assistant) has these tools; without them "team" still means helpers.
import type { Conversation } from './conversation';
import { viewProject, type ProjectKind } from './describe';
import { hasThai } from './project-scan';
import { gist, runScript, type Ctx, type Step, type TurnPlan } from './script';

export type TeamIntent = 'team-run' | 'team-continue' | 'team-edit' | 'team-status' | 'team-stop' | 'team-update';

export const isTeamIntent = (intent: string): intent is TeamIntent => intent.startsWith('team-');

const UPDATE = /^\s*\[RLT team update\]/i;

// "ask/have/tell/let the team …", "get/use the team to …", "start/put the team on …" (not "make the team page …")
const EN_LEAD =
  /\b(?:(?:ask|have|tell|let)\s+(?:the|my|our|your)\s+team\b(?:\s+to\b)?|(?:get|use|want|need)\s+(?:the|my|our|your)\s+team\s+to\b|(?:start|put|set|run|kick off)\s+(?:the|my|our|your)\s+team(?:\s+(?:on|with)\b|\s*[.!?]*$))/i;
// "send / hand this to the team"
const EN_HANDOFF = /\b(?:send|give|hand|pass|delegate|assign|forward)\b(?:\s+(?:this|it|that|the (?:work|job|task)|(?:this|that) (?:one|job|task)))?(?:\s+over)?\s+to\s+(?:the|my|our|your)\s+team\b/i;
// "Team: …", "Team, …", "the team should …" (not "team-based …")
const EN_ADDRESS = /^(?:hey\s+|ok\s+)?(?:the\s+)?team(?:\s*[:,]|\s+[—–-]\s|\s+(?:should|must|needs? to)\b)/i;
// "… — do it with the team", "… using the team"
const EN_TAIL = /\s(?:(?:using|via)\s+(?:the|my|our)\s+team|(?:do|handle|tackle|run)\s+(?:this|it|that)\s+with\s+(?:the|my|our)\s+team)\s*[.!?]*$/i;
// "ให้ทีม…", "สั่งทีม(ให้)…", "เริ่มทีม…", "ส่งงานนี้ให้ทีม" — at the start (mid-sentence ให้ทีม is often "for the team")
const TH_LEAD = /^(?:(?:โอเค|ok|งั้น|ถ้างั้น|ต่อไป|ช่วย|รบกวน|ลอง|กรุณา)\s*)*(?:ขอ)?(?:ให้|สั่ง(?:ให้)?|บอก(?:ให้)?|เริ่ม(?:ให้)?|ใช้|ส่ง(?:งาน)?(?:นี้|นั้น)?(?:ไป)?ให้|มอบ(?:งาน)?(?:นี้|นั้น)?ให้)\s*ทีม(?:งาน)?(?:\s*(?:ให้|ช่วย|มา|ไป))*/i;
const TEAM_ASKS = [TH_LEAD, EN_ADDRESS, EN_HANDOFF, EN_LEAD, EN_TAIL];

// Status and stop asks are questions / orders about the team itself, so they lead the message ("how is the team
// doing", "ทีมถึงไหนแล้ว") — "have the team check the status page" stays a team ask.
const EN_OPENER = String.raw`^(?:(?:hey|so|ok|okay|and|btw|now|quick question|can you|could you|please|just|actually|wait|let's|lets)[\s,!]+)*`;
const EN_STATUS = new RegExp(
  EN_OPENER +
    String.raw`(?:(?:how(?:'s| is| are)|what(?:'s| is| are)|is|are|has|did)\s+(?:the|my|our)\s+team\b[^.?!]{0,30}\b(?:doing|going|getting on|coming along|up to|working(?: on)?|running|busy|done|finish(?:ed)?|ready|progress)\b` +
    String.raw`|how(?:'s| is| are)\s+(?:the|my|our)\s+team\s*[?!.]*$|where(?:'s| is| are)\s+(?:the|my|our)\s+team\b|how far(?: along)? is (?:the|my|our) team\b` +
    String.raw`|(?:the\s+)?team(?:'s)?\s+(?:status|progress)\b|(?:what(?:'s| is)\s+the\s+)?(?:status|progress|news)\s+(?:on|of|from)\s+(?:the\s+)?team\b` +
    String.raw`|any\s+(?:news|updates?|progress)\s+(?:on|from)\s+(?:the\s+)?team\b|check(?:\s+in)?\s+on\s+(?:the\s+)?team\b` +
    String.raw`|ask\s+(?:the|my|our)\s+team\s+(?:how\s+(?:it's|it is|things are|they're|they are)\s+going|how far|where they are))`,
  'i',
);
const TH_STATUS =
  /^(?:(?:ตอนนี้|แล้ว|ว่าแต่|เออ|ขอ|ช่วย)\s*)*(?:(?:เช็ค|เช็ก|ดู|ถาม)\s*)?(?:(?:สถานะ|ความคืบหน้า)(?:ของ)?\s*ทีม|ทีม(?:งาน)?.{0,12}(?:ถึงไหน|เป็น(?:ยัง)?ไง|คืบหน้า|เสร็จ(?:หรือ|รึ)?ยัง|ทำอะไรอยู่|ทำถึงไหน))/;
// A bare "status?" / "ถึงไหนแล้ว" — the lead's only background work is the team's.
const BARE_STATUS = /^(?:status|progress|any (?:news|updates?)|how(?:'s| is) it going|ถึงไหนแล้ว|คืบหน้ายังไง(?:บ้าง)?|เสร็จยัง)\s*[?!.]*$/i;

const EN_STOP = new RegExp(
  EN_OPENER +
    String.raw`(?:stop|halt|cancel|abort|kill|call off)\s+(?:the\s+|my\s+|our\s+|this\s+)?(?:team(?:'s)?|(?:team\s+)?run|workflow)\b|\bteam\b[^.?!]{0,8}\b(?:stop|halt)(?:\s+(?:now|working|it|please))?\s*[.!?]*$`,
  'i',
);
const TH_STOP = /หยุดทีม|ยกเลิก(?:งาน)?(?:ของ)?ทีม|หยุดงาน(?:ของ)?ทีม|หยุดรัน|ทีม.{0,6}หยุด(?:ก่อน|เลย|ได้แล้ว|ที)?\s*(?:นะ)?(?:คะ|ค่ะ|ครับ)?\s*[.!?]*$/;

// Redo only a later part of the team's last run (team_continue): "just redo the review", "fix only the last part",
// "carry on from the reviewer", "แก้เฉพาะท่อนหลัง", "ทำต่อจาก reviewer". A bare "fix … just …" / "just fix …" / "แก้แค่ …" is a
// change ask unless it names a part of the run ("fix just a typo", "ask the team to fix only the typo" stay changes).
const EN_CONTINUE = /\b(?:redo|re-?run|run again|retry|do again)\b[^.?!]{0,40}\b(?:only|just)\b|\bfrom (?:the )?[\w-]+ (?:step )?on\b|\b(?:carry on|continue) from\b/i;
const EN_FIX_ONLY = /\bfix\b[^.?!]{0,40}\b(?:only|just)\b|\b(?:only|just)\s+(?:redo|re-?run|fix)\b/i;
const TH_CONTINUE = /เฉพาะ(?:ท่อน|ส่วน|ขั้น|ช่วง)?(?:หลัง|ท้าย)|(?:ทำ|รัน)ใหม่(?:แค่|เฉพาะ|ตั้งแต่)|ทำต่อจาก/;
const TH_FIX_ONLY = /แก้แค่/;
// (not "team" / "run" / ทีม: every team ask says that)
const PART_WORD = /\b(?:part|step|steps|stage|review|reviewer|later|last|final|rest|end)\b|ขั้น|ท่อน|ส่วน|ช่วง|ตรวจ|รีวิว|รอบ/i;

// Change a running team's later steps (team_edit): a step's prompt / persona / model, a person added or a step taken
// out — "change the Editor's prompt: …", "add a proofreader after the editor", "เปลี่ยน prompt ของการเกลาคำนิดนึง",
// "เพิ่ม step ตรวจคำผิดต่อจากเกลาคำ". Only about the team (a step, the team, the workflow, a step's prompt), never a file:
// "change the prompt text in src/prompts.ts" and "add a step to the CI script" stay changes.
const EN_EDIT_WHAT = /\b(?:change|tweak|edit|update|adjust|modify|rewrite|reword)\b[^.?!]{0,40}?\b(?:prompt|instructions?|persona|model)\b/i;
const EN_EDIT_STEP = /\b(?:change|tweak|edit|update|adjust|modify)\s+(?:the\s+)?[\w-]+(?:'s)?\s+step\b/i;
const EN_EDIT_ADD = /\b(?:add|insert|put in)\s+(?:a|an|one|another|one more|a new|an extra)\s+(?:[\w-]+\s+){0,2}?(?:step|person|member|reviewer|proofreader|editor|checker|fact-?checker)\b(?!\s+(?:counter|indicator|bar|button|field|page|form|component|function|test))/i;
const EN_EDIT_REMOVE = /\b(?:remove|drop)\s+(?:the\s+)?[\w-]+\s+step\b|\b(?:remove|drop)\s+(?:the\s+)?[\w-]+\s+from\s+(?:the|this)\s+(?:team|run|workflow)\b/i;
const EN_EDIT_CONTEXT = /\bteam(?:'s)?\b|\bworkflow\b|\bstep\b|\b(?:after|before)\s+(?:the\s+)?[\w-]+|'s\s+(?:prompt|instructions?|persona|model)\b|\b(?:editor|writer|reviewer|proofreader|implementer|decoder|idea-maker|polish(?:er|ing)?)\b/i;
const TH_EDIT = /(?:เปลี่ยน|แก้|ปรับ|เพิ่ม|ลบ|ตัด|ย้าย)\s*(?:prompt|promt|พรอมต์|พร้อมท์|คำสั่ง|persona|บุคลิก|โมเดล|model|step|สเต็ป|ขั้น(?:ตอน)?(?!การ)|คน)/i;
// (also "แก้ prompt ขั้นเกลาคำ", a step named by what it does — "ขั้นเกลาคำ", "ขั้นตรวจ" — and a step added before or
// after another: "เพิ่มขั้นตรวจคำผิดหลังเกลาคำ")
const TH_EDIT_CONTEXT =
  /ทีม|เวิร์กโฟลว์|workflow|โฟลว์|\bflow\b|step|สเต็ป|(?:prompt|promt|พรอมต์|พร้อมท์|คำสั่ง)\s*(?:ของ|ให้|ขั้น|สเต็ป)|ต่อจาก|ขั้น(?:ตอน)?\s*(?:ที่|ต่อ|ใหม่|หลัง|ก่อน|สุดท้าย)|ขั้น(?:ตอน)?\s*(?:การ)?\s*(?:ขัดเกลา|เกลา|ตรวจ|รีวิว|เขียน|คิดเรื่อง|ไอเดีย)|เพิ่ม\s*(?:สเต็ป|ขั้น(?:ตอน)?(?!การ)|คน)[^]{1,40}?(?:หลัง|ก่อน)/i;
// a file, code or a script: a change to the project, not to the team
const NOT_TEAM = /[\w-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|md|json|ya?ml|toml|css|html|go|rs|sh)\b|\b(?:CI|script|pipeline|file|code|function|component|page|form|wizard|onboarding)\b|ไฟล์|โค้ด|สคริปต์/i;

function isEditAsk(t: string): boolean {
  if (NOT_TEAM.test(t)) return false;
  if ([EN_EDIT_WHAT, EN_EDIT_STEP, EN_EDIT_ADD, EN_EDIT_REMOVE].some((re) => re.test(t)) && EN_EDIT_CONTEXT.test(t)) return true;
  return TH_EDIT.test(t) && TH_EDIT_CONTEXT.test(t);
}

/** What the ask wants from the lead's team tools, or null when it is not about the team (or the tool is missing). */
export function teamIntent(text: string, tools: ReadonlySet<string>): TeamIntent | null {
  if (UPDATE.test(text)) return 'team-update';
  const t = text.trim();
  if (tools.has('team_stop') && (EN_STOP.test(t) || TH_STOP.test(t))) return 'team-stop';
  if (tools.has('team_status') && (EN_STATUS.test(t) || TH_STATUS.test(t) || BARE_STATUS.test(t))) return 'team-status';
  const fixOnly = (EN_FIX_ONLY.test(t) || TH_FIX_ONLY.test(t)) && PART_WORD.test(t);
  if (tools.has('team_continue') && (EN_CONTINUE.test(t) || TH_CONTINUE.test(t) || fixOnly)) return 'team-continue';
  if (tools.has('team_edit') && isEditAsk(t)) return 'team-edit';
  if (tools.has('team_start') && TEAM_ASKS.some((re) => re.test(t))) return 'team-run';
  return null;
}

// ───────────────────────── the brief ─────────────────────────

const POLITE = /^(?:(?:please|pls|ok|okay|now|then|so|hey|can you|could you|would you|will you|let's|lets|go ahead and|i want you to|i'd like you to|and)[\s,]+)+/i;
const PLACEHOLDER = /^(?:(?:(?:do|handle|take care of|work on|tackle|take|pick up|look at|deal with)\s+)?(?:it|this|that|this one|that one)|do|ทำ|ทำเลย|ทำที|ทำต่อ|จัดการ(?:ที|ให้)?)?\s*(?:now|please|for me|then|เลย|หน่อย|(?:นะ)?(?:ค่ะ|คะ|ครับ))?\s*[.!?]*$/i;
// Thai has no spaces between words: strip only particles that never end a real word (not นะ — ชนะ, not ที — นาที).
const TRAILING = /(?:\s*(?:please|thanks|thank you|หน่อย|(?:นะ)?(?:ค่ะ|คะ|ครับ|จ้า|จ้ะ)))+\s*[.!?]*$/i;
const REFERS_BACK = /\b(?:this|that|it)\b|นี้|นั้น/i;

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(POLITE, '')
    .replace(/^(?:(?:to|on|with|for|and|then)\b|[,:;—–-])\s*/i, '')
    .replace(TRAILING, '')
    .replace(/[\s,;:—–.!-]+$/, '')
    .trim();
}

/** The task to give the team: the ask without "have the team …"; "send this to the team" → the ask before it. */
export function teamTask(text: string, earlier = ''): string {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const re of TEAM_ASKS) {
    const m = re.exec(t);
    if (!m) continue;
    const after = tidy(t.slice(m.index + m[0].length));
    const before = tidy(t.slice(0, m.index));
    const pick = after && !PLACEHOLDER.test(after) ? after : before && !PLACEHOLDER.test(before) ? before : REFERS_BACK.test(t) ? tidy(earlier) : '';
    return pick.charAt(0).toUpperCase() + pick.slice(1);
  }
  return '';
}

/** The user's previous real ask (not an RLT update) — what "send this to the team" points at. */
function earlierAsk(conv: Conversation): string {
  return conv.userTexts.filter((t) => !UPDATE.test(t)).at(-2) ?? '';
}

/** Answer in Thai when the user writes Thai (RLT's own updates are English, so look past them). */
export function thaiChat(conv: Conversation): boolean {
  return hasThai(conv.userTexts.filter((t) => !UPDATE.test(t)).at(-1) ?? conv.userText);
}

// ───────────────────────── reading run reports ─────────────────────────

type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

interface RunReport {
  name: string | null;
  status: RunStatus | null;
  elapsed: string | null;
  cost: string | null;
  steps: { name: string; state: string; parallel?: boolean; id?: string }[]; // id: describeRun's [id]
  runId: string | null; // describeRun's Run <id> line
  latest: { who: string; text: string } | null;
  folder: string | null;
}

const STATUS_WORDS: [RegExp, RunStatus][] = [
  [/waiting/i, 'waiting'],
  [/running/i, 'running'],
  [/failed/i, 'failed'],
  [/stopped|aborted|cancell?ed/i, 'stopped'],
  [/completed|finished|done/i, 'completed'],
];

/** describeRun's text (team_status, the update message) — or the short "“X” completed in 2 min — A done, B approve." form. */
export function parseRunReport(text: string): RunReport {
  const body = text.replace(UPDATE, '').trim();
  const head = body.split('\n')[0] ?? '';
  // The headline and describeRun's first line — not the task or a step's output, which can say anything.
  const top = body
    .split('\n')
    .filter((l) => l.trim() && !/^(?:Task|Latest output|Folder|Steps|Run run-|To redo only part|Its files were reverted|Earlier runs of this job|Changed while it ran|While it runs)\b/.test(l) && !/^\s*said:/.test(l) && !/^\s*[-*•]\s/.test(l))
    .slice(0, 2)
    .join('\n');
  const statusOf = (s: string) => STATUS_WORDS.find(([re]) => re.test(s))?.[1] ?? null;
  // describeRun's own line ("“X” — running, 45s so far, $0.12.") is the most precise; the update's headline comes first.
  const runLine = body.match(/^“[^”]+”\s+—\s+([^,\n]+)/m)?.[1];
  // "- B (at the same time as the one before): done" — B worked beside the step before it (a parallel group)
  // "- B (at the same time as the one before): done [b]" — B worked beside the step before it; [b] is its id
  const steps: RunReport['steps'] = [...body.matchAll(/^\s*[-*•]\s+([^:\n]+?):\s+(.+)$/gm)].map(([, name, raw]) => {
    const id = raw.trim().match(/\s\[([\w-]+)\]$/)?.[1];
    return {
      name: name.replace(/\s*\(at the same time as the one before\)$/, '').replace(/\s*\[[\w-]+\]$/, '').trim(),
      state: raw.trim().replace(/\s+\[[\w-]+\]$/, ''),
      ...(/\(at the same time as the one before\)$/.test(name.trim()) ? { parallel: true } : {}),
      ...(id ? { id } : {}),
    };
  });
  if (!steps.length) {
    // Short form: "… — Decoder done, Implementer done, Reviewer approve."
    const inline = head.match(/\s—\s+([^.]+)/)?.[1] ?? '';
    for (const part of inline.split(/,\s*/)) {
      const m = part.trim().match(/^(.+?)\s+(\S+)$/);
      if (m && !/\d/.test(part)) steps.push({ name: m[1], state: m[2] });
    }
  }
  const latest = body.match(/^Latest output \(([^)]+)\):\s*(.+)$/m);
  // describeRun's Folder line first (a kept step's output may name the earlier run's folder)
  const folder = body.match(/^Folder:\s*(\.rlt\/runs\/[\w-]+\/?)/m)?.[1] ?? body.match(/\.rlt\/runs\/[\w-]+\/?/)?.[0] ?? null;
  return {
    name: top.match(/“([^”]+)”/)?.[1] ?? null,
    status: statusOf(runLine ?? '') ?? statusOf(head),
    elapsed: top.match(/\b(?:after|in)\s+(\d+(?:\.\d+)?\s?(?:min|s|h))\b/)?.[1] ?? top.match(/,\s*(\d+(?:\.\d+)?\s?(?:min|s|h))\b/)?.[1] ?? null,
    cost: top.match(/\$\d+(?:\.\d+)?/)?.[0] ?? null,
    steps,
    latest: latest ? { who: latest[1], text: latest[2] } : null,
    folder: folder ? folder.replace(/\/?$/, '/') : null,
    runId: body.match(/^Run (run-[\w-]+)/m)?.[1] ?? null,
  };
}

const TH_STATE: [RegExp, string][] = [
  [/asked for changes/, 'ขอให้แก้'],
  [/approved/, 'อนุมัติ'],
  [/^working/, 'กำลังทำ'],
  [/not started/, 'ยังไม่เริ่ม'],
  [/^done/, 'เสร็จ'],
  [/failed/, 'ไม่สำเร็จ'],
  [/skipped/, 'ข้าม'],
  [/pending/, 'รอคิว'],
];

/** "done (approve)" → "approved", "revise" → "asked for changes"; keeps "working — editing server.ts"; a step kept
 *  from an earlier run (a continuation: "done (kept from run-…)") says "kept". */
function stateText(state: string, thai: boolean): string {
  const changed = /\s*\(changed during the run\)$/.test(state);
  if (changed) return `${stateText(state.replace(/\s*\(changed during the run\)$/, ''), thai)}${thai ? ' (แก้ระหว่างรัน)' : ' (changed during the run)'}`;
  const kept = /\s*\(kept from [\w-]+\)$/.test(state);
  const s = state
    .replace(/\s*\(kept from [\w-]+\)$/, '')
    .replace(/^(?:done\s*)?\(?approve\)?$/i, 'approved')
    .replace(/^(?:done\s*)?\(?revise\)?$/i, 'asked for changes');
  if (!thai) return kept ? `${s} (kept)` : s;
  const [word, detail] = s.split(/\s+—\s+/, 2);
  const th = TH_STATE.find(([re]) => re.test(word))?.[1] ?? word;
  return `${detail ? `${th} — ${detail}` : th}${kept ? ' (ใช้ผลเดิม)' : ''}`;
}

function stepsInline(r: RunReport, thai: boolean): string {
  // people who worked at the same time are joined with " + "
  return r.steps.map((s, i) => `${i === 0 ? '' : s.parallel ? ' + ' : ', '}${s.name} ${stateText(s.state, thai)}`).join('');
}

/** A reply-sized excerpt of a step's output (no fenced verdict blocks). */
function excerpt(text: string): string {
  return gist(text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/(^|\s)#{1,6}\s+|\*\*/g, '$1'), 180);
}

// ───────────────────────── replies ─────────────────────────

/** team_start's result → a few lines: the team started (and what the user changed on the plan card), the user
 *  cancelled the plan (or wrote something new instead), or why it couldn't start. */
export function startedReply(result: string, thai: boolean): string {
  const first = result.trim().split('\n')[0] ?? '';
  if (/^The user cancelled this plan/i.test(first)) {
    return thai
      ? 'ได้ค่ะ ไม่เริ่มทีมนะคะ — อยากให้ทำแบบไหนบอกได้เลยค่ะ จะเปลี่ยนคนหรือโมเดล หรือให้ทำเองก็ได้ค่ะ'
      : "OK — I won't start that team. Tell me how you'd like it done instead: other people or models, or I can do it myself.";
  }
  if (/^The user wrote a new message/i.test(first)) return thai ? 'เห็นข้อความใหม่แล้วค่ะ ทำตามนั้นนะคะ' : "I see your new message — I'll go with that instead.";
  if (/^The user pressed Stop|^The plan was withdrawn/i.test(first)) return thai ? 'หยุดแล้วค่ะ ไม่ได้เริ่มทีมนะคะ' : 'Stopped — no team was started.';
  if (!/^Started\b/i.test(first)) {
    const why = gist(first.replace(/^(?:error|failed):\s*/i, ''), 200) || 'no answer from CAST';
    return thai ? `เริ่มทีมไม่ได้ค่ะ: ${why}` : `I couldn't start the team: ${why}`;
  }
  // "Started “Decode → Implement → Review” (Decoder → Implementer → Reviewer), run <id>. …"
  const steps = first.match(/”\s*\(([^)]+)\)/)?.[1] ?? first.match(/“([^”]+)”/)?.[1] ?? '';
  const changed = result.match(/approved the plan and changed: (.+?)\.(?: Keep their model choices|$)/m)?.[1];
  // team_continue: "… run <new> — continuing run <old> from Reviewer: Decoder → Implementer keep their results, …"
  const cont = first.match(/— continuing run [\w-]+ from (.+?): (?:(.+?) keeps? (?:its result|their results)|nothing is kept)/);
  if (cont) {
    const [, from, kept] = cont;
    if (thai) {
      const note = changed ? ` (ใช้ตามที่คุณเลือกไว้นะคะ: ${changed})` : '';
      return `${kept ? `ทีมทำต่อจาก ${from} ค่ะ — ${kept} ใช้ผลเดิม` : `ทีมเริ่มทำใหม่ตั้งแต่ ${from} ค่ะ บนไฟล์ที่มีอยู่ตอนนี้`}${note} ระหว่างนี้ถามอะไรก็ได้นะคะ หรือถามว่าทีมถึงไหนแล้วก็ได้ค่ะ`;
    }
    const many = !!kept && /→|\+/.test(kept);
    const note = changed ? ` With your picks: ${changed}.` : '';
    return `${kept ? `The team is on it — continuing from ${from}; ${kept} keep${many ? '' : 's'} ${many ? 'their results' : 'its result'}.` : `The team is on it again from ${from}, on the files as they are now.`}${note} I'm free meanwhile; ask me anything, or ask how the team is doing.`;
  }
  if (thai) {
    const note = changed ? ` (ใช้ตามที่คุณเลือกไว้นะคะ: ${changed} — ทีมต่อ ๆ ไปในงานนี้จะใช้ตามนี้ค่ะ)` : '';
    return `ทีมรับงานแล้วค่ะ${steps ? ` — ${steps}` : ''}${note} ระหว่างนี้ถามอะไรก็ได้นะคะ หรือถามว่าทีมถึงไหนแล้วก็ได้ค่ะ`;
  }
  const note = changed ? ` With your picks: ${changed} — I'll keep those for later teams in this job.` : '';
  return `The team is on it${steps ? ` — ${steps}` : ''}.${note} I'm free meanwhile; ask me anything, or ask how the team is doing.`;
}

/** A run's cost as the demo lead says it: the demo model's numbers are simulated — nothing was billed. */
function simCost(cost: string, thai: boolean): string {
  return thai ? `ค่าใช้จ่ายจำลอง ${cost}` : `simulated cost ${cost}`;
}

export function statusReply(result: string, thai: boolean): string {
  if (/no team runs? (?:yet|is going)/i.test(result) || !result.trim()) {
    return thai ? 'งานนี้ทีมยังไม่ได้ทำอะไรเลยค่ะ — บอกได้เลยว่าจะให้ทีมทำอะไร' : "The team hasn't worked on anything in this job yet — tell me what to start them on.";
  }
  const r = parseRunReport(result);
  const name = r.name ? `**${r.name}**` : thai ? 'งานของทีม' : 'the run';
  const cost = r.cost ? `, ${simCost(r.cost, thai)}` : '';
  const head = thai
    ? {
        running: `ทีมกำลังทำ ${name} อยู่ค่ะ${r.elapsed ? ` (ผ่านไป ${r.elapsed}${cost})` : ''}`,
        waiting: `ทีมรอให้คุณอนุมัติขั้นตอนหนึ่งของ ${name} อยู่ค่ะ — เปิดแท็บ Workflow เพื่อให้ทำต่อได้`,
        completed: `รอบล่าสุดของทีม ${name} เสร็จแล้วค่ะ${r.elapsed ? ` (ใช้เวลา ${r.elapsed}${cost})` : ''}`,
        failed: `รอบล่าสุดของทีม ${name} ไม่สำเร็จค่ะ${r.elapsed ? ` (หลัง ${r.elapsed})` : ''}`,
        stopped: `รอบล่าสุดของทีม ${name} ถูกหยุดไปแล้วค่ะ`,
      }
    : {
        running: `The team is on ${name} — ${r.elapsed ? `${r.elapsed} so far${cost}` : 'still working'}.`,
        waiting: `The team is waiting for your approval on a step of ${name} — open the Workflow tab to let it continue.`,
        completed: `The team's last run, ${name}, completed${r.elapsed ? ` in ${r.elapsed}` : ''}${r.cost ? ` (${simCost(r.cost, false)})` : ''}.`,
        failed: `The team's last run, ${name}, failed${r.elapsed ? ` after ${r.elapsed}` : ''}.`,
        stopped: `The team's last run, ${name}, was stopped${r.elapsed ? ` after ${r.elapsed}` : ''}.`,
      };
  if (!r.status) return thai ? `สถานะทีม: ${gist(result, 300)}` : `Team status: ${gist(result, 300)}`;
  const lines = [head[r.status]];
  if (r.steps.length) lines.push(r.steps.map((s) => `- ${s.name}: ${stateText(s.state, thai)}`).join('\n'));
  const live = r.status === 'running' || r.status === 'waiting';
  if (r.latest && !live) lines.push(`${r.latest.who}: “${excerpt(r.latest.text)}”`);
  if (live) lines.push(thai ? 'ทีมเสร็จเมื่อไหร่จะบอกนะคะ ระหว่างนี้ถามอะไรก็ได้ค่ะ' : "I'll tell you when they finish — ask me anything meanwhile.");
  else if (r.folder && r.status === 'completed') lines.push(thai ? `ไฟล์ที่เปลี่ยนดูได้ในแท็บ Changes ค่ะ (บันทึกของแต่ละขั้นตอน: \`${r.folder}\`)` : `What changed is in the Changes tab (each step's notes: \`${r.folder}\`).`);
  else if (r.folder) lines.push(thai ? `บันทึกของแต่ละขั้นตอนอยู่ใน \`${r.folder}\` ค่ะ` : `Each step's notes are in \`${r.folder}\`.`);
  return lines.join('\n\n');
}

export function stoppedReply(result: string, thai: boolean): string {
  const first = result.trim().split('\n')[0] ?? '';
  if (/no team run/i.test(first)) return thai ? 'ตอนนี้ทีมไม่ได้ทำงานอะไรอยู่ค่ะ ไม่มีอะไรต้องหยุด' : "The team isn't running anything right now — nothing to stop.";
  if (!/^Stopped\b/i.test(first)) return thai ? `หยุดทีมไม่ได้ค่ะ: ${gist(first, 200)}` : `I couldn't stop the team: ${gist(first, 200)}`;
  const name = first.match(/“([^”]+)”/)?.[1];
  if (thai) return `หยุดทีม${name ? ` (**${name}**)` : ''}แล้วค่ะ ไฟล์ที่ทีมแก้ไปแล้วยังอยู่เหมือนเดิม — ถ้าอยากย้อนกลับ ทำได้ในแท็บ Workflow ค่ะ`;
  return `Stopped the team${name ? ` (**${name}**)` : ''}. Files they already changed stay as they are — you can revert the run in the Workflow tab.`;
}

/** Where a finished run's work is: the changed files first (a chapter, the Changes tab), not the run's notes folder. */
function resultWhere(kind: ProjectKind, thai: boolean): string {
  if (kind === 'novel') return thai ? 'บทใหม่อยู่ในโฟลเดอร์ `chapters/` ค่ะ ลองอ่านดูก่อนนะคะ' : 'The new chapter is in `chapters/` — have a read before we go on.';
  if (kind === 'code') return thai ? 'ไฟล์ที่เปลี่ยนดูได้ในแท็บ Changes ค่ะ ลองดูแล้วรันเทสต์ก่อนทำต่อนะคะ' : 'The changed files are in the Changes tab — worth a look and a test run before you build on it.';
  return thai ? 'ไฟล์ที่เปลี่ยนดูได้ในแท็บ Changes ค่ะ ลองอ่านดูก่อนนะคะ' : 'The changed files are in the Changes tab — have a read before we go on.';
}

/** RLT's "[RLT team update] …" message → a few lines for the user: what the team did, where it is, what to check. */
export function updateReply(text: string, thai: boolean, kind: ProjectKind = 'code'): string {
  const r = parseRunReport(text);
  const name = r.name ? `**${r.name}**` : thai ? 'งานของทีม' : 'the run';
  const steps = stepsInline(r, thai);
  const said = r.latest ? `\n\n${r.latest.who}: “${excerpt(r.latest.text)}”` : '';
  // where a failed run can carry on from (team_continue): its first step that didn't finish
  const next = r.steps.find((s) => !/^done\b/i.test(s.state))?.name;
  if (thai) {
    switch (r.status) {
      case 'completed':
        return `ทีมทำ ${name} เสร็จแล้วค่ะ${r.elapsed ? ` (ใช้เวลา ${r.elapsed}${r.cost ? `, ${simCost(r.cost, true)}` : ''})` : ''}${steps ? ` — ${steps}` : ''}${said}\n\n${resultWhere(kind, true)}${r.folder ? `\n\n(บันทึกของแต่ละขั้นตอน: กด Open run ในแท็บ Workflow หรือดูใน \`${r.folder}\`)` : ''}`;
      case 'failed':
        return `รอบนี้ทีมทำ ${name} ไม่สำเร็จค่ะ${r.elapsed ? ` (หลัง ${r.elapsed})` : ''}${steps ? ` — ${steps}` : ''}${said}\n\n${r.folder ? `รายละเอียดอยู่ใน \`${r.folder}\` ` : ''}ให้ช่วยดูว่าติดตรงไหน${next ? ` หรือให้ทีมทำต่อจาก ${next} (ขั้นก่อนหน้าใช้ผลเดิม)` : ' หรือเริ่มทีมใหม่อีกรอบ'}ดีคะ?`;
      case 'stopped':
        return `ทีมหยุดทำ ${name} แล้วค่ะ${steps ? ` — ${steps}` : ''} ไฟล์ที่ทีมแก้ไปแล้วยังอยู่เหมือนเดิม ถ้าอยากย้อนกลับ ทำได้ในแท็บ Workflow ค่ะ`;
      default:
        return `อัปเดตจากทีมค่ะ: ${gist(text.replace(UPDATE, '').replace(/\s*Tell the user[^\n]*$/i, ''), 300)}`;
    }
  }
  switch (r.status) {
    case 'completed':
      return `The team finished ${name}${r.elapsed ? ` in ${r.elapsed}` : ''}${r.cost ? ` (${simCost(r.cost, false)})` : ''}${steps ? ` — ${steps}` : ''}.${said}\n\n${resultWhere(kind, false)}${r.folder ? `\n\n(Each step's notes: Open run in the Workflow tab, or \`${r.folder}\`.)` : ''}`;
    case 'failed':
      return `The team's run ${name} failed${r.elapsed ? ` after ${r.elapsed}` : ''}${steps ? ` — ${steps}` : ''}.${said}\n\n${r.folder ? `Details are in \`${r.folder}\`. ` : ''}Want me to look into what went wrong, or ${next ? `carry on from ${next} (the steps before it keep their results)` : 'start the team again'}?`;
    case 'stopped':
      return `The team's run ${name} was stopped${r.elapsed ? ` after ${r.elapsed}` : ''}${steps ? ` — ${steps}` : ''}. Files they already changed stay as they are; you can revert the run in the Workflow tab.`;
    default:
      return `Team update: ${gist(text.replace(UPDATE, '').replace(/\s*Tell the user[^\n]*$/i, ''), 300)}`;
  }
}

// ───────────────────────── turns ─────────────────────────

function startSteps(thai: boolean): Step[] {
  return [
    {
      name: 'team-start',
      plan(ctx) {
        const task = teamTask(ctx.conv.userText, earlierAsk(ctx.conv));
        if (!task) return { text: thai ? 'ได้เลยค่ะ — จะให้ทีมทำอะไรดีคะ?' : 'Sure — what should the team work on?' };
        return {
          thinking: `"${gist(ctx.conv.userText)}" — that's work for the whole team, not something to squeeze into this chat. I'll hand it over with team_start and stay free to talk.`,
          calls: [{ name: 'team_start', args: { i: 'start the team', task } }],
        };
      },
    },
    { name: 'team-started', plan: (ctx) => ({ text: startedReply(ctx.result('team-start'), thai) }) },
  ];
}

function statusSteps(thai: boolean): Step[] {
  return [
    { name: 'team-check', plan: () => ({ thinking: 'They want to know how the team is doing — team_status has the live picture.', calls: [{ name: 'team_status', args: { i: 'check on the team' } }] }) },
    { name: 'team-report', plan: (ctx) => ({ thinking: 'Keep it short: where the run is and who is doing what.', text: statusReply(ctx.result('team-check'), thai) }) },
  ];
}

/** Which step a "redo only part of it" ask means, from team_status's steps: a step it names (the earliest), a review
 *  when it talks about reviewing, the last step for "the later / last part", else the first step that didn't finish
 *  (else the last). */
export function pickFromStep(steps: RunReport['steps'], ask: string): { name: string; id?: string } | null {
  if (!steps.length) return null;
  const named = namedStep(steps, ask);
  if (named) return named;
  const reviews = steps.filter((s) => /\((?:approve|revise)\)/.test(s.state));
  if (reviews.length && /\b(?:review|check|verify)|ตรวจ|รีวิว/i.test(ask)) return reviews.at(-1)!;
  if (/\b(?:later|last|final|end|rest)\b|หลัง|ท้าย/i.test(ask)) return steps.at(-1)!;
  return steps.find((s) => !/^done\b/i.test(s.state)) ?? steps.at(-1)!;
}

/** The earliest step the ask names, by id or name (whole words; Thai names anywhere). */
function namedStep<T extends { name: string; id?: string }>(steps: T[], ask: string): T | null {
  const t = ask.toLowerCase();
  const mentions = (word: string | undefined) => {
    if (!word) return false;
    const w = word.toLowerCase();
    if (!/^[\w\s-]+$/.test(w)) return t.includes(w); // Thai names: no word boundaries
    return new RegExp(`(?<![\\w-])${w.replace(/[-\s]+/g, '[-\\s]+')}(?![\\w-])`, 'i').test(t);
  };
  return steps.find((s) => mentions(s.id) || mentions(s.name)) ?? null;
}

function continueSteps(thai: boolean): Step[] {
  return [
    {
      name: 'team-look',
      plan: (ctx) => ({
        thinking: `"${gist(ctx.conv.userText)}" — only part of the team's work should be redone, not the whole run. team_status shows each step's id and how it ended.`,
        calls: [{ name: 'team_status', args: { i: "check the team's last run" } }],
      }),
    },
    {
      name: 'team-redo',
      plan(ctx) {
        const status = ctx.result('team-look');
        if (/no team runs? yet/i.test(status) || !status.trim()) return { text: statusReply(status, thai) };
        const r = parseRunReport(status);
        const from = pickFromStep(r.steps, ctx.conv.userText);
        if (!from) return { text: statusReply(status, thai) };
        const note = tidy(ctx.conv.userText);
        return {
          thinking: `I'll continue that run from ${from.name}: the steps before it keep their results, and the files stay as they are.`,
          calls: [{ name: 'team_continue', args: { i: `continue from ${from.name}`, from_step: from.id ?? from.name, ...(r.runId ? { run_id: r.runId } : {}), ...(note ? { note } : {}) } }],
        };
      },
    },
    { name: 'team-redone', plan: (ctx) => ({ text: startedReply(ctx.result('team-redo'), thai) }) },
  ];
}

// ───────────────────────── team_edit ─────────────────────────

/** A step as team_status plan: true shows it ("### Editor [editor] — openai/gpt-6.1-sol, …" and its persona). */
interface PlanStep {
  name: string;
  id: string;
  model: string;
  persona: string;
}

function planSteps(status: string): PlanStep[] {
  return [...status.matchAll(/^### (.+?) \[([\w-]+)\] — (\S+?)(?:,|$)[^\n]*\n(?:Persona: ([^\n]*))?/gm)].map(([, name, id, model, persona]) => ({ name: name!, id: id!, model: model!, persona: persona ?? '' }));
}

// what a step does, for asks that say it instead of its name ("the polish", "การเกลาคำ")
const ROLE_WORDS: [RegExp, RegExp][] = [
  [/polish|เกลา|ขัดเกลา|เกลาคำ/i, /polish|edit/i],
  [/\b(?:review|check)|ตรวจ|รีวิว/i, /review|check/i],
  [/\bwrit|เขียน/i, /writ/i],
  [/\bidea|ไอเดีย|คิดเรื่อง|พล็อต/i, /idea|pitch/i],
];

/** Which step a change means: one it names, else one whose job it describes (pending steps first). */
function editTarget(ask: string, steps: RunReport['steps'], plan: PlanStep[]): { name: string; id: string } | null {
  const named = namedStep(plan, ask) ?? namedStep(steps, ask);
  if (named?.id) return { name: named.name, id: named.id };
  for (const [said, does] of ROLE_WORDS) {
    if (!said.test(ask)) continue;
    const hit = plan.find((s) => does.test(`${s.name} ${s.id} ${s.persona}`)) ?? steps.find((s) => does.test(`${s.name} ${s.id ?? ''}`));
    if (hit?.id) return { name: hit.name, id: hit.id };
  }
  return null;
}

/** What the user wants said in the step's prompt: the part after "…: ", " — ", "so (that)", "to say", or Thai ให้. */
function wishOf(ask: string): string {
  const t = tidy(ask);
  const m = t.match(/(?:[:：]\s*|\s[—–-]\s|\bso (?:that )?|\bto say\b\s*|(?:prompt|promt|พรอมต์|คำสั่ง|persona).{0,40}?ให้(?=\S))(.{4,})$/i);
  return (m?.[1] ?? t).trim();
}

const capital = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** The new person an "add …" ask means: their name and the step they come after (none: at the end). */
function addedPerson(ask: string): { name: string; after: string } | null {
  const en = ask.match(/\b(?:add|insert|put in)\s+(?:a|an|one|another|one more|a new|an extra)\s+((?:[\w-]+\s+){0,2}?)(step|person|member|reviewer|proofreader|editor|checker|fact-?checker)\b/i);
  if (en) {
    const lead = (en[1] ?? '').trim();
    const word = en[2]!.toLowerCase();
    const called = ask.match(/\b(?:called|named)\s+["“]?([\w -]{2,30}?)["”]?(?=[,.;]|\s+(?:after|before|who|that|to)\b|$)/i)?.[1];
    const name = called ?? (/^(?:step|person|member)$/.test(word) ? lead.replace(/ing$/, 'er') || 'Checker' : `${lead ? `${lead} ` : ''}${word}`);
    return { name: capital(name.trim()), after: ask.match(/\b(?:after|following)\s+(?:the\s+)?([^\s,.;]+(?:\s+step)?)/i)?.[1] ?? '' };
  }
  const th = ask.match(/เพิ่ม\s*(?:step|สเต็ป|ขั้น(?:ตอน)?|คน)\s*(?:ใหม่\s*)?(?:ที่|สำหรับ)?\s*(.+?)(?=\s|ต่อจาก|ต่อท้าย|หลังจาก|หลัง|ก่อน|ตอนท้าย|ท้ายสุด|ให้|$)/);
  if (th?.[1]) return { name: th[1].trim().slice(0, 40), after: ask.match(/(?:ต่อจาก|หลังจาก|หลัง)\s*(?:ขั้น(?:ตอน)?|step)?\s*(\S+)/)?.[1] ?? '' };
  return null;
}

/** team_edit's ops for the ask, from team_status (plan: true): a person added, a step taken out, or a paragraph
 *  added to one step's prompt. null: it doesn't say which step. */
export function editOps(ask: string, status: string): Record<string, unknown>[] | null {
  const r = parseRunReport(status);
  const plan = planSteps(status);
  const t = ask.trim();
  const add = EN_EDIT_ADD.test(t) || /เพิ่ม\s*(?:step|สเต็ป|ขั้น(?:ตอน)?|คน)/.test(t) ? addedPerson(t) : null;
  if (add) {
    const after = add.after ? editTarget(add.after, r.steps, plan) : null;
    const model = plan.find((s) => s.id === after?.id)?.model ?? plan.at(-1)?.model ?? 'anthropic/claude-sonnet-5-5';
    const thai = hasThai(t);
    const persona = thai ? `คุณคือ${add.name} ${tidy(t)}` : `You are the ${add.name}. ${capital(wishOf(t))}`;
    return [{ op: 'add', ...(after ? { after: after.id } : {}), person: { name: add.name, model, persona: persona.slice(0, 600) } }];
  }
  const target = editTarget(t, r.steps, plan);
  if (!target) return null;
  if (EN_EDIT_REMOVE.test(t) || /(?:ลบ|ตัด)\s*(?:ขั้น(?:ตอน)?|step|สเต็ป)/.test(t)) return [{ op: 'remove', step: target.id }];
  return [{ op: 'update', step: target.id, add_to_instruction: `From the user: ${wishOf(t)}` }];
}

const TH_KEEPS: [RegExp, string][] = [
  [/ keeps its result| keep their results/g, ' ใช้ผลเดิม'],
  [/ keeps? working \(not restarted\)/g, ' ทำต่อ (ไม่ต้องเริ่มใหม่)'],
  [/ starts? as planned/g, ' เริ่มตามแผน'],
  [/, | and /g, ', '],
];

function thaiChange(line: string): string {
  return line
    .replace(/^- (.+?): (?:instruction|persona|model|effort)[^.]*\.$/, '- $1: แก้แล้ว')
    .replace(/^- Added (.+?) \[[\w-]+\] after (.+?) \(.*$/, '- เพิ่ม $1 ต่อจาก $2')
    .replace(/^- Added (.+?) \[[\w-]+\] first \(.*$/, '- เพิ่ม $1 เป็นขั้นแรก')
    .replace(/^- Removed (.+?)(?: \[[\w-]+\])?\b.*$/, '- เอา $1 ออก')
    .replace(/^- Note sent to (.+?) \(.*$/, '- ส่งโน้ตถึง $1 แล้ว (อ่านตอนขั้นถัดไปของเขา)');
}

/** team_edit's result → a few lines: what changed while the team keeps going, or why it wasn't changed. */
export function editedReply(result: string, thai: boolean): string {
  const lines = result.trim().split('\n');
  const first = lines[0] ?? '';
  const ok = first.match(/^Changed “([^”]+)” while it runs \(run [\w-]+\) — it keeps going: (.+?)\.$/);
  if (ok) {
    const changes = lines.filter((l) => /^- /.test(l));
    const next = lines.find((l) => l.startsWith('Next: '))?.slice(6).replace(/\.$/, '');
    const saved = lines.find((l) => l.startsWith('Also saved to the workflow'));
    if (thai) {
      const keeps = TH_KEEPS.reduce((s, [re, to]) => s.replace(re, to), ok[2]!);
      return [
        `แก้ทีมแล้วค่ะ ทีมทำต่อโดยไม่ต้องเริ่มใหม่ — ${keeps}`,
        changes.map(thaiChange).join('\n'),
        next ? `ต่อไป: ${next}` : '',
        saved ? 'บันทึกลง workflow ไว้ใช้ครั้งหน้าด้วยแล้วค่ะ' : 'แก้เฉพาะรอบนี้นะคะ workflow ที่บันทึกไว้ยังเหมือนเดิม — ถ้าอยากให้ครั้งหน้าใช้แบบนี้ด้วยบอกได้ค่ะ',
      ].filter(Boolean).join('\n\n');
    }
    return [
      `Done — the team keeps going: ${ok[2]}.`,
      changes.join('\n'),
      next ? `Next: ${next}.` : '',
      saved ? 'Also saved to the workflow for next time.' : "This run only — the saved workflow stays as it was. Say if you want it for next time too.",
    ].filter(Boolean).join('\n\n');
  }
  const done = first.match(/^“([^”]+)” already finished in this run/);
  if (done) {
    return thai
      ? `**${done[1]}** ทำเสร็จไปแล้วค่ะ ถ้าจะแก้ต้องทำขั้นนั้นกับขั้นหลังจากนั้นใหม่ — ให้ทำใหม่ตั้งแต่ ${done[1]} ไหมคะ? ระหว่างนี้ทีมทำต่อตามเดิมค่ะ`
      : `**${done[1]}** already finished, so changing it means redoing it and the steps after it. Want me to redo from ${done[1]}? Until you say, the team keeps going as it is.`;
  }
  const working = first.match(/^“([^”]+)” is working now/);
  if (working) {
    return thai
      ? `**${working[1]}** กำลังทำขั้นนี้อยู่ค่ะ ไม่ขัดจังหวะนะคะ — ส่งโน้ตให้ได้ (อ่านตอนขั้นถัดไปของเขา) หรือให้เริ่มขั้นนี้ใหม่พร้อมสิ่งที่แก้ก็ได้ค่ะ เอาแบบไหนดีคะ?`
      : `**${working[1]}** is working on that right now — I won't interrupt them. I can send them a note (they read it at their next step), or redo their step from the start with the change. Which would you like?`;
  }
  if (/^No team is running/i.test(first)) return notRunningReply(thai);
  return thai ? `แก้ทีมไม่ได้ค่ะ: ${gist(first, 200)}` : `I couldn't change the team: ${gist(first, 200)}`;
}

function notRunningReply(thai: boolean): string {
  return thai
    ? 'ตอนนี้ทีมไม่ได้ทำงานอยู่ค่ะ — จะแก้ workflow ไว้ใช้ครั้งหน้าก็ได้ (แท็บ Workflow) หรือให้ทีมทำใหม่บางส่วนก็บอกได้เลยค่ะ'
    : "The team isn't running right now — I can change the workflow for next time (the Workflow tab), or redo part of the last run with the change.";
}

function teamEditSteps(thai: boolean): Step[] {
  return [
    {
      name: 'team-plan',
      plan: (ctx) => ({
        thinking: `"${gist(ctx.conv.userText)}" — a change to the team's later steps while it runs. team_status shows which steps haven't started; team_edit changes those without stopping anyone.`,
        calls: [{ name: 'team_status', args: { i: "see the team's next steps", plan: true } }],
      }),
    },
    {
      name: 'team-change',
      plan(ctx) {
        const status = ctx.result('team-plan');
        const r = parseRunReport(status);
        if (r.status !== 'running' && r.status !== 'waiting') return { text: notRunningReply(thai) };
        const ops = editOps(ctx.conv.userText, status);
        if (!ops) {
          const names = r.steps.map((s) => s.name).join(', ');
          return { text: thai ? `จะให้แก้ขั้นไหนคะ? (${names})` : `Which step should change? (${names})` };
        }
        return {
          thinking: 'Finished steps keep their results and nobody working is interrupted — team_edit applies this to the steps that are still ahead.',
          calls: [{ name: 'team_edit', args: { i: "change the team's next steps", ops } }],
        };
      },
    },
    { name: 'team-changed', plan: (ctx) => ({ text: editedReply(ctx.result('team-change'), thai) }) },
  ];
}

function stopSteps(thai: boolean): Step[] {
  return [
    { name: 'team-halt', plan: () => ({ thinking: 'The user wants the team stopped — team_stop.', calls: [{ name: 'team_stop', args: { i: 'stop the team' } }] }) },
    { name: 'team-halted', plan: (ctx) => ({ text: stoppedReply(ctx.result('team-halt'), thai) }) },
  ];
}

export function teamTurn(ctx: Ctx, intent: TeamIntent): TurnPlan {
  const thai = thaiChat(ctx.conv);
  switch (intent) {
    case 'team-update':
      return {
        thinking: 'CAST says the team run ended. Sum it up for the user in a few lines and point at the results.',
        text: updateReply(ctx.conv.userText, thai, viewProject(ctx.cwd).kind),
      };
    case 'team-status':
      return runScript(ctx, statusSteps(thai), 'Done.');
    case 'team-stop':
      return runScript(ctx, stopSteps(thai), 'Done.');
    case 'team-run':
      return runScript(ctx, startSteps(thai), 'Done.');
    case 'team-continue':
      return runScript(ctx, continueSteps(thai), 'Done.');
    case 'team-edit':
      return runScript(ctx, teamEditSteps(thai), 'Done.');
  }
}
