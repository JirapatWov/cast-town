// Decode → Implement → Review on a code project. On RLT's seeded todo-api the team makes the real change
// (PATCH /todos/:id/done + validation + tests); the Reviewer runs `git diff --stat` and `bun test` (an approval
// in write mode), sends the first round back with a concrete note, and approves the second.
import { codeFindings, viewProject, type ProjectView } from './describe';
import { appendSection, changedThisTurn, editSteps, type EditTarget } from './edit-steps';
import { lineOf, readText } from './project-scan';
import { bash, gist, read, runScript, write, type Ctx, type Step, type TurnPlan } from './script';
import { isTodoSeed, SERVER, STORE, TESTS, todoFeaturesFor, todoPatches, todoState, type TodoFeature } from './todo-patch';
import { ackNote, feedbackOf, noteOf, passNumber, runDirOf, taskOf } from './workflow-prompt';

const verdictBlock = (verdict: 'approve' | 'revise', notes: string) => `\`\`\`json\n${JSON.stringify({ verdict, notes })}\n\`\`\``;

// ───────────────────────── Decoder ─────────────────────────

function seedAnalysis(cwd: string, task: string, features: TodoFeature[]): string {
  const server = readText(cwd, SERVER) ?? '';
  const ln = (re: string) => lineOf(server, re) ?? '?';
  const s = todoState(cwd);
  const findings: string[] = [];
  if (!s.hasDone) {
    findings.push(`- \`${SERVER}:${ln('rest.length > 0')}\` rejects any extra path segment, so \`/todos/:id/done\` can't exist yet.`);
    findings.push(`- \`${STORE}\` — \`TodoStore\` only has list / get / create / remove; nothing ever sets \`done\`.`);
  }
  if (!s.hasValidation) findings.push(`- \`${SERVER}:${ln('no validation')}\` stores \`body.title\` unchecked (empty / non-string titles get in); \`req.json()\` throws on bad JSON → 500.`);
  findings.push(`- \`${TESTS}\` — the \`test.todo\` placeholders describe exactly this work; error paths have no tests.`);
  if (s.hasDone && s.hasValidation) findings.unshift('- Both known gaps already look fixed on disk — this run only needs to confirm it.');

  const plan: string[] = [];
  if (features.includes('done') && !s.hasDone) {
    plan.push(`\`${STORE}\` — add \`markDone(id): Todo | undefined\`.`);
    plan.push(`\`${SERVER}\` — accept \`/todos/:id/done\`: \`PATCH\` → \`markDone\`, other methods → 405, unknown id → 404.`);
  }
  if (features.includes('validation') && !s.hasValidation) plan.push(`\`${SERVER}\` — validate \`title\` (non-empty string after trim, ≤ 200 chars) and ids (positive integers) → 400 \`{ error }\`.`);
  plan.push(`\`${TESTS}\` — replace the \`test.todo\`s with real tests (happy path + 404 / 400).`);
  plan.push('`README.md` — document the endpoint, tick the known gaps.');

  return `# Analysis — ${task}

## Findings
${findings.join('\n')}

## Plan
${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}

## Risks
- The route parser change must keep \`/health\`, \`/todos\` and \`/todos/:id\` behaving exactly as before.
- \`req.json()\` throws on malformed bodies — catch it so it's a 400, not a 500.

## How to verify
- \`bun test\` — everything passes, no \`todo\` left.
- \`curl -X PATCH localhost:3000/todos/1/done\` → \`{ "done": true, … }\`.
`;
}

function genericAnalysis(v: ProjectView, task: string): string {
  const findings = v.keyFiles.flatMap((p) => codeFindings(v.cwd, p).slice(0, 2));
  return `# Analysis — ${task}

## Findings
${findings.length ? findings.map((f) => `- ${f}`).join('\n') : '- Small project; nothing in the way of this change.'}

## Plan
1. Touch as little as possible: ${v.keyFiles.map((p) => `\`${p}\``).join(', ') || 'the README'}.
2. Add or update a test for the new behavior.
3. Note the change in the README.

## Risks
- Offline demo model: the plan is generic — connect a provider for a real analysis.

