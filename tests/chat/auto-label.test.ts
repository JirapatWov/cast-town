// #61: what Auto mode let through without asking is labelled in the chat ("Auto-approved"), so it can be looked over
// afterwards. The approval book tells the runtime exactly when Auto's rules cleared a step — never for a step that
// became a card, never in Bypass (which looks at nothing) and never in Ask first.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalMode, ServerMsg } from '../../shared/protocol';
import { ApprovalBook } from '../../server/agents/approvals';

function book(mode: ApprovalMode) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'auto-label-'));
  const sent: ServerMsg[] = [];
  const answers: unknown[] = [];
  const b = new ApprovalBook({ broadcast: (m) => void sent.push(m), clients: () => [] }, { added: () => {}, resolved: () => {} }, () => ({ mode, dir }));
  let n = 0;
  const offer = (tool: string, detail: string, args: unknown, agent = 'todo-api:developer') => {
    let labelled = 0;
    const frame = { id: `ui-${++n}`, method: 'select', title: `Allow tool: ${tool}\n${detail}`, options: ['Approve', 'Deny'] };
    b.offer(frame, agent, 'todo-api', (p) => void answers.push(p), args, () => void labelled++);
    return { labelled, card: sent.some((m) => m.t === 'approval' && m.approval.id === frame.id) };
  };
  return { offer, b, answers };
}

describe('Auto-approved label', () => {
  test('Auto: a step its rules clear is answered and labelled', () => {
    const { offer, answers } = book('auto');
    expect(offer('bash', 'Command: bun test', { command: 'bun test' })).toEqual({ labelled: 1, card: false });
    expect(answers).toEqual([{ value: 'Approve' }]);
  });

  test('Auto: a step its rules flag becomes a card and is not labelled', () => {
    const { offer, answers } = book('auto');
    expect(offer('bash', 'Command: sudo rm -rf /var/x', { command: 'sudo rm -rf /var/x' })).toEqual({ labelled: 0, card: true });
    expect(answers).toEqual([]);
  });

  test('Bypass answers everything but labels nothing; Ask first labels nothing', () => {
    expect(book('yolo').offer('bash', 'Command: bun test', { command: 'bun test' })).toEqual({ labelled: 0, card: false });
    expect(book('always-ask').offer('bash', 'Command: bun test', { command: 'bun test' })).toEqual({ labelled: 0, card: true });
  });

  test('switching a waiting card to Auto clears and labels it then', () => {
    let mode: ApprovalMode = 'always-ask';
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'auto-label-'));
    const b = new ApprovalBook({ broadcast: () => {}, clients: () => [] }, { added: () => {}, resolved: () => {} }, () => ({ mode, dir }));
    let labelled = 0;
    b.offer({ id: 'ui-x', method: 'select', title: 'Allow tool: bash\nCommand: bun test', options: ['Approve', 'Deny'] }, 'todo-api:developer', 'todo-api', () => {}, { command: 'bun test' }, () => void labelled++);
    expect(labelled).toBe(0);
    mode = 'auto';
    b.reconsider('todo-api');
    expect(labelled).toBe(1);
    expect(b.list()).toEqual([]);
  });
});
