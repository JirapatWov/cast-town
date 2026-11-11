// The owner (2026-11-04): the desktop panel you chat in should widen by dragging. web/src/ui/panel-resize.ts: drag its
// left edge (or arrow keys on the grip), the width is remembered per device, double-click / Enter gives the usual
// width back; base.css clamps the same way so the town always keeps part of the window. Run: bun test <this file>
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampPanelWidth, dragWidth, keyWidth, PANEL_MAX_SHARE, PANEL_MIN_W, panelMaxWidth, savedPanelWidth } from '../../web/src/ui/panel-resize';

const css = (f: string) => readFileSync(join(import.meta.dir, '../../web/src/ui/css', f), 'utf8');

describe('how wide the panel may be', () => {
  test('never under 320px, never over 65% of the window (the town keeps the rest)', () => {
    expect(clampPanelWidth(100, 1440)).toBe(320);
    expect(clampPanelWidth(700.4, 1440)).toBe(700);
    expect(clampPanelWidth(5000, 1440)).toBe(936);
    expect(panelMaxWidth(1440)).toBe(936);
    expect(panelMaxWidth(821)).toBe(533);
    expect(panelMaxWidth(300)).toBe(320); // a window too small for the share still gets the narrowest panel
  });

  test('a drag to the left widens it, to the right narrows it, from where it started', () => {
    expect(dragWidth(420, 1000, 800, 1440)).toBe(620);
    expect(dragWidth(420, 1000, 1080, 1440)).toBe(340);
    expect(dragWidth(420, 1000, 1300, 1440)).toBe(320);
    expect(dragWidth(420, 1000, 0, 1440)).toBe(936);
  });

  test('keys on the grip: ← wider, → narrower, Shift for bigger steps, Home / End, Enter = the usual width', () => {
    expect(keyWidth('ArrowLeft', false, 420, 1440)).toBe(436);
    expect(keyWidth('ArrowRight', false, 420, 1440)).toBe(404);
    expect(keyWidth('ArrowLeft', true, 420, 1440)).toBe(484);
    expect(keyWidth('ArrowRight', true, 330, 1440)).toBe(320);
    expect(keyWidth('Home', false, 600, 1440)).toBe(PANEL_MIN_W);
    expect(keyWidth('End', false, 600, 1440)).toBe(936);
    expect(keyWidth('Enter', false, 600, 1440)).toBe('reset');
    expect(keyWidth('a', false, 600, 1440)).toBeNull();
    expect(keyWidth('ArrowUp', false, 600, 1440)).toBeNull(); // the separator is vertical
  });

  test('a saved width: whole pixels only; junk or too narrow = the usual width', () => {
    expect(savedPanelWidth('640')).toBe(640);
    expect(savedPanelWidth(null)).toBeNull();
    expect(savedPanelWidth('')).toBeNull();
    expect(savedPanelWidth('abc')).toBeNull();
    expect(savedPanelWidth('640px')).toBeNull();
    expect(savedPanelWidth('-500')).toBeNull();
    expect(savedPanelWidth('12')).toBeNull();
    expect(savedPanelWidth('1e9')).toBeNull();
  });
});

describe('the CSS keeps to the same limits', () => {
  test('base.css: on a wide screen only, --panel-user-w is clamped between the same 320px and 65% of the window', () => {
    const base = css('base.css');
    expect(base).toContain('--panel-w: max(420px, min(26.25rem, 50vw));'); // everywhere else: the usual width, as before
    const wide = base.match(/@media \(min-width: 821px\) \{\s*\.rlt-ui \{\s*--panel-w:\s*([^;]+);/)![1]!;
    expect(wide).toBe(`clamp(${PANEL_MIN_W}px, var(--panel-user-w, max(420px, min(26.25rem, 50vw))), max(${PANEL_MIN_W}px, ${Math.round(PANEL_MAX_SHARE * 100)}vw))`);
    expect(base.match(/--panel-user-w/g)!.length).toBe(2); // the comment and that one rule
  });

  test('the phone held sideways keeps its own width (a dragged desktop width never reaches it); the grip is desktop only', () => {
    expect(css('mobile.css')).toMatch(/orientation: landscape\)\s*\{\s*\.rlt-ui\s*\{\s*--panel-w: min\(400px, 54vw\);/);
    const panel = css('panel.css');
    expect(panel).toMatch(/\.rlt-ui \.panel-resize \{\s*display: none;\s*\}\s*@media \(min-width: 821px\)/);
  });
});
