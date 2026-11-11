// Transient toasts (top center) + a capped history that the Inbox tab lists.
// Read aloud through the announcer (errors assertively, with where to find them again); the stack itself is no
// live region, so a toast is read once, without its Dismiss button. Toasts wait while the pointer or the keyboard
// focus is on them, and ones with an action stay longer: a keyboard user needs time to reach the button.
import { h } from './dom';
import { icon } from './icons';
import type { ToastAction, ToastEntry, ToastLevel } from './shell';

const ICON: Record<ToastLevel, string> = { info: 'sparkle', success: 'checkCircle', warn: 'alert', error: 'xCircle' };
const HISTORY_LIMIT = 80;
const VISIBLE_LIMIT = 4;
/** After the pointer or focus leaves the stack, every toast gets at least this long again. */
const RESUME_MS = 2500;

/** How long a toast stays: longer for warnings and errors, and for any toast with an action to reach. */
export function toastTtl(level: ToastLevel, actionable: boolean): number {
  const base = level === 'error' ? 10_000 : level === 'warn' ? 7000 : 5000;
  return actionable ? Math.max(base, 12_000) : base;
}

export interface Toasts {
  readonly el: HTMLElement;
  readonly history: ToastEntry[];
  /** ttl: ms on screen (default by level); give an undo toast time to be read. record: false → not kept in this
   *  page's history (the server's activity log has it already). */
  show(level: ToastLevel, text: string, opts?: { projectId?: string; agentId?: string; onClick?: () => void; action?: ToastAction; ttl?: number; record?: boolean }): void;
  onChange(fn: () => void): void;
}

export function createToasts(say?: (text: string, level: 'polite' | 'assertive') => void): Toasts {
  // a plain container, not a landmark: an empty "Notifications" region on every page is noise
  const el = h('div', { class: 'toasts' });
  const history: ToastEntry[] = [];
  const listeners: (() => void)[] = [];
  let nextId = 1;
  // Each live toast: when it is due, and its timer (null while the stack is held).
  const live = new Map<HTMLElement, { due: number; timer: ReturnType<typeof setTimeout> | null }>();
  let hovered = false;
  let focused = false;
  const held = () => hovered || focused;

  const dismiss = (node: HTMLElement) => {
    if (node.classList.contains('is-leaving')) return;
    const t = live.get(node);
    if (t?.timer) clearTimeout(t.timer);
    live.delete(node);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 180);
  };
  const arm = (node: HTMLElement, ms: number) => {
    const t = live.get(node);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    t.due = Date.now() + ms;
    t.timer = held() ? null : setTimeout(() => dismiss(node), ms);
  };
  const hold = () => {
    for (const t of live.values()) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
    }
  };
  const resume = () => {
    if (held()) return;
    for (const [node, t] of live) arm(node, Math.max(RESUME_MS, t.due - Date.now()));
  };
  el.addEventListener('pointerenter', () => {
    hovered = true;
    hold();
  });
  el.addEventListener('pointerleave', () => {
    hovered = false;
    resume();
  });
  el.addEventListener('focusin', () => {
    focused = true;
    hold();
  });
  el.addEventListener('focusout', (ev) => {
    if (ev.relatedTarget instanceof Node && el.contains(ev.relatedTarget)) return;
    focused = false;
    resume();
  });

  return {
    el,
    history,
    onChange(fn) {
      listeners.push(fn);
    },
    show(level, text, opts = {}) {
      if (opts.record !== false) {
        const entry: ToastEntry = { id: nextId++, level, text, ts: Date.now(), projectId: opts.projectId, agentId: opts.agentId };
        history.unshift(entry);
        if (history.length > HISTORY_LIMIT) history.pop();
      }
      listeners.forEach((fn) => fn());
      say?.(level === 'error' ? `Error: ${text} (also kept in the Inbox)` : text, level === 'error' ? 'assertive' : 'polite');

      const node = h(
        'div',
        { class: ['toast', 'glass', `toast-${level}`] },
        h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, icon(ICON[level], 16)),
        opts.onClick
          ? h('button', { type: 'button', class: 'toast-text toast-link', onclick: () => { opts.onClick!(); dismiss(node); } }, text)
          : h('span', { class: 'toast-text' }, text),
        opts.action ? h('button', { type: 'button', class: 'toast-action', onclick: () => { opts.action!.run(); dismiss(node); } }, opts.action.label) : null,
        h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: () => dismiss(node) }, icon('x', 14)),
      );
      el.prepend(node);
      while (el.children.length > VISIBLE_LIMIT) {
        const old = el.lastElementChild as HTMLElement | null;
        if (!old) break;
        const t = live.get(old);
        if (t?.timer) clearTimeout(t.timer);
        live.delete(old);
        old.remove();
      }
      live.set(node, { due: 0, timer: null });
      arm(node, opts.ttl ?? toastTtl(level, !!opts.onClick || !!opts.action));
    },
  };
}
