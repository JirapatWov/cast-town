// The house Assistant: explains the project, makes small changes, and splits bigger asks between two helpers
// (the `task` tool → real omp subagents, which the mock also serves — see helper.ts). As a job's lead it also
// runs the job's team through RLT's team_start / team_status / team_stop tools (see team.ts), designs teams
// with workflow_save (see workflow-design.ts), and — when the job's work style lets it decide — hands staged
// asks to a team on its own (see auto.ts).
import { codeFindings, fileNote, fileNoteTh, overview, overviewTh, viewProject, type ProjectView } from './describe';
import { appendSection, changedThisTurn, editSteps, type EditTarget } from './edit-steps';
import { hasThai } from './project-scan';
import { autoTurn, isAutoAsk, workStyleOf, type AutoIntent } from './auto';
import { gist, read, runScript, type Ctx, type Step, type TurnPlan } from './script';
import { isTeamIntent, teamIntent, teamTurn, type TeamIntent } from './team';
import { isTodoAsk, isTodoSeed, todoFeaturesFor, todoPatches, todoState } from './todo-patch';
import { isWorkflowIntent, previousAsk, workflowFollowUp, workflowIntent, workflowTurn, type WorkflowIntent } from './workflow-design';

export type AssistantIntent = TeamIntent | WorkflowIntent | AutoIntent | 'helpers' | 'change' | 'explain';

const HELPERS = /\b(parallel|helpers?|sub-?agents?|delegate|split (it|this|the work)|two (people|agents|reviewers|helpers))\b|ผู้ช่วย|ช่วยกัน|แบ่งงาน/i;
// Without the lead's team tools (a team role chatting outside a run), "team" still means two helpers.
const TEAM_WORD = /\bteam\b/i;
const LEAD = /^(?:(?:please|pls|ok|okay|now|then|hey|can you|could you|would you|will you|let's|lets|go ahead and|i want you to|i'd like you to)[\s,]+)*/i;
const CHANGE_VERB = /^(add|change|fix|implement|create|write|update|rename|refactor|remove|delete|make|build|edit|improve|support|handle|validate|เพิ่ม|แก้|เขียน|สร้าง|ลบ|ปรับ)/i;

/** `earlier` is the user's previous ask: after a design ask without steps, a bare "A → B → C" is its steps.
 *  `style` is the job's work style (`[rlt-work-style:…]`): with 'ask' / 'auto' the lead picks a team for staged asks
 *  itself; 'solo' (and personas without it) keep the routes below. */
export function classifyAsk(text: string, tools: ReadonlySet<string> = new Set(), earlier = '', style: string | null = null): AssistantIntent {
  // First: "create a workflow: A → B" would otherwise read as a change (create), helpers (ผู้ช่วย) or a team ask.
  const design = workflowIntent(text, tools);
  if (design) return design;
  const team = teamIntent(text, tools);
  if (team) return team;
  if (workflowFollowUp(text, tools, earlier)) return 'workflow-design';
  if ((style === 'ask' || style === 'auto') && tools.has('team_start') && tools.has('workflow_list') && isAutoAsk(text)) return 'auto-team';
  if (HELPERS.test(text) || (!tools.has('team_start') && TEAM_WORD.test(text)) || text.length > 700) return 'helpers';
  const stripped = text.trim().replace(LEAD, '');
  if (CHANGE_VERB.test(stripped)) return 'change';
  return 'explain';
}

