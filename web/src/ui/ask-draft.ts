// What the user has picked on an ask card so far (no DOM): kept per request, so a card drawn again (another tab of
// the panel, the stack after the chat closes) still shows the picks and the words typed. Nothing is picked for the
// user — not even the recommended option — so every answer omp gets is one the user gave.
import { checkAskAnswers, type AskCheck } from '../../../shared/ask';
import type { AskAnswer, AskQuestion } from '../../../shared/protocol';

interface QuestionDraft {
  picked: string[];
  /** "Something else" is chosen (a single-choice question: instead of the options). */
  ownOn: boolean;
  own: string;
}

export type AskDraft = Map<string, QuestionDraft>;

export const newDraft = (): AskDraft => new Map();

const drafts = new Map<string, AskDraft>();

/** The draft of one request (approval id), made on first use. */
export function draftFor(approvalId: string): AskDraft {
  let d = drafts.get(approvalId);
  if (!d) drafts.set(approvalId, (d = newDraft()));
  return d;
}

export function dropDraft(approvalId: string): void {
  drafts.delete(approvalId);
}

function slot(d: AskDraft, q: AskQuestion): QuestionDraft {
  let s = d.get(q.id);
  if (!s) d.set(q.id, (s = { picked: [], ownOn: false, own: '' }));
  return s;
}

/** Tap an option: a single-choice question takes it instead of what it had; one that takes several toggles it. */
export function pick(d: AskDraft, q: AskQuestion, label: string): void {
  const s = slot(d, q);
  if (q.multi) {
    s.picked = s.picked.includes(label) ? s.picked.filter((l) => l !== label) : [...s.picked, label];
  } else {
    s.picked = [label];
    s.ownOn = false;
  }
}

/** Tap "Something else": a single-choice question takes the user's own words instead of an option. */
export function toggleOwnWords(d: AskDraft, q: AskQuestion): void {
  const s = slot(d, q);
  if (q.multi) s.ownOn = !s.ownOn;
  else {
    s.ownOn = true;
    s.picked = [];
  }
}

export function setOwnWords(d: AskDraft, q: AskQuestion, text: string): void {
  slot(d, q).own = text;
}

export function isPicked(d: AskDraft, q: AskQuestion, label: string): boolean {
  return d.get(q.id)?.picked.includes(label) ?? false;
}

export function ownWords(d: AskDraft, q: AskQuestion): { on: boolean; text: string } {
  const s = d.get(q.id);
  return { on: s?.ownOn ?? false, text: s?.own ?? '' };
}

/** The draft as omp's answers, one per question in question order: picks in the options' order, own words (trimmed)
 *  only while chosen. */
export function draftAnswers(questions: readonly AskQuestion[], d: AskDraft): AskAnswer[] {
  return questions.map((q) => {
    const s = d.get(q.id);
    const own = s?.ownOn ? s.own.trim() : '';
    return { id: q.id, selectedOptions: q.options.map((o) => o.label).filter((l) => s?.picked.includes(l)), ...(own ? { customInput: own } : {}) };
  });
}

/** Ready to send (the answers as the server will check them), or what is still missing. */
export function askState(questions: readonly AskQuestion[], d: AskDraft): AskCheck {
  return checkAskAnswers(questions, draftAnswers(questions, d));
}
