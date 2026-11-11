// People's name tags in the house (web/src/house/tag-layout.ts): tags that would overlap are lifted above the one
// nearer the camera, and every tag stays inside the screen. Run: bun test tests/mobile
import { describe, expect, test } from 'bun:test';
import { clampSideways, layoutTags, type TagBox } from '../../web/src/house/tag-layout';

const view = { w: 390, h: 664 };
const rect = (t: TagBox, o: { dx: number; dy: number }) => ({ l: t.x - t.w / 2 + o.dx, r: t.x + t.w / 2 + o.dx, t: t.bottom - t.h + o.dy, b: t.bottom + o.dy });
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

describe('layoutTags', () => {
  test('tags apart from each other stay where they are', () => {
    const tags: TagBox[] = [
      { x: 100, bottom: 300, w: 90, h: 26 },
      { x: 260, bottom: 320, w: 90, h: 26 },
    ];
    expect(layoutTags(tags, view)).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });

  test('the tag farther away (higher on screen) is lifted above the nearer one', () => {
    const tags: TagBox[] = [
      { x: 200, bottom: 300, w: 100, h: 26 }, // farther
      { x: 220, bottom: 310, w: 100, h: 26 }, // nearer: keeps its place
    ];
    const out = layoutTags(tags, view, 4);
    expect(out[1]).toEqual({ dx: 0, dy: 0 });
    expect(out[0].dy).toBeLessThan(0);
    expect(overlaps(rect(tags[0], out[0]), rect(tags[1], out[1]))).toBe(false);
    // just above it, not far away: bottom of the lifted tag = top of the nearer one - gap
    expect(tags[0].bottom + out[0].dy).toBe(310 - 26 - 4);
  });

  test('a crowd ends up as a stack with no overlaps', () => {
    const tags: TagBox[] = Array.from({ length: 5 }, (_, i) => ({ x: 190 + i * 6, bottom: 400 - i * 3, w: 110, h: 24 }));
    const out = layoutTags(tags, view);
    const rects = tags.map((t, i) => rect(t, out[i]));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
  });

  test('a tag at the edge slides inside the screen', () => {
    const tags: TagBox[] = [
      { x: 10, bottom: 200, w: 120, h: 26 },
      { x: 385, bottom: 260, w: 120, h: 26 },
    ];
    const out = layoutTags(tags, view, 4, 6);
    expect(rect(tags[0], out[0]).l).toBe(6);
    expect(rect(tags[1], out[1]).r).toBe(390 - 6);
  });

  test('a tag wider than the screen keeps its left edge in view', () => {
    const out = layoutTags([{ x: 200, bottom: 200, w: 500, h: 26 }], view, 4, 6);
    expect(200 - 250 + out[0].dx).toBe(6);
  });

  test('offsets are whole pixels and the input order is kept', () => {
    const tags: TagBox[] = [
      { x: 100.4, bottom: 300.2, w: 80.6, h: 25.5 },
      { x: 110.7, bottom: 305.9, w: 80.6, h: 25.5 },
    ];
    const out = layoutTags(tags, view);
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(Number.isInteger(o.dx)).toBe(true);
      expect(Number.isInteger(o.dy)).toBe(true);
    }
    expect(out[1].dy).toBe(0);
  });
});

describe('clear of the floor buttons', () => {
  // the floor buttons dock at the right edge of a 320 px phone, from y 115 to 220
  const dock = { l: 256, t: 115, r: 314, b: 220 };
  const se = { w: 320, h: 568 };

  test('a tag beside the floor buttons slides left of them', () => {
    const tags: TagBox[] = [{ x: 250, bottom: 225, w: 90, h: 24 }];
    const out = layoutTags(tags, se, 4, 6, [dock]);
    expect(rect(tags[0], out[0]).r).toBe(256 - 6);
  });

  test('a tag above or below them keeps the whole width', () => {
    const tags: TagBox[] = [{ x: 280, bottom: 300, w: 60, h: 24 }];
    expect(layoutTags(tags, se, 4, 6, [dock])).toEqual([{ dx: 0, dy: 0 }]);
  });

  test('controls at the left edge push to the right', () => {
    expect(clampSideways(2, 40, 100, 120, 320, 6, [{ l: 0, t: 90, r: 60, b: 200 }])).toBe(66 - 2);
  });

  test('with no room beside the controls the screen edge still holds', () => {
    expect(clampSideways(10, 300, 100, 120, 320, 6, [dock])).toBe(-4);
  });

  test('the You chip cut off at the left slides back in', () => {
    expect(clampSideways(-12, 36, 230, 250, 320)).toBe(18);
  });
});