export function assistantTurn(ctx: Ctx): TurnPlan {
  if (ctx.conv.isWake) return wakeTurn(ctx);
  const ask = ctx.conv.userText;
  const intent = classifyAsk(ask, ctx.conv.tools, previousAsk(ctx.conv), workStyleOf(ctx.conv.system));
  if (intent === 'auto-team') return autoTurn(ctx);
  if (isWorkflowIntent(intent)) return workflowTurn(ctx, intent);
  if (isTeamIntent(intent)) return teamTurn(ctx, intent);
  const v = viewProject(ctx.cwd);
  if (intent === 'helpers' && ctx.conv.tools.has('task') && v.kind !== 'empty') return runScript(ctx, teamSteps(v), 'Both helpers are on it.');
  const thai = hasThai(ask);
  if (intent === 'change' && (ctx.conv.tools.has('edit') || ctx.conv.tools.has('write'))) return runScript(ctx, changeSteps(v), thai ? 'เรียบร้อยค่ะ' : 'Done.');
  return runScript(ctx, explainSteps(v), thai ? overviewTh(v) : overview(v));
}

// ───────────────────────── explain ─────────────────────────

/** Project files the ask names explicitly ("what does server.ts do?"). */
function mentionedFiles(v: ProjectView, ask: string): string[] {
  const lower = ask.toLowerCase();
  return v.files
    .map((f) => f.path)
    .filter((p) => lower.includes(p.toLowerCase()) || lower.includes((p.split('/').at(-1) ?? p).toLowerCase()))
    .slice(0, 3);
}

function explainSteps(v: ProjectView): Step[] {
  return [
    {
      name: 'survey',
      plan: (ctx) =>
        v.kind === 'empty'
          ? null
          : {
              thinking: hasThai(ctx.conv.userText)
                ? `ผู้ใช้ถามว่า "${gist(ctx.conv.userText)}" — ดูภาพรวมก่อน: รายชื่อไฟล์ แล้วค่อยอ่านไฟล์ที่สำคัญ`
                : `The user asks: "${gist(ctx.conv.userText)}". I'll get the lay of the land first — the file tree, then the files that matter.`,
              calls: [read('.', 'list the project')],
            },
    },
    {
      name: 'read',
      plan(ctx) {
        const named = mentionedFiles(v, ctx.conv.userText);
        const paths = named.length ? named : [...(v.readme !== null ? ['README.md'] : []), ...v.keyFiles].slice(0, 3);
        if (!paths.length) return null;
        const list = (ps: string[]) => ps.map((p) => `\`${p}\``).join(', ');
        const why = hasThai(ctx.conv.userText)
          ? named.length
            ? `ถามถึง ${list(named)} — อ่านไฟล์นั้นตรง ๆ เลย`
            : `มี ${v.files.length} ไฟล์ จะอ่าน ${list(paths)} — น่าจะพอสำหรับอธิบาย`
          : named.length
            ? `They're asking about ${list(named)} — reading it directly.`
            : `${v.files.length} files. I'll read ${list(paths)} — that should be enough to explain it.`;
        return { thinking: why, calls: paths.map((p) => read(p)) };
      },
    },
    {
      name: 'answer',
      plan(ctx) {
        const named = mentionedFiles(v, ctx.conv.userText);
        // Asked in Thai → answered in Thai, start to end (file contents and code facts stay as they are written).
        const thai = hasThai(ctx.conv.userText);
        const note = thai ? fileNoteTh : fileNote;
        const body = named.length ? named.map((p) => [`- ${note(v.cwd, p)}`, ...codeFindingsFor(v, p)].join('\n')).join('\n\n') : thai ? overviewTh(v) : overview(v);
        return thai
          ? { thinking: 'ได้ข้อมูลพอแล้ว ตอบสั้น ๆ และอ้างถึงไฟล์จริง', text: `สรุปให้ค่ะ\n\n${body}${nextHintTh(v)}` }
          : { thinking: 'I have what I need. Keep it short and point at real files.', text: `${body}${nextHint(v)}` };
      },
    },
  ];
}

function codeFindingsFor(v: ProjectView, path: string): string[] {
  if (v.kind !== 'code' || !/\.(ts|js|tsx|jsx|py|go|rs)$/.test(path)) return [];
  return codeFindings(v.cwd, path).slice(0, 4).map((f) => `  - ${f}`);
}

