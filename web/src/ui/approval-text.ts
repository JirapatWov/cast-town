// What a waiting request says outside its card (no DOM): the system notification and the screen reader's line. An
// agent's question says what it asks — the question itself, not only its header chip.
import { approvalLine, isQuestion } from '../../../shared/ask';
import type { ApprovalOrigin, ApprovalRequest } from '../../../shared/protocol';

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "From the eval step “Open the login page”": where a tool omp says nothing about is called from. */
export function originLabel(from: ApprovalOrigin): string {
  return `From the ${from.tool} step${from.intent ? ` “${from.intent}”` : ''}`;
}

export function approvalNotice(a: ApprovalRequest, who: string): { title: string; body: string } {
  if (isQuestion(a)) return { title: `${who} asks you`, body: clip(approvalLine(a).replace(/\s+/g, ' ').trim(), 200) };
  const what = a.detail ?? (a.from ? originLabel(a.from) : a.title);
  return {
    title: `${who} needs your OK`,
    body: [a.autoReason ? `Auto mode: ${a.autoReason}` : null, `${a.tool}: ${what.split('\n')[0].slice(0, 140)}`].filter(Boolean).join('\n'),
  };
}

export function approvalAnnouncement(a: ApprovalRequest, who: string, where: string | undefined): string {
  const asker = `${who}${where ? ` in ${where}` : ''}`;
  if (isQuestion(a)) return `${asker} asks: ${approvalLine(a).replace(/\s+/g, ' ').trim()}. Answer on the card or in the Inbox.`;
  return `${asker} needs your approval to use ${a.tool}. Answer on the card or in the Inbox.`;
}
