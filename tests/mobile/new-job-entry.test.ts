// A phone has no jobs bar: the panel's job row (with its "+ New job") waits behind the chevron, so New job — and the
// Advisor choice inside it — was reachable only through the command palette. It is now in the house's ⋯ menu (the
// panel head and every Town board card) and, inside a house, in the top bar's More menu.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, '../../web/src/ui');
const src = (f: string) => readFileSync(join(UI, f), 'utf8');

describe('New job entry points on a phone', () => {
  test('the house ⋯ menu offers New job for that house', () => {
    const menu = src('house-menu.ts');
    const fn = menu.slice(menu.indexOf('export function openHouseMenu'), menu.indexOf('export function houseCommands'));
    expect(fn).toMatch(/label: 'New job…', icon: 'plus'.*onSelect: \(\) => shell\.openNewJob\(project\.id\)/);
  });
  test('the More menu offers New job inside a house, and only there', () => {
    const more = src('more-menu.ts');
    expect(more).toMatch(/const house = shell\.view\.view === 'house' \? shell\.store\.project\(shell\.view\.projectId\) : undefined;/);
    expect(more).toMatch(/house \? \{ label: 'New job…'.*onSelect: \(\) => shell\.openNewJob\(house\.id\) \} : null/);
  });
});
