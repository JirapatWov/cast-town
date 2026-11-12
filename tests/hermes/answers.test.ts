// How the Hermes bridge turns what the user typed in a chat ("approve a7k2q", "deny", "2", "ไม่อนุมัติ") into the answer
// CAST gets. CAST denies an answer that is not one of the card's options, so a word the bridge can't place must be
// refused with the options listed — never sent as a guess — and "approve" must mean the plain one-time approval, not
// "for this session".
import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest, TeamPlan } from '../../shared/protocol';
import { findPending, pickOption, resolveAnswer, shortCode, type Pending } from '../../hermes/view';

const TOOL_OPTIONS = ['Approve', 'Approve bash for this session', 'Deny'];

function approval(over: Partial<ApprovalRequest> = {}): Pending {
  const a: ApprovalRequest = { id: 'req-1', agentId: 'ag', projectId: 'p', tool: 'bash', title: 'Allow tool: bash', detail: 'rm -rf build', options: TOOL_OPTIONS, ts: 1, ...over };
  return { kind: a.tool === 'ask' ? 'question' : 'approval', id: a.id, code: shortCode('a', a.id), projectId: 'p', jobId: 'main', agentId: 'ag', house: 'Shop', job: 'Main', person: 'Developer', ts: 1, approval: a };
}

function plan(): Pending {
  const p = { id: 'plan-1', agentId: 'ag', projectId: 'p', jobId: 'main', title: 'Fix → Review', task: 't', steps: [], status: 'pending', ts: 1 } as TeamPlan;
  return { kind: 'plan', id: p.id, code: shortCode('p', p.id), projectId: 'p', jobId: 'main', agentId: 'ag', house: 'Shop', job: 'Main', person: 'Developer', ts: 1, plan: p };
}

describe('pickOption', () => {
  test('yes and no words pick the plainest option of their kind', () => {
    for (const w of ['approve', 'Approve', 'yes', 'ok', 'อนุมัติ']) expect(pickOption(TOOL_OPTIONS, w)).toBe('Approve');
    for (const w of ['deny', 'no', 'reject', 'ไม่อนุมัติ']) expect(pickOption(TOOL_OPTIONS, w)).toBe('Deny');
  });

  test('the exact option, any case, and its 1-based number', () => {
    expect(pickOption(TOOL_OPTIONS, 'approve bash for this session')).toBe('Approve bash for this session');
    expect(pickOption(TOOL_OPTIONS, '2')).toBe('Approve bash for this session');
    expect(pickOption(TOOL_OPTIONS, '3')).toBe('Deny');
    expect(pickOption(TOOL_OPTIONS, '4')).toBeNull();
    expect(pickOption(TOOL_OPTIONS, '0')).toBeNull();
  });

  test('anything it cannot place is null, never a guess', () => {
    expect(pickOption(TOOL_OPTIONS, 'maybe')).toBeNull();
    expect(pickOption(TOOL_OPTIONS, 'appr')).toBeNull(); // starts two options
    expect(pickOption(TOOL_OPTIONS, '')).toBeNull();
    expect(pickOption(['Keep', 'Discard'], 'yes')).toBeNull(); // no option of that kind
  });
});

describe('resolveAnswer', () => {
  test('a tool approval sends the option it names', () => {
    expect(resolveAnswer(approval(), 'approve')).toEqual({ kind: 'approve', value: 'Approve', said: 'Approve' });
    expect(resolveAnswer(approval(), 'deny')).toEqual({ kind: 'approve', value: 'Deny', said: 'Deny' });
    const bad = resolveAnswer(approval(), 'later');
    expect('error' in bad && bad.error).toContain('1) Approve, 2) Approve bash for this session, 3) Deny');
  });

  test('a plan card takes run or cancel only', () => {
    expect(resolveAnswer(plan(), 'run')).toEqual({ kind: 'plan', run: true, said: 'Run' });
    expect(resolveAnswer(plan(), 'เริ่ม')).toMatchObject({ run: true });
    expect(resolveAnswer(plan(), 'cancel')).toEqual({ kind: 'plan', run: false, said: 'Cancel' });
    expect(resolveAnswer(plan(), 'ยกเลิก')).toMatchObject({ run: false });
    expect(resolveAnswer(plan(), 'sure thing')).toHaveProperty('error');
  });

  const color = { id: 'q1', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] };
  const size = { id: 'q2', question: 'How big?', options: [{ label: 'Small' }, { label: 'Large' }] };

  test("one question: an option's label or number selects it; other words are the user's own answer", () => {
    const q = approval({ tool: 'ask', title: 'Which colour?', options: ['Blue', 'Green'], questions: [color] });
    expect(resolveAnswer(q, 'blue')).toMatchObject({ value: 'Blue', answers: [{ id: 'q1', selectedOptions: ['Blue'] }] });
    expect(resolveAnswer(q, '2')).toMatchObject({ answers: [{ id: 'q1', selectedOptions: ['Green'] }] });
    expect(resolveAnswer(q, 'a dark red')).toMatchObject({ value: 'a dark red', answers: [{ id: 'q1', selectedOptions: [], customInput: 'a dark red' }] });
  });

  test('several questions need an answer each', () => {
    const q = approval({ tool: 'ask', title: 'Which colour?', options: ['Blue', 'Green'], questions: [color, size] });
    expect(resolveAnswer(q, 'blue')).toHaveProperty('error');
    expect(resolveAnswer(q, '', [{ question: '1', choose: ['blue'] }])).toHaveProperty('error');
    expect(resolveAnswer(q, '', [{ question: '1', choose: ['blue'] }, { question: 'q2', choose: ['2'] }])).toMatchObject({
      answers: [
        { id: 'q1', selectedOptions: ['Blue'] },
        { id: 'q2', selectedOptions: ['Large'] },
      ],
    });
    const wrong = resolveAnswer(q, '', [{ question: '1', choose: ['purple'] }, { question: '2', choose: ['Small'] }]);
    expect('error' in wrong && wrong.error).toContain('1) Blue, 2) Green');
  });
});

describe('codes', () => {
  test('the same id gives the same short code; a code finds its request, case-insensitively', () => {
    const a = approval();
    expect(shortCode('a', 'req-1')).toBe(a.code);
    expect(a.code).toMatch(/^a[a-z2-9]{4}$/);
    expect(findPending([a, plan()], a.code.toUpperCase())).toBe(a);
    expect(findPending([a], 'req-1')).toBe(a);
  });

  test('a request answered meanwhile is reported, with what still waits', () => {
    const p = plan();
    const r = findPending([p], 'azzzz');
    expect('error' in r && r.error).toContain(p.code);
    expect(findPending([], 'azzzz')).toMatchObject({ error: expect.stringContaining('Nothing waits') });
  });
});