function nextHint(v: ProjectView): string {
  if (v.kind === 'code' && isTodoSeed(v.cwd)) {
    const s = todoState(v.cwd);
    if (!s.hasDone) return '\n\nA good first change: the missing `PATCH /todos/:id/done` (with a test). Ask me, or run the **Decode → Implement → Review** workflow to have the team do it.';
    if (!s.hasValidation) return '\n\nStill open: input validation on `POST /todos` — happy to add it.';
    return '\n\nBoth known gaps are fixed now — `bun test` should be green.';
  }
  if (v.kind === 'novel') {
    const next = v.readme?.match(/^- \[ \]\s+(.+)$/m)?.[1];
    return next ? `\n\nNext up per the README: ${next.replace(/\*\*/g, '')}. The **Idea → Write → Edit** workflow can draft it.` : '';
  }
  return '';
}

function nextHintTh(v: ProjectView): string {
  if (v.kind === 'code' && isTodoSeed(v.cwd)) {
    const s = todoState(v.cwd);
    if (!s.hasDone) return '\n\nงานแรกที่น่าทำ: เพิ่ม `PATCH /todos/:id/done` ที่ยังขาด (พร้อมเทสต์) — สั่งได้เลยค่ะ หรือรัน workflow **Decode → Implement → Review** ให้ทีมทำก็ได้';
    if (!s.hasValidation) return '\n\nที่ยังค้าง: ตรวจข้อมูลที่ส่งเข้า `POST /todos` — ให้เพิ่มให้ได้เลยค่ะ';
    return '\n\nช่องโหว่ที่รู้ทั้งสองข้อแก้แล้วค่ะ — `bun test` น่าจะผ่านหมด';
  }
  if (v.kind === 'novel') {
    const next = v.readme?.match(/^- \[ \]\s+(.+)$/m)?.[1];
    return next ? `\n\nตาม README งานถัดไปคือ: ${next.replace(/\*\*/g, '')} — workflow **Idea → Write → Edit** ช่วยร่างให้ได้ค่ะ` : '';
  }
  return '';
}

// ───────────────────────── change ─────────────────────────

function changeTargets(v: ProjectView, ask: string): EditTarget[] {
  if (v.kind === 'code' && isTodoSeed(v.cwd) && isTodoAsk(ask)) {
    return todoPatches(v.cwd, todoFeaturesFor(ask)).map((p) => ({ path: p.path, what: p.what, edit: p.edit }));
  }
  // The offline demo model can't write arbitrary code; it records the request where people will see it.
  const path = v.readme !== null ? 'README.md' : 'NOTES.md';
  const heading = v.readme?.includes('\n## Notes') ? [] : ['## Notes', ''];
  // (the line in the answer's list says it in the ask's language, like the rest of the answer)
  const what = hasThai(ask) ? 'จดคำขอไว้ใต้หัวข้อ "Notes"' : 'recorded the request under "Notes"';
  return [appendSection(v.cwd, path, [...heading, `- [ ] ${gist(ask, 160)} *(noted by the demo Assistant)*`], what)];
}

