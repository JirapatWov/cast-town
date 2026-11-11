import { describe, expect, test } from 'bun:test';
import { createConsentGate } from '../../web/src/ui/first-chat-gate';

describe('the first-chat note sends only the message it was answered for', () => {
  test('a late "Ask me first" answer for house A never sends house B’s message', () => {
    const gate = createConsentGate();
    const sent: string[] = [];
    const a = gate.hold('A', () => sent.push('A'));
    gate.hold('B', () => sent.push('B')); // the chat moved on to B, and Send was pressed there
    expect(gate.settle(a)).toBeNull();
    expect(gate.current?.projectId).toBe('B');
    expect(sent).toEqual([]);
  });
  test('the note going (another chat on show) drops a pending answer', () => {
    const gate = createConsentGate();
    const a = gate.hold('A', () => {});
    gate.clear();
    expect(gate.settle(a)).toBeNull();
    expect(gate.current).toBeNull();
  });
  test('the same house keeps its session with the newest send, once', () => {
    const gate = createConsentGate();
    const first = gate.hold('A', () => 'old');
    const again = gate.hold('A', () => 'new');
    expect(again).toBe(first);
    expect(gate.settle(first)?.()).toBe('new');
    expect(gate.settle(first)).toBeNull();
  });
});