## How to verify
- Run the project's tests.
`;
}

export function decoderTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const task = taskOf(ctx.conv.userText);
  const runDir = runDirOf(ctx.conv.userText) ?? '.rlt';
  const seed = isTodoSeed(v.cwd);
  const steps: Step[] = [
    {
      name: 'survey',
      plan: () => ({
        thinking: `Task: "${gist(task)}". Analysis only — I won't touch source. Start with the README for intent and the file tree for shape.`,
        calls: [read('README.md', 'project intent'), read('.', 'list the project')],
      }),
    },
    {
      name: 'trace',
      plan: () =>
        v.keyFiles.length
          ? { thinking: `Now the code this touches: ${v.keyFiles.map((p) => `\`${p}\``).join(', ')}.`, calls: v.keyFiles.map((p) => read(p)) }
          : null,
    },
    {
      name: 'plan',
      plan: () => ({
        thinking: seed
          ? 'The router rejects extra path segments, the store has no way to set `done`, POST trusts its input, and the test file already names the missing cases. Writing the plan so the Implementer can go file by file.'
          : 'Writing a plan that names files and how to verify.',
        calls: [write(`${runDir}/analysis.md`, seed ? seedAnalysis(v.cwd, task, todoFeaturesFor(task)) : genericAnalysis(v, task), 'write the implementation plan')],
      }),
    },
    {
      name: 'reply',
      plan: () => ({
        text: seed
          ? `Plan is in \`${runDir}/analysis.md\`. Short version:\n\n1. \`${STORE}\`: add \`markDone(id)\`.\n2. \`${SERVER}\`: route \`PATCH /todos/:id/done\` (405 for other methods, 404 for unknown ids) and validate input → 400.\n3. \`${TESTS}\`: turn the \`test.todo\`s into real tests.\n4. README: document it.\n\nRisk to watch: the route parser — \`/todos/:id\` must keep working.`
          : `Plan is in \`${runDir}/analysis.md\` — ${v.keyFiles.length} files to look at, test first, README note last.`,
      }),
    },
  ];
  return runScript(ctx, steps, 'Plan written.');
}

// ───────────────────────── Implementer ─────────────────────────

function implementerTargets(ctx: Ctx, v: ProjectView): EditTarget[] {
  const text = ctx.conv.userText;
  const feedback = feedbackOf(text);
  if (isTodoSeed(v.cwd)) {
    const features: TodoFeature[] = feedback ? [...todoFeaturesFor(taskOf(text)), 'errorTests'] : todoFeaturesFor(taskOf(text));
    return todoPatches(v.cwd, features).map((p) => ({ path: p.path, what: p.what, edit: p.edit }));
  }
  const lines = feedback
    ? ['### How to verify', '', `- ${gist(feedback, 200)}`]
    : ['## Changes', '', `- ${gist(taskOf(text), 200)} *(demo implementer: noted, not implemented)*`];
  return [appendSection(v.cwd, v.readme !== null ? 'README.md' : 'NOTES.md', lines, feedback ? 'added the verification notes' : 'noted the change')];
}

export function implementerTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const runDir = runDirOf(ctx.conv.userText);
  const feedback = feedbackOf(ctx.conv.userText);
  let memo: EditTarget[] | null = null;
  const targets = (c: Ctx) => (memo ??= implementerTargets(c, v));
  const steps: Step[] = [
    ...editSteps({
      targets,
      extraReads: () => (runDir && !feedback ? [read(`${runDir}/analysis.md`, 'read the plan')] : []),
      readThinking: (_c, paths) =>
        feedback
          ? `Review notes: "${gist(feedback, 140)}". Re-reading ${paths.map((p) => `\`${p}\``).join(', ')} before fixing that.`
          : `Reading the Decoder's plan and the files it names: ${paths.map((p) => `\`${p}\``).join(', ')}.`,
      editThinking: (_c, ts) => `Changes, file by file: ${ts.map((t) => `${t.path} → ${t.what.replace(/`/g, '')}`).join('; ')}.`,
    }),
    {
      name: 'reply',
      plan(c) {
        const changed = changedThisTurn(c);
        if (!changed.length) return { text: 'Nothing to change — the plan is already implemented on disk. `bun test` should pass as-is.' };
        const list = changed.map((x) => `- \`${x.path}\` — ${x.what}`).join('\n');
        const seed = isTodoSeed(v.cwd);
        const verify = seed ? (feedback ? 'Added the missing failure-path tests; `bun test` should show them passing.' : 'New tests replace the `test.todo`s — the Reviewer can run `bun test`.') : 'Demo model: recorded the change rather than implementing it.';
        return { text: `${feedback ? 'Addressed the review:' : 'Implemented the plan:'}\n\n${list}\n\n${verify} Nothing committed.` };
      },
    },
  ];
  return runScript(ctx, steps, 'Done.');
}

// ───────────────────────── Reviewer ─────────────────────────

function testCounts(out: string): { pass: number; fail: number } | null {
  const pass = out.match(/(\d+)\s+pass/)?.[1];
  const fail = out.match(/(\d+)\s+fail/)?.[1];
  return pass || fail ? { pass: Number(pass ?? 0), fail: Number(fail ?? 0) } : null;
}

const isDenied = (toolResult: string) => /denied|rejected|not allowed/i.test(toolResult.slice(0, 200));

function diffFiles(out: string): string[] {
  return [...out.matchAll(/^\s*([\w./-]+)\s+\|\s+\d+/gm)].map((m) => m[1]).filter((p) => !p.startsWith('.rlt/'));
}

