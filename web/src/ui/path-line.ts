// A folder path on one line that keeps the folder's name in view (finding #85): the start of the path gives way first
// (CSS ellipsis on .path-head), the name (.path-tail) never does. The full path is the tooltip.
import { pathParts } from './display-path';
import { h } from './dom';

export function pathLine(tag: 'p' | 'span', cls: string, path: string, home: string | null | undefined, max: number): HTMLElement {
  const { head, tail } = pathParts(path, home, max);
  // (the head's text in its own <bdi>: a layout that cuts the head from its start — direction: rtl, hud.css — keeps the
  // slashes where they belong)
  return h(tag, { class: [cls, 'path-line'], title: path }, head ? h('span', { class: 'path-head' }, h('bdi', null, head)) : null, h('span', { class: 'path-tail' }, tail));
}