function changeSteps(v: ProjectView): Step[] {
  let cached: { ask: string; targets: EditTarget[] } | null = null;
  const targets = (ctx: Ctx) => {
    // The edit steps call this several times per request; compute once per request.
    if (!cached || cached.ask !== ctx.conv.userText) cached = { ask: ctx.conv.userText, targets: changeTargets(v, ctx.conv.userText) };
    return cached.targets;
  };
  return [
    ...editSteps({
      targets,
      readThinking: (ctx, paths) =>
        hasThai(ctx.conv.userText)
          ? `ผู้ใช้อยากให้: "${gist(ctx.conv.userText)}" — อ่าน ${paths.map((p) => `\`${p}\``).join(', ') || 'ไฟล์'} ก่อนแตะอะไร`
          : `They want: "${gist(ctx.conv.userText)}". Before touching anything I'll read ${paths.map((p) => `\`${p}\``).join(', ') || 'the files'}.`,
      editThinking: (ctx, ts) =>
        hasThai(ctx.conv.userText)
          ? `แผน: ${ts.map((t) => `${t.path} (${t.what.replace(/`/g, '')})`).join('; ')} — แก้ทีละนิดให้เข้ากับของเดิม`
          : `Plan: ${ts.map((t) => `${t.path} (${t.what.replace(/`/g, '')})`).join('; ')}. Small, focused edits that match the existing style.`,
    }),
    {
      name: 'answer',
      plan(ctx) {
        const changed = changedThisTurn(ctx);
        const thai = hasThai(ctx.conv.userText);
        if (!changed.length) {
          if (thai) return { text: `ไม่มีอะไรต้องแก้ค่ะ — ${isTodoSeed(v.cwd) ? 'ส่วนนั้นมีอยู่แล้ว `bun test` น่าจะผ่าน' : 'ไฟล์เป็นแบบที่ต้องการอยู่แล้ว'}` };
          return { text: `Nothing needed changing — ${isTodoSeed(v.cwd) ? 'that is already in place. `bun test` should pass.' : 'the files already look right.'}` };
        }
        const list = changed.map((c) => `- \`${c.path}\` — ${c.what}`).join('\n');
        if (isTodoSeed(v.cwd) && isTodoAsk(ctx.conv.userText)) {
          if (thai) return { text: `เรียบร้อยค่ะ แก้ ${changed.length} ไฟล์:\n\n${list}\n\nรัน \`bun test\` เพื่อเช็กได้เลย — \`test.todo\` สองตัวกลายเป็นเทสต์จริงแล้ว` };
          return { text: `Done. Changed ${changed.length} file${changed.length === 1 ? '' : 's'}:\n\n${list}\n\nRun \`bun test\` to check — the two \`test.todo\` placeholders are real tests now.` };
        }
        // Not only code: a novel or notes folder gets the same honest answer, in words that fit it.
        if (thai)
          return {
            text: `ตอนนี้เป็นโมเดล **demo** แบบออฟไลน์ค่ะ เลยทำการแก้จริงตามคำขอแบบนี้ไม่ได้ — จดคำขอไว้ให้แทน:\n\n${list}\n\nเชื่อมต่อผู้ให้บริการ AI ใน **Models & providers** แล้วจะแก้ให้จริงค่ะ`,
          };
        return {
          text: `I'm the offline **demo** model, so I can't make real changes for an arbitrary request — I noted it instead:\n\n${list}\n\nConnect a provider in **Models & providers** and I'll make the real change.`,
        };
      },
    },
  ];
}

// ───────────────────────── team (two helpers) ─────────────────────────

interface HelperTask {
  name: string;
  task: string;
  solutionSpace: string;
}

