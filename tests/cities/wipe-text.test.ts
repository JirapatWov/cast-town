// "Delete all CAST data?" opened on a city through the hub talks about that city and the hub's pairing with it.
import { describe, expect, test } from 'bun:test';
import { wipeComeBackLine, wipeDevicesLine, type TextPart } from '../../web/src/ui/wipe-text';

const text = (parts: TextPart[]) => parts.map((p) => (typeof p === 'string' ? p : 'em' in p ? p.em : p.code)).join('');

describe('wipe dialog words', () => {
  test('home city: this browser is signed out and pairs again', () => {
    expect(text(wipeDevicesLine('Hilltop', false))).toBe('every paired device — including this one — and the pairing token');
    expect(text(wipeComeBackLine('Hilltop', false))).toContain('pair again with the new link');
  });
  test('a city through the hub: the hub’s pairing goes, re-pair it from the city menu', () => {
    expect(text(wipeDevicesLine('Harbor', true))).toBe('every device paired with Harbor — including this hub’s pairing — and its pairing token');
    const back = text(wipeComeBackLine('Harbor', true));
    expect(back).toContain('CAST on Harbor then restarts');
    expect(back).toContain('Manage cities → Re-pair');
    expect(back).not.toContain('pair again with the new link');
  });
});
