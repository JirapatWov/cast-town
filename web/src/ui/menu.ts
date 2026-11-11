// Anchored popover menu with keyboard navigation (↑/↓/Enter/Esc).
import { h, type Child } from './dom';
import { icon } from './icons';
import type { LayerStack } from './layers';
import { openPopover } from './popover';

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: Child;
  checked?: boolean;
  disabled?: boolean;
  swatch?: string; // color dot
  onSelect(): void;
}
export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

export interface MenuOptions {
  id: string;
  placement?: 'below' | 'above';
  align?: 'start' | 'end' | 'center';
  minWidth?: number;
  footer?: Child;
  className?: string;
  /** Focus the first item on open instead of the checked one: for menus that mix actions with a choice (the job
   *  menu), where Enter right away should do the first action, not re-pick the current choice. */
  focusFirst?: boolean;
  /** The menu's name for screen readers ("Permission mode"). Default: taken from the button that opened it. */
  label?: string;
}

/** A menu's accessible name from its button's: the part before the current value or the action ("Permission mode:
 *  Ask first. Change" → "Permission mode", "More: Town board, search…" → "More", "todo-api: browse files…" →
 *  "todo-api"). A screen reader then says "Permission mode, menu" instead of a bare "menu". */
export function menuName(buttonLabel: string | null | undefined): string {
  const text = (buttonLabel ?? '').replace(/\s+/g, ' ').trim();
  const head = text.split(/: | — |\. /)[0].trim();
  return (head || text).slice(0, 80);
}

export function openMenu(root: HTMLElement, layers: LayerStack, anchor: HTMLElement, sections: MenuSection[], opts: MenuOptions): () => void {
  const buttons: HTMLButtonElement[] = [];
  let close = () => {};

  // The items scroll inside .menu-list and the footer stays below them: a tall menu on a phone (the effort menu with
  // its notes) keeps its footer in view instead of scrolling it out of reach.
  const list = h(
    'div',
    { class: 'menu-list' },
    sections.map((sec) => [
      sec.title ? h('div', { class: 'menu-section' }, sec.title) : null,
      sec.items.map((item) => {
        const btn = h(
          'button',
          {
            type: 'button',
            class: ['menu-item', item.checked && 'is-checked'],
            role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
            'aria-checked': item.checked === undefined ? undefined : String(item.checked),
            disabled: item.disabled,
            onclick: () => {
              close();
              item.onSelect();
            },
          },
          item.swatch ? h('span', { class: 'swatch', style: { background: item.swatch } }) : item.icon ? icon(item.icon, 15) : null,
          h('span', { class: 'menu-label' }, item.label),
          item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
          item.checked ? icon('check', 15, 'menu-check') : null,
        );
        buttons.push(btn);
        return btn;
      }),
    ]),
  );
  const el = h(
    'div',
    { class: ['menu', 'glass-strong', opts.className], role: 'menu', 'aria-label': opts.label ?? (menuName(anchor.getAttribute('aria-label') ?? anchor.textContent) || undefined), style: { minWidth: `min(${(opts.minWidth ?? 200) / 16}rem, calc(100vw - 16px))` } },
    list,
    opts.footer ? h('div', { class: 'menu-foot' }, opts.footer) : null,
  );
  // never taller than the room on the side it opens to (it would cover its own anchor, or run off the screen)
  const r = anchor.getBoundingClientRect();
  const room = opts.placement === 'above' ? r.top - 16 : opts.placement === 'below' ? window.innerHeight - r.bottom - 16 : Math.max(r.top, window.innerHeight - r.bottom) - 16;
  if (room > 120) el.style.maxHeight = `min(64vh, ${Math.round(room)}px)`;

  el.addEventListener('keydown', (ev) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      enabled[(i + 1) % enabled.length]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    } else if (ev.key === 'Tab') {
      close(); // focus goes back to the anchor first, so Tab moves on from there
    }
  });

  close = openPopover(root, layers, anchor, el, { id: opts.id, placement: opts.placement, align: opts.align });
  ((opts.focusFirst ? undefined : buttons.find((b) => b.classList.contains('is-checked'))) ?? buttons.find((b) => !b.disabled))?.focus({ preventScroll: true });
  return close;
}
