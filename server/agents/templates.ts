// What a workflow step's prompt is made of. Placeholders: {{task}} {{prev}} {{prevName}} {{runDir}} {{feedback}}
// (after a parallel group, {{prev}} is every member's reply under "## <Name>" and {{prevName}} "A + B").

/** How every review step's instruction ends (workflow_save adds it to review steps that lack it). */
export const VERDICT_FOOTER = [
  'End your reply with exactly one block like this:',
  '```json',
  '{"verdict": "approve" | "revise", "notes": "what must change (empty when approving)"}',
  '```',
].join('\n');

export interface TemplateVars {
  task: string;
  prev: string;
  prevName: string;
  runDir: string;
  feedback: string;
}

/** What a member of a parallel group is told about the others (added to their prompt for that run). */
export function parallelNote(others: string[]): string {
  return `Others work at the same time as you: ${others.join(', ')}. Only change the files of your own part.`;
}

/** What the people of a continuation's first step that runs again are told (team_continue / continue_run): `first`
 *  — the first time it runs in this run, that it runs again on the files the earlier run left (and where their
 *  earlier reply is); every time (also when a review sends the work back to them), the user's note. '' when
 *  there is nothing to say. `kept`: steps before it kept their results (false: the whole team runs again). */
export function continueNote(fromRunId: string, kept: boolean, first: boolean, earlier?: string, note?: string): string {
  const parts: string[] = [];
  if (first) {
    const what = kept
      ? `This step runs again: the steps before it are kept from an earlier run (${fromRunId}), and the files are as that run left them`
      : `This team runs again after an earlier run (${fromRunId}), and the files are as that run left them`;
    parts.push(
      `${what} — they may already contain the earlier attempt at this step and the steps after it; build on them, don't apply changes twice.${earlier ? ` Your earlier reply: \`${earlier}\`.` : ''}`,
    );
  }
  if (note) parts.push(`The user asked for this part to be done again — take this into account:\n${note}`);
  return parts.join('\n\n');
}

/** Fill {{placeholders}}; unknown placeholders are left as-is so typos stay visible. */
export function renderInstruction(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(task|prev|prevName|runDir|feedback)\s*\}\}/g, (_, k: keyof TemplateVars) => vars[k]);
}
