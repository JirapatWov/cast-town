// People's name tags in the house (CSS2D, people/tag.ts) seen from the default framing: on a phone a room is a few
// hundred pixels wide, so the tags of people standing near each other overlap ("Decoder" on top of "Assistant") and
// a tag near the edge is cut off. A light pass, a few times a second: tags nearest the camera (lowest on screen) keep
// their place, a tag that would overlap one already placed is lifted just above it, and every tag slides inside the
// screen and out from under the floor buttons at the screen's edge. The offset goes on the tag's stack through the CSS
// `translate` property (people/tag.ts eases it), so it never fights the transform CSS2DRenderer writes on the tag
// itself. The homeowner's "You" chip takes part like a tag. layoutTags and clampSideways are pure
// (tests/mobile/tag-layout.test.ts).

/** A tag: where its anchor is on screen (centre x, bottom y: the plate sits on it) and the plate's size. */
export interface TagBox {
  x: number;
  bottom: number;
  w: number;
  h: number;
}

export interface TagOffset {
  dx: number;
  dy: number;
}

/** A screen rectangle (px). */
export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** How far (px) to slide a box `w` wide whose left edge is at `l` and that spans `top`..`bottom` so it stays inside a
 *  screen `viewW` wide and clear of each `avoid` box it would sit under (controls docked at an edge: one in the right
 *  half pushes it left, one in the left half pushes it right). A box wider than the screen keeps its left edge in view. */
export function clampSideways(l: number, w: number, top: number, bottom: number, viewW: number, margin = 6, avoid: readonly Box[] = []): number {
  let lo = margin;
  let hi = viewW - margin;
  for (const a of avoid) {
    if (a.b <= top || a.t >= bottom) continue;
    if ((a.l + a.r) / 2 > viewW / 2) hi = Math.min(hi, a.l - margin);
    else lo = Math.max(lo, a.r + margin);
  }
  if (hi - lo < w) hi = Math.max(hi, lo + w); // no room beside the controls: the screen edge still holds
  let dx = 0;
  if (l + w > hi) dx = hi - (l + w);
  if (l + dx < lo) dx = lo - l;
  return dx;
}

export function layoutTags(tags: TagBox[], view: { w: number; h: number }, gap = 4, margin = 6, avoid: readonly Box[] = []): TagOffset[] {
  const out: TagOffset[] = tags.map(() => ({ dx: 0, dy: 0 }));
  const order = tags.map((_, i) => i).sort((a, b) => tags[b].bottom - tags[a].bottom || tags[a].x - tags[b].x);
  const placed: Box[] = [];
  for (const i of order) {
    const t = tags[i];
    let l = t.x - t.w / 2;
    // inside the screen sideways, clear of the floor buttons (a tag wider than the screen keeps its left edge in view)
    const dx = clampSideways(l, t.w, t.bottom - t.h, t.bottom, view.w, margin, avoid);
    l += dx;
    const r = l + t.w;
    let b = t.bottom;
    // lift above whatever it overlaps, until it overlaps nothing (bounded: each lift clears one placed tag)
    for (let guard = 0; guard <= placed.length; guard++) {
      const hit = placed.find((p) => l < p.r + gap && r > p.l - gap && b - t.h < p.b + gap && b > p.t - gap);
      if (!hit) break;
      b = hit.t - gap;
    }
    placed.push({ l, t: b - t.h, r, b });
    out[i] = { dx: Math.round(dx), dy: Math.round(b - t.bottom) };
  }
  return out;
}

/** One pass over the people's tags in the label layer. */
export function declutterTags(layer: HTMLElement): void {
  const roots = [...layer.querySelectorAll<HTMLElement>('.rlt-pt')].filter((el) => el.style.display !== 'none' && el.isConnected);
  const items: { stack: HTMLElement; box: TagBox }[] = [];
  for (const root of roots) {
    const stack = root.querySelector<HTMLElement>('.rlt-pt__stack');
    const plate = root.querySelector<HTMLElement>('.rlt-pt__plate');
    if (!stack || !plate || !plate.offsetWidth) continue;
    // the root is a 0×0 box CSS2DRenderer puts on the anchor; the stack (bubbles over the plate) stands on it
    const a = root.getBoundingClientRect();
    items.push({ stack, box: { x: a.left, bottom: a.top, w: plate.offsetWidth, h: plate.offsetHeight } });
  }
  // the homeowner's "You" chip (player/marker.ts) while it shows: placed like a tag, so it neither hides under
  // someone's tag nor gets cut off at the edge of a phone's screen (it stands 3 px above its 0×0 root)
  const you = layer.querySelector<HTMLElement>('.rlt-you.is-on');
  const chip = you?.querySelector<HTMLElement>('.rlt-you__chip');
  if (you && chip?.offsetWidth) {
    const a = you.getBoundingClientRect();
    items.push({ stack: chip, box: { x: a.left, bottom: a.top - 3, w: chip.offsetWidth, h: chip.offsetHeight } });
  }
  const avoid = edgeControls();
  const offsets = layoutTags(items.map((it) => it.box), { w: layer.clientWidth || innerWidth, h: layer.clientHeight || innerHeight }, 4, 6, avoid);
  items.forEach((it, i) => {
    const { dx, dy } = offsets[i];
    const next = dx || dy ? `${dx}px ${dy}px` : '';
    if (it.stack.style.translate !== next) it.stack.style.translate = next;
  });
  // a chip that faded out goes back to its place for next time
  const idle = layer.querySelector<HTMLElement>('.rlt-you:not(.is-on) .rlt-you__chip');
  if (idle?.style.translate) idle.style.translate = '';
}

/** The floor buttons docked at the side of the house view (ui/floor-switcher.ts), while they show. */
function edgeControls(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('.rlt-ui .floor-switch')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  return out;
}
