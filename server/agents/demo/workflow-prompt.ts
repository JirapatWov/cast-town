// Read the pieces of a rendered workflow instruction (see templates.ts) back out of the user message.
import { gist, type Step } from './script';

/** `.rlt/runs/<id>` from "`{{runDir}}/analysis.md`"-style references, or null outside a run. */
export function runDirOf(text: string): string | null {
  return text.match(/`(\.rlt\/runs\/[^`/\s]+)(?:\/[^`]*)?`/)?.[1] ?? null;
}

/** The user's task/brief ("Task: …" / "Brief: …" first line). */
export function taskOf(text: string): string {
  return text.match(/^(?:Task|Brief):\s*(.+)$/m)?.[1]?.trim() ?? text.split('\n')[0]?.trim() ?? '';
}

/** Review notes the engine appended when a reviewer sent the work back, or null on a first pass. */
export function feedbackOf(text: string): string | null {
  const m = text.match(/asked for changes — address every point:\n([\s\S]*?)(?:\n\n[A-Z][^\n]*$|$)/);
  return m ? m[1].trim() : null;
}

/** The note the user gave with "Run again" (templates.ts continueNote), or null. Its first line: the instruction may
 *  go on right after it, and a note is a sentence or two. */
export function noteOf(text: string): string | null {
  const m = text.match(/The user asked for this part to be done again — take this into account:\n([^\n]+)/);
  const note = m?.[1]?.trim();
  return note ? note : null;
}

/** Does this message look like a rendered workflow instruction (vs. the user chatting with a role directly)? */
export function isStepPrompt(text: string): boolean {
  return runDirOf(text) !== null || /^(Task|Brief):\s*\S/m.test(text);
}

/** How many times this role has been prompted in the current run (the engine starts a new session per run). */
export const passNumber = (userTexts: string[]) => Math.max(1, userTexts.length);

/** A step whose reply starts by quoting the user's "Run again" note (`ack`), so a rerun visibly read it instead of
 *  answering word for word as before. No note: the step as it is. */
export function ackNote(step: Step, note: string | null, ack: (quoted: string) => string): Step {
  if (!note) return step;
  return {
    name: step.name,
    plan(ctx) {
      const out = step.plan(ctx);
      return out?.text ? { ...out, text: `${ack(`“${gist(note, 200)}”`)}\n\n${out.text}` } : out;
    },
  };
}