export function reviewerTurn(ctx: Ctx): TurnPlan {
  const v = viewProject(ctx.cwd);
  const seed = isTodoSeed(v.cwd);
  const pass = passNumber(ctx.conv.userTexts);
  const hasTests = !!readText(v.cwd, 'package.json')?.includes('"test"');
  const note = noteOf(ctx.conv.userText); // "Run again" with a note: say it was read
  const steps: Step[] = [
    {
      name: 'diff',
      plan: () => ({
        thinking: `Review ${pass === 1 ? '' : `round ${pass}: `}start from what actually changed, and run the tests rather than trusting the summary.${note ? ` The user's note for this round: "${gist(note, 120)}".` : ''}`,
        calls: [bash(hasTests ? 'git diff --stat && bun test 2>&1 | tail -n 15' : 'git diff --stat', hasTests ? 'diff and run the tests' : 'see what changed')],
      }),
    },
    {
      name: 'inspect',
      plan(c) {
        const out = c.result('diff');
        const denied = isDenied(out);
        const files = denied ? v.keyFiles : diffFiles(out);
        const pick = seed ? [TESTS] : files.slice(0, 2);
        if (!pick.length) return null;
        return {
          thinking: denied ? "I wasn't allowed to run that, so I'll read the changed files directly." : `${files.length} files changed. Checking ${pick.map((p) => `\`${p}\``).join(', ')} for what the tests cover.`,
          calls: pick.map((p) => read(p)),
        };
      },
    },
    {
      name: 'verdict',
      plan(c) {
        const out = c.result('diff');
        const denied = isDenied(out);
        const files = diffFiles(out);
        const counts = testCounts(out);
        const ran = denied ? '' : counts ? `\`bun test\`: ${counts.pass} pass, ${counts.fail} fail.` : hasTests ? 'Tests not run.' : '';
        const scope = denied
          ? 'You declined the diff/test run, so I reviewed the files directly (tests not run).'
          : files.length
            ? `Diff touches ${files.map((p) => `\`${p}\``).join(', ')}.`
            : 'No tracked files changed.';
        const lead = [scope, ran].filter(Boolean).join(' ');
        if (counts && counts.fail > 0 && pass < 3) {
          const notes = `${counts.fail} test${counts.fail === 1 ? '' : 's'} failing — fix them before anything else.`;
          return { text: `${lead}\n\n**Blocking:** ${notes}\n\n${verdictBlock('revise', notes)}` };
        }
        if (seed) {
          const s = todoState(v.cwd);
          if (pass === 1 && s.hasDone && !s.hasErrorTests) {
            const notes = s.hasValidation
              ? 'Add tests for the failure paths of PATCH /todos/:id/done: an unknown id must return 404 and a malformed id (e.g. "abc") must return 400. Only the happy path is covered.'
              : 'Add a test for the failure path of PATCH /todos/:id/done: an unknown id must return 404. Only the happy path is covered.';
            return {
              thinking: 'Route and store change look right and the placeholders are real tests now, but nothing proves the 404/400 paths — exactly where route-parser changes break.',
              text: [
                lead,
                `The change is correct: \`markDone\` is minimal${s.hasValidation ? ', the router keeps `/todos/:id` intact, and validation returns 400 with a message' : ' and the router keeps `/todos/:id` intact'}.`,
                `**Blocking:** the new endpoint's failure paths are untested — unknown id (404)${s.hasValidation ? ' and malformed id (400)' : ''}.`,
                ...(s.hasValidation ? ['Non-blocking: `MAX_TITLE_LENGTH` could live next to the store.'] : []),
                verdictBlock('revise', notes),
              ].join('\n\n'),
            };
          }
          const tail = s.hasErrorTests ? 'Failure paths are covered now.' : '';
          return {
            thinking: denied ? "Can't run the tests, but the code and the new tests read right." : 'Everything I asked for is there and green.',
            text: `${[scope, ran, tail].filter(Boolean).join(' ')}\n\nLGTM — small, idiomatic, tested. Ship it.\n\n${verdictBlock('approve', '')}`,
          };
        }
        if (pass === 1) {
          const notes = 'Say how to verify the change (a test or a one-line check) next to it.';
          return { text: `${lead}\n\nThe change is fine as far as it goes, but there's no way to verify it.\n\n${verdictBlock('revise', notes)}` };
        }
        return { text: `${lead}\n\nGood enough for this round.\n\n${verdictBlock('approve', '')}` };
      },
    },
  ];
  const acked = steps.map((st) => (st.name === 'verdict' ? ackNote(st, note, (q) => `Another look, with your note: ${q}`) : st));
  return runScript(ctx, acked, verdictBlock('approve', ''));
}
