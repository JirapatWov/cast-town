// Dialog shell: backdrop, focus trap, Esc via the layer stack, focus restore.
import { h, type Child } from './dom';
import { markFocus, restoreFocus } from './focus';
import { icon } from './icons';
import { focusFirst, trapFocus, type LayerStack } from './layers';

export interface ModalOptions {
  id: string;
  title?: string;
  subtitle?: Child;
  className?: string;
  body: Child;
  footer?: Child;
  headerExtra?: Child;
  onClose?: () => void;
  /** Click on the backdrop closes the dialog (default true). */
  dismissible?: boolean;
}

export interface ModalHandle {
  readonly el: HTMLElement;
  readonly dialog: HTMLElement;
  close(): void;
}

export function openModal(root: HTMLElement, layers: LayerStack, opts: ModalOptions): ModalHandle {
  // The opener, or its re-rendered copy, gets focus back on close (the action bar or a list may have re-rendered).
  const opener = markFocus();
  const titleId = `${opts.id}-title`;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    removeLayer();
    untrap();
    backdrop.classList.add('is-leaving');
    setTimeout(() => backdrop.remove(), 160);
    opts.onClose?.();
    // A dialog that opened another one on close (the onClose above) keeps the focus it gave.
    if (!document.activeElement || document.activeElement === document.body || backdrop.contains(document.activeElement)) restoreFocus(opener);
  };

  const header = opts.title
    ? h(
        'header',
        { class: 'modal-head' },
        h('div', { class: 'modal-titles' }, h('h2', { id: titleId, class: 'modal-title' }, opts.title), opts.subtitle ? h('p', { class: 'modal-sub' }, opts.subtitle) : null),
        opts.headerExtra ?? null,
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x', 18)),
      )
    : null;

  const dialog = h(
    'div',
    {
      class: ['modal', 'glass-strong', opts.className],
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': opts.title ? titleId : undefined,
    },
    header,
    h('div', { class: 'modal-body' }, opts.body),
    opts.footer ? h('footer', { class: 'modal-foot' }, opts.footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('pointerdown', (ev) => {
    if (ev.target === backdrop && opts.dismissible !== false) close();
  });

  root.appendChild(backdrop);
  const removeLayer = layers.push({ id: opts.id, close, modal: true });
  const untrap = trapFocus(dialog);
  requestAnimationFrame(() => focusFirst(dialog));

  return { el: backdrop, dialog, close };
}