function helperTasks(v: ProjectView, ask: string): HelperTask[] {
  const files = v.keyFiles;
  const base = (p: string) => (p.split('/').at(-1) ?? p).replace(/\.(test|spec)\./, '-test.').replace(/\.\w+$/, '');
  const pascal = (s: string) => s.replace(/(^|[-_.\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
  if (v.kind === 'novel') {
    return [
      { name: 'PlotCheck', task: `Read outline.md and characters.md and check them against each other: who appears where, open threads, contradictions. Ask: ${ask}`, solutionSpace: 'Read-only. Report 3–5 findings with file references.' },
      { name: 'ProseCheck', task: `Read style-guide.md and everything in chapters/ and check the prose against the guide (POV, tense, headers). Ask: ${ask}`, solutionSpace: 'Read-only. Report 3–5 findings with file references.' },
    ];
  }
  const a = files[0] ?? 'README.md';
  const rest = files.slice(1).length ? files.slice(1) : ['README.md'];
  return [
    {
      name: `${pascal(base(a))}Review`,
      task: `Review \`${a}\`: control flow, status codes, input handling, error paths. Ask: ${ask}`,
      solutionSpace: `Read-only review of ${a}. Report concrete findings with file:line references, most important first. Do not edit files.`,
    },
    {
      name: `${pascal(base(rest[0]))}Review`,
      task: `Review ${rest.map((p) => `\`${p}\``).join(' and ')}: data model, edge cases, and what the tests do and don't cover. Ask: ${ask}`,
      solutionSpace: `Read-only review of ${rest.join(', ')}. Report concrete findings with file:line references, most important first. Do not edit files.`,
    },
  ];
}

function teamSteps(v: ProjectView): Step[] {
  return [
    {
      name: 'delegate',
      plan(ctx) {
        const tasks = helperTasks(v, gist(ctx.conv.userText, 200));
        const split = tasks.map((t) => `- **${t.name}** — ${t.task.split('. Ask:')[0]}`).join('\n');
        return {
          thinking: `"${gist(ctx.conv.userText)}" — this splits cleanly into two independent reviews, so two helpers can work in parallel and I'll merge what they find.`,
          text: `I'll split this between two helpers working in parallel:\n\n${split}\n\n`,
          calls: [{ name: 'task', args: { i: 'two parallel reviews', context: `Project "${v.name}" at ${v.cwd}. ${gist(ctx.conv.userText, 200)}`, tasks } }],
        };
      },
    },
    {
      name: 'wait',
      plan(ctx) {
        const r = ctx.result('delegate');
        if (/<task-result|<output>/.test(r)) return { text: summarizeResults(r) };
        if (/denied|rejected/i.test(r.slice(0, 200))) return { text: "No helpers then — say the word and I'll do the review myself." };
        return { text: "Both helpers are on it — I'll summarize their findings when they report back." };
      },
    },
  ];
}

function wakeTurn(ctx: Ctx): TurnPlan {
  const { conv } = ctx;
  // omp wakes the parent once per finished helper; report progress until everyone is back, then merge.
  const all = conv.wakeTexts.join('\n');
  const back = taskResults(all);
  const expected = Math.max(conv.spawnedTasks, back.length);
  if (back.length < expected) {
    const latest = taskResults(conv.wakeText);
    const names = latest.map((r) => `**${r.name}**`).join(' and ') || 'A helper';
    return { text: `${names} ${latest.length > 1 ? 'are' : 'is'} back (${back.length} of ${expected}) — waiting for the rest before I sum up.` };
  }
  return { thinking: 'Everyone reported back. Merge their findings, most important first.', text: summarizeResults(back) };
}

interface TaskResult {
  name: string;
  output: string;
  failed: boolean;
}

/** `<task-result id=…><output>…</output></task-result>` blocks (one per finished helper). */
export function taskResults(raw: string): TaskResult[] {
  const byName = new Map<string, TaskResult>();
  for (const [, attrs, inner] of raw.matchAll(/<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g)) {
    const id = attrs.match(/\bid="([^"]+)"/)?.[1] ?? `Helper ${byName.size + 1}`;
    const name = id.replace(/^\d+-/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    const output = (inner.match(/<output>([\s\S]*?)<\/output>/)?.[1] ?? inner).trim();
    byName.set(name, { name, output, failed: /status="(failed|error|aborted|cancelled)"/.test(attrs) });
  }
  return [...byName.values()];
}

export function summarizeResults(results: TaskResult[] | string): string {
  const list = typeof results === 'string' ? taskResults(results) : results;
  if (!list.length) return 'The helpers finished, but sent nothing back I could use.';
  const parts = list.map((r) => {
    const bullets = r.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^([-*•]|\d+\.)\s/.test(l))
      .slice(0, 3);
    const body = r.failed ? '- _did not finish_' : bullets.length ? bullets.join('\n') : `- ${r.output.split('\n')[0]?.slice(0, 200) || '(no output)'}`;
    return `**${r.name}**\n${body}`;
  });
  const who = list.length === 2 ? 'Both helpers are' : list.length === 1 ? 'The helper is' : `All ${list.length} helpers are`;
  return `${who} back. Highlights:\n\n${parts.join('\n\n')}\n\nWant me to fix the top items?`;
}
