import { h, type Child } from './dom';
import { icon } from './icons';
import type { LayerStack } from './layers';
import { openModal } from './modal';

export interface ConfirmOptions {
  title: string;
  body: Child;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** Icon on the confirm button (danger default: revert). */
  icon?: string;
  /** A third way out, left of Cancel (e.g. "Bring into house first"): closes the dialog unanswered (false), then runs. */
  alt?: { label: string; icon?: string; onSelect(): void };
}

export function confirmDialog(root: HTMLElement, layers: LayerStack, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v: boolean) => {
      if (answered) return;
      answered = true;
      resolve(v);
      modal.close();
    };
    const modal = openModal(root, layers, {
      id: 'confirm',
      className: 'modal-confirm',
      title: opts.title,
      body: h('div', { class: 'confirm-body' }, opts.body),
      // A destructive action never gets the focus: one stray Enter (e.g. the one that picked the menu item) must not
      // confirm it.
      footer: [
        opts.alt
          ? h('button', { type: 'button', class: 'btn btn-soft confirm-alt', onclick: () => (answer(false), opts.alt!.onSelect()) }, opts.alt.icon ? icon(opts.alt.icon, 15) : null, opts.alt.label)
          : null,
        h('button', { type: 'button', class: 'btn btn-ghost', autofocus: opts.tone === 'danger', onclick: () => answer(false) }, opts.cancelLabel ?? 'Cancel'),
        h(
          'button',
          { type: 'button', class: ['btn', opts.tone === 'danger' ? 'btn-danger' : 'btn-primary'], autofocus: opts.tone !== 'danger', onclick: () => answer(true) },
          opts.icon ? icon(opts.icon, 15) : opts.tone === 'danger' ? icon('revert', 15) : null,
          opts.confirmLabel,
        ),
      ],
      onClose: () => {
        if (!answered) {
          answered = true;
          resolve(false);
        }
      },
    });
  });
}
