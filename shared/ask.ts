// An agent's `ask` and its answers, shared by the card (is every question answered?) and the server (checked before
// omp sees it). omp wants one answer per question, in its own order, with exact option labels (rpc-mode.ts
// parseAskDialogResponse refuses anything else), so the answers are checked against the questions here.
import type { ApprovalRequest, AskAnswer, AskQuestion } from './protocol';

export type AskCheck = { ok: true; answers: AskAnswer[] } | { ok: false; problem: string; questionId: string };

/** The answers as omp takes them, or what is still missing. Own words are trimmed (empty = none); an option picked
 *  twice counts once. A single-choice question needs exactly one answer: an option or the user's own words. A
 *  question that takes several may be left empty (omp reads it as "none of these"). */
export function checkAskAnswers(questions: readonly AskQuestion[], given: readonly AskAnswer[]): AskCheck {
  const answers: AskAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const name = questions.length > 1 ? `question ${i + 1}` : 'the question';
    const a = given.find((x) => x.id === q.id);
    const selected = [...new Set(a?.selectedOptions ?? [])];
    const custom = a?.customInput?.trim() || undefined;
    const labels = q.options.map((o) => o.label);
    const unknown = selected.find((l) => !labels.includes(l));
    if (unknown !== undefined) return { ok: false, problem: `“${unknown}” is not one of the answers to ${name}.`, questionId: q.id };
    const count = selected.length + (custom ? 1 : 0);
    if (!q.multi && count === 0) return { ok: false, problem: `Answer ${name} first.`, questionId: q.id };
    if (!q.multi && count > 1) return { ok: false, problem: `Pick one answer to ${name}.`, questionId: q.id };
    answers.push({ id: q.id, selectedOptions: selected, ...(custom ? { customInput: custom } : {}) });
  }
  return { ok: true, answers };
}

/** The questions of an ask card. A card from before CAST kept whole questions has only its first one, as title
 *  (the question), detail (its header) and options (its labels). Without options (a card saved by an older CAST)
 *  it is still a question, with no answers to pick. */
export function askQuestionsOf(a: Pick<ApprovalRequest, 'tool' | 'title' | 'detail' | 'options' | 'questions'>): AskQuestion[] {
  if (a.questions?.length) return a.questions;
  return [{ id: '', question: a.title, ...(a.detail ? { header: a.detail } : {}), options: (a.options ?? []).map((label) => ({ label })) }];
}

/** An agent asking the user something (ask, an extension's choice or confirm), not a tool waiting for an OK. */
export const isQuestion = (a: Pick<ApprovalRequest, 'tool'>): boolean => a.tool === 'ask' || a.tool === 'choice' || a.tool === 'confirm';

/** What a card asks, in one line (menu bar, notifications, screen readers): an ask's header and first question, with
 *  how many questions first when there are more; a confirm's prompt and message; a choice's prompt; else the title
 *  ("Allow tool: bash"). Not cut short: callers clip it. */
export function approvalLine(a: Pick<ApprovalRequest, 'tool' | 'title' | 'detail' | 'options' | 'questions'>): string {
  if (a.tool === 'ask') {
    const qs = askQuestionsOf(a);
    const q = qs[0]!;
    return `${qs.length > 1 ? `${qs.length} questions · ` : ''}${q.header ? `${q.header}: ` : ''}${q.question}`;
  }
  if (a.tool === 'confirm' && a.detail) return `${a.title} — ${a.detail}`;
  return a.title;
}
