// Roles the demo has no dedicated script for (custom workflows): a work step reads the project and writes its
// notes into the run folder; a review step reads and approves with notes. Both are honest about being a demo.
// A step after a parallel group sees every member's reply ("## <Name>" sections) and says whose work it merged;
// a member of a group says who works beside it.
import { fileNote, viewProject } from './describe';
import { gist, read, runScript, write, type Ctx, type Step, type TurnPlan } from './script';
import { passNumber, runDirOf, taskOf } from './workflow-prompt';

const roleName = (ctx: Ctx) => ctx.conv.role ?? 'step';

/** The people whose replies a step after a parallel group got: the "## <Name>" sections of its {{prev}}. */
export function mergedFrom(prompt: string): { name: string; gist: string }[] {
  const out: { name: string; gist: string }[] = [];
  const re = /^## (.+)\n([\s\S]*?)(?=\n## |\n\nYou are the |\n\nReply with|\n\nOthers work |$)/gm;
  for (const m of prompt.matchAll(re)) out.push({ name: m[1]!.trim(), gist: gist(m[2]!.trim().split('\n')[0] ?? '', 140) });
  return out.length >= 2 ? out : [];
}

/** Who works at the same time as this step ("Others work at the same time as you: A, B."), or ''. */
const besideOf = (prompt: string) => prompt.match(/^Others work at the same time as you: (.+?)\. Only change/m)?.[1] ?? '';

export function genericWorkTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const task = taskOf(ctx.conv.userText);
  const runDir = runDirOf(ctx.conv.userText);
  const notesPath = runDir ? `${runDir}/${roleName(ctx)}.md` : null;
  const paths = [...(v.readme !== null ? ['README.md'] : []), ...v.keyFiles].slice(0, 3);
  const merged = mergedFrom(ctx.conv.userText);
  const beside = besideOf(ctx.conv.userText);
  const notes = () =>
    [
      `# ${roleName(ctx)} — ${task}`,
      '',
      ...(merged.length ? ['## What the others found', '', ...merged.map((m) => `- **${m.name}:** ${m.gist}`), ''] : []),
      '## What I looked at',
      '',
      ...paths.map((p) => `- ${fileNote(v.cwd, p)}`),
      '',
      '## Notes',
      '',
      `- Demo model: this step's real work needs a connected provider.`,
      '',
    ].join('\n');
  const steps: Step[] = [
    { name: 'read', plan: () => (paths.length ? { thinking: `Task: "${gist(task)}". Reading ${paths.map((p) => `\`${p}\``).join(', ')}.`, calls: paths.map((p) => read(p)) } : null) },
    { name: 'notes', plan: () => (notesPath && ctx.conv.tools.has('write') ? { calls: [write(notesPath, notes(), 'write my notes')] } : null) },
    {
      name: 'reply',
      plan: () => ({
        text:
          (merged.length ? `Merged what ${merged.map((m) => m.name).join(' and ')} found. ` : '') +
          `Looked at ${paths.map((p) => `\`${p}\``).join(', ') || 'the project'}${notesPath ? ` and left notes in \`${notesPath}\`` : ''}` +
          `${beside ? ` (${beside} worked on the other part at the same time)` : ''}. (Demo model — connect a provider for the real thing.)`,
      }),
    },
  ];
  return runScript(ctx, steps, 'Done.');
}

export function genericReviewTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const paths = v.keyFiles.slice(0, 2);
  const pass = passNumber(ctx.conv.userTexts);
  const steps: Step[] = [
    { name: 'read', plan: () => (paths.length ? { thinking: 'Checking the files the previous step worked on.', calls: paths.map((p) => read(p)) } : null) },
    {
      name: 'verdict',
      plan: () => ({
        text: `Reviewed ${paths.map((p) => `\`${p}\``).join(', ') || 'the project'}${pass > 1 ? ` (round ${pass})` : ''}. Nothing blocking from the demo reviewer.\n\n\`\`\`json\n${JSON.stringify({ verdict: 'approve', notes: '' })}\n\`\`\``,
      }),
    },
  ];
  return runScript(ctx, steps, '```json\n{"verdict":"approve","notes":""}\n```');
}
