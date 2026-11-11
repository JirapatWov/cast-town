// Subagents spawned by the `task` tool: read what the task names, then report findings (via `yield` when omp
// offers it, otherwise as the final text — omp uses either as the task result).
import { codeFindings, fileNote, viewProject } from './describe';
import { headings, readText } from './project-scan';
import { gist, read, runScript, type Ctx, type Step, type TurnPlan } from './script';

/** Paths named in the task text that exist in the project. */
function namedPaths(ctx: Ctx, files: string[]): string[] {
  const text = ctx.conv.userText;
  const hits = files.filter((p) => text.includes(`\`${p}\``) || text.includes(` ${p}`) || text.includes(`${p} `));
  if (/chapters\//.test(text)) hits.push(...files.filter((p) => p.startsWith('chapters/')));
  return [...new Set(hits)].slice(0, 4);
}

function novelFindings(cwd: string, paths: string[]): string[] {
  const out: string[] = [];
  const chars = headings(readText(cwd, 'characters.md') ?? '').map((h) => h.split(/\s+[—-]\s+/)[0]);
  const outline = readText(cwd, 'outline.md') ?? '';
  for (const p of paths) {
    const text = readText(cwd, p) ?? '';
    if (p === 'outline.md') {
      const missing = chars.filter((c) => c && !/ลูกค้า/.test(c) && !outline.includes(c));
      out.push(`- \`outline.md\` — ${[...outline.matchAll(/^\s*\d+\.\s+\*\*/gm)].length} chapters in 3 acts; ${missing.length ? `${missing.join(', ')} never appear by name` : 'every main character has a beat'}.`);
    } else if (p === 'characters.md') {
      out.push(`- \`characters.md\` — ${chars.length} entries; wants/needs are clear for the protagonist, thinner for the side cast.`);
    } else if (p === 'style-guide.md') {
      out.push(`- \`style-guide.md\` — rules to check prose against: ${(text.match(/^-\s+(.+)$/gm) ?? []).slice(0, 2).map((l) => l.replace(/^-\s+/, '').replace(/\*\*/g, '')).join('; ') || 'POV, tense, headers'}.`);
    } else if (p.startsWith('chapters/')) {
      const header = text.match(/^#\s+(.+)$/m)?.[1];
      out.push(`- \`${p}\` — ${header ? `"${header}"` : 'no `# บทที่ N — …` header'}; ${text.length} characters.`);
    }
  }
  if (!paths.some((p) => /chapter-\d+/.test(p))) out.push('- `chapters/` — only the prologue exists; บทที่ 1 is still unwritten.');
  return out;
}

export function helperTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const steps: Step[] = [
    {
      name: 'look',
      plan(c) {
        const named = namedPaths(c, v.files.map((f) => f.path));
        const paths = named.length ? named : v.keyFiles.slice(0, 2);
        if (!paths.length) return null;
        return { thinking: `My task: ${gist(c.conv.userText, 120)} I'll read ${paths.map((p) => `\`${p}\``).join(', ')}.`, calls: paths.map((p) => read(p)) };
      },
    },
    {
      name: 'report',
      plan(c) {
        const read = c.calls('look').map((x) => String(x.args.path));
        const findings =
          v.kind === 'novel'
            ? novelFindings(v.cwd, read)
            : read.flatMap((p) => codeFindings(v.cwd, p).slice(0, 3).map((f) => `- ${f}`));
        const text = [`Reviewed ${read.length ? read.map((p) => `\`${p}\``).join(', ') : 'the project'}.`, '', ...(findings.length ? findings : read.map((p) => `- ${fileNote(v.cwd, p)}`))].join('\n');
        if (c.conv.tools.has('yield')) return { thinking: 'Done — submitting findings.', calls: [{ name: 'yield', args: { data: text } }] };
        return { thinking: 'That covers it. Most important first.', text };
      },
    },
  ];
  return runScript(ctx, steps, 'Done.');
}
