// Idea → Write → Edit on a novel project (Thai prose; tailored to the seeded "ร้านน้ำชาใต้แสงจันทร์").
import { editCall } from './edit-steps';
import { planEdit, type AnchorOp } from './hashline';
import { headings, listFiles, readText } from './project-scan';
import { gist, read, runScript, write, type Ctx, type Step, type TurnPlan } from './script';
import {
  chapterBody,
  chapterTitle,
  DEFAULT_CAST,
  EDITOR_FIXES,
  editorReply,
  ideasMarkdown,
  ideasReply,
  thaiWordEstimate,
  writerIntro,
  writerReply,
  type Cast,
} from './thai-content';
import { ackNote, feedbackOf, noteOf, runDirOf, taskOf } from './workflow-prompt';

const pad = (n: number) => String(n).padStart(2, '0');

function chapterNumbers(cwd: string): number[] {
  return listFiles(cwd)
    .map((f) => f.path.match(/^chapters\/chapter-(\d+)\.md$/)?.[1])
    .filter((x): x is string => !!x)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Cast from characters.md headings ("## น้ำค้าง — ตัวเอก"), falling back to the seed's names. */
function castOf(cwd: string): Cast {
  const names = headings(readText(cwd, 'characters.md') ?? '').map((h) => h.split(/\s+[—-]\s+/)[0].trim());
  if (names.length < 4) return DEFAULT_CAST;
  return { hero: names[0], grandma: names[1], neighbor: names[2], cat: names[3] };
}

const existing = (cwd: string, paths: string[]) => paths.filter((p) => readText(cwd, p) !== null);

/** The chapter number a brief asks for ("chapter 2", "บทที่ 2", "บท 2", "ch. 2"), or null. */
export function chapterAsked(text: string): number | null {
  const m = text.match(/(?:\bchapter|\bch\.?|บทที่|บท)\s*(\d{1,3})\b/i);
  return m ? Number(m[1]) : null;
}

/** When the brief asked for another chapter than the one written: why (in Thai, like the rest of the novel team). */
export function chapterMismatchNote(asked: number | null, written: number): string {
  if (asked === null || asked === written) return '';
  return asked > written
    ? `\n\n(ขอบทที่ ${asked} มา แต่ใน \`chapters/\` ยังไม่มีบทที่ ${written} เลยเขียนบทที่ ${written} ก่อนค่ะ — บทถัดไปค่อยเป็นบทที่ ${written + 1})`
    : `\n\n(ขอบทที่ ${asked} มา แต่บทที่ ${asked} มีอยู่แล้ว เลยเขียนบทใหม่ถัดไปเป็นบทที่ ${written} แทนค่ะ — ถ้าอยากให้แก้บทที่ ${asked} บอกได้เลย)`;
}

// ───────────────────────── Idea-maker ─────────────────────────

export function ideaMakerTurn(ctx: Ctx): TurnPlan {
  const runDir = runDirOf(ctx.conv.userText) ?? '.rlt';
  const task = taskOf(ctx.conv.userText);
  const cast = castOf(ctx.cwd);
  const file = `${runDir}/ideas.md`;
  const steps: Step[] = [
    {
      name: 'read',
      plan: () => {
        const paths = existing(ctx.cwd, ['README.md', 'outline.md', 'characters.md']);
        return paths.length ? { thinking: `Brief: "${gist(task)}". Re-reading the premise, the outline and the cast before pitching anything.`, calls: paths.map((p) => read(p)) } : null;
      },
    },
    {
      name: 'write',
      plan: () => ({
        thinking: `Outline chapter 1 is the arrival night: rain, the recipe book, the note about the lantern, a knock. Three directions — one on-outline, one from ${cast.neighbor}'s side (breaks the POV rule, so a later chapter), one built around ${cast.cat}. Recommend the first with a detail from the third.`,
        calls: [write(file, ideasMarkdown(task, cast), 'write three premises')],
      }),
    },
    { name: 'reply', plan: () => ({ text: ideasReply(file, cast) }) },
  ];
  return runScript(ctx, steps, ideasReply(file, cast));
}

// ───────────────────────── Writer ─────────────────────────

export function writerTurn(ctx: Ctx): TurnPlan {
  const runDir = runDirOf(ctx.conv.userText);
  const revising = feedbackOf(ctx.conv.userText) !== null;
  const nums = chapterNumbers(ctx.cwd);
  // A first pass writes the next free chapter; a revision rewrites the newest one (our own draft).
  const drafted = ctx.calls('draft')[0]?.args.path;
  const n = typeof drafted === 'string' ? Number(drafted.match(/(\d+)\.md$/)?.[1] ?? 1) : revising && nums.length ? nums[nums.length - 1] : (nums.at(-1) ?? 0) + 1;
  const path = typeof drafted === 'string' ? drafted : `chapters/chapter-${pad(n)}.md`;
  const cast = castOf(ctx.cwd);
  const mismatch = revising ? '' : chapterMismatchNote(chapterAsked(taskOf(ctx.conv.userText)), n);
  const reply = () => `${writerReply(path, n, thaiWordEstimate(chapterBody(cast)), cast)}${mismatch}`;
  const steps: Step[] = [
    {
      name: 'read',
      plan: () => {
        const paths = [...existing(ctx.cwd, ['style-guide.md']), ...(runDir ? [`${runDir}/ideas.md`] : []), ...(revising ? [path] : [])];
        return paths.length ? { thinking: revising ? 'The Editor sent it back — reading my draft and the notes again.' : 'Style guide first (POV, tense, header format), then the ideas file.', calls: paths.map((p) => read(p)) } : null;
      },
    },
    {
      name: 'draft',
      plan: () => {
        let body = chapterBody(cast);
        if (revising) for (const f of EDITOR_FIXES) body = body.replace(f.before, f.after);
        const content = `${chapterTitle(n)}\n\n${body}`;
        return {
          thinking: `Third person limited to ${cast.hero}, past tense. Open on the rain and the songthaew driver, let the shop's smell carry the memory of grandma, the note, the lantern — end on the knock with ${cast.cat} already waiting by the door.`,
          text: `${writerIntro(n)}${content}`,
          calls: [write(path, content, `write ${path}`)],
        };
      },
    },
    ackNote({ name: 'reply', plan: () => ({ text: reply() }) }, noteOf(ctx.conv.userText), (q) => `รับโน้ตของคุณแล้วค่ะ: ${q}`),
  ];
  return runScript(ctx, steps, reply());
}

// ───────────────────────── Editor ─────────────────────────

export function editorTurn(ctx: Ctx): TurnPlan {
  const nums = chapterNumbers(ctx.cwd);
  const path = nums.length ? `chapters/chapter-${pad(nums[nums.length - 1])}.md` : null;
  const content = path ? (readText(ctx.cwd, path) ?? '') : '';
  const fixes = EDITOR_FIXES.filter((f) => content.includes(f.before));
  const ops: AnchorOp[] = fixes.map((f) => {
    const line = content.split('\n').find((l) => l.includes(f.before)) ?? f.before;
    return { anchor: line, op: 'replace', lines: [line.replace(f.before, f.after)] };
  });
  const planned = path && ops.length ? planEdit(path, content, ops) : null;
  const words = thaiWordEstimate(content);
  const target = readText(ctx.cwd, 'style-guide.md')?.match(/ความยาวบทละ\s*([\d,]+\s*[–-]\s*[\d,]+)\s*คำ/)?.[1];

  const steps: Step[] = [
    {
      name: 'read',
      plan: () =>
        path
          ? { thinking: `Reading \`${path}\` against the style guide: POV, tense, rhythm, repetition.`, calls: [read(path), ...existing(ctx.cwd, ['style-guide.md']).map((p) => read(p))] }
          : null,
    },
    {
      name: 'edit',
      plan: (c) => {
        if (!path || !planned) return null;
        return {
          thinking: `Two small things: ${fixes.map((f) => `"${f.before}"`).join(' and ')} — both repeat themselves. Fixing them in place; the rest stays.`,
          calls: [editCall(c, { path, what: `tighten ${fixes.length} sentences`, edit: planned })],
        };
      },
    },
    {
      name: 'repair',
      plan: (c) => (path && planned && c.failed('edit') ? { calls: [write(path, planned.newContent, `${path} — tighten ${fixes.length} sentences`)] } : null),
    },
    {
      name: 'verdict',
      plan: (c) => {
        if (!path) return { text: `ยังไม่มีบทใหม่ใน \`chapters/\` ให้ตรวจค่ะ\n\n\`\`\`json\n${JSON.stringify({ verdict: 'revise', notes: 'Write the chapter file first (chapters/chapter-NN.md).' })}\n\`\`\`` };
        // Read the outcome from disk: a fix counts once its polished sentence is in and the clumsy one is gone.
        const applied = c.ran('edit') ? EDITOR_FIXES.filter((f) => content.includes(f.after) && !content.includes(f.before)) : [];
        return { thinking: 'Approve — the chapter works; the notes are for the next pass.', text: editorReply(path, applied, words, target) };
      },
    },
  ];
  const note = noteOf(ctx.conv.userText); // "Run again" with a note: say it was read
  const acked = steps.map((st) => (st.name === 'verdict' ? ackNote(st, note, (q) => `รอบนี้อ่านใหม่ตามโน้ตของคุณ: ${q}`) : st));
  return runScript(ctx, acked, editorReply(path ?? 'chapters/', [], words, target));
}
