// FINDING (owner): "Assistant wants to use browser" came as an empty card. omp's browser runs inside an eval cell (an
// eval prelude) and its approval dialog names only the tool ("Allow tool: browser"), so nobody could tell what it was
// for. The card now carries the step it comes from: the running eval call's intent and code.
// Run: bun test tests/chat/approval-origin.test.ts
import { describe, expect, test } from 'bun:test';
import type { ApprovalOrigin, ApprovalRequest, ServerMsg } from '../../shared/protocol';
import { ApprovalBook, approvalOrigin, type RunningCall } from '../../server/agents/approvals';

const LOGIN = "const tab = await browser.open('http://localhost:3000/login');\nawait tab.waitFor('main');";
const EVAL: RunningCall = { tool: 'eval', intent: 'Wait for redirect and render', args: { language: 'js', code: LOGIN } };
const OTHER_EVAL: RunningCall = { tool: 'eval', intent: 'Count the rows', args: { language: 'js', code: 'return rows.length' } };
const BASH: RunningCall = { tool: 'bash', args: { command: 'bun test' } };

function card(title: string, from: ApprovalOrigin | undefined): ApprovalRequest {
  const sent: ServerMsg[] = [];
  const book = new ApprovalBook({ broadcast: (m) => void sent.push(m), clients: () => [] }, { added: () => {}, resolved: () => {} });
  book.offer({ id: 'ui-1', method: 'select', title, options: ['Approve', 'Deny'] }, 'house:assistant', 'house', () => {}, undefined, undefined, from);
  return sent.find((m): m is Extract<ServerMsg, { t: 'approval' }> => m.t === 'approval')!.approval;
}

describe('a tool omp says nothing about shows the step it comes from', () => {
  test('browser asked from inside a running eval: the card carries that step, what it is for and its code', () => {
    const title = 'Allow tool: browser';
    expect(card(title, approvalOrigin(title, [BASH, EVAL])).from).toEqual({ tool: 'eval', intent: 'Wait for redirect and render', code: LOGIN });
  });

  test('of several steps running code, the one whose code uses the tool; the only one when none names it', () => {
    expect(approvalOrigin('Allow tool: browser', [EVAL, OTHER_EVAL])?.intent).toBe('Wait for redirect and render');
    expect(approvalOrigin('Allow tool: browser', [BASH, OTHER_EVAL])?.intent).toBe('Count the rows');
  });

  test('none when it is unclear which step, or when the card has its own details', () => {
    expect(approvalOrigin('Allow tool: browser', [OTHER_EVAL, { ...OTHER_EVAL, intent: 'Sum them' }])).toBeUndefined();
    expect(approvalOrigin('Allow tool: browser', [BASH])).toBeUndefined();
    expect(approvalOrigin('Allow tool: bash\nCommand: ls', [EVAL])).toBeUndefined(); // omp described the call itself
    expect(approvalOrigin('Allow tool: eval', [EVAL])).toBeUndefined(); // the call asked about is running: its own
    expect(approvalOrigin('Which plan should I follow?', [EVAL])).toBeUndefined(); // a question, not a tool
    expect(card('Allow tool: bash\nCommand: ls', { tool: 'eval', code: LOGIN }).from).toBeUndefined();
  });

  test('a long cell is cut, marked with …', () => {
    const long: RunningCall = { tool: 'eval', args: { code: `await browser.open('x');\n${'x'.repeat(9000)}` } };
    const code = approvalOrigin('Allow tool: browser', [long])!.code;
    expect(code.length).toBeLessThan(4100);
    expect(code.endsWith('\n…')).toBe(true);
  });
});
