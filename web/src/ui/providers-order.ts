// Account order: which signed-in account omp prefers, per provider (Claude, ChatGPT, Google sign-ins). One copy per
// page, shared by the chat's account chip and Models & providers. get_account_order answers at once (limits from the
// last usage report); fresh limits and every change (a save here or in another tab, a sign-in, a sign-out) arrive as
// 'account_order' pushes. Saving a provider's order makes EVERY chat drop its own pick of that provider (server rule).
// Also the order editor both places use: drag a row by its grip, or ↑/↓ (buttons, or arrow keys on the grip).
import type { AccountOrder, OrderedAccount, ProviderAccountOrder, ServerMsg, UsageLimit } from '../../../shared/protocol';
import type { Store } from '../core/types';
import { append, h, setChildren } from './dom';
import { icon } from './icons';
import { accountName, fmtPct, usageLevel, usedPct, type UsageLevel } from './usage-text';

// ───────────────────────── Pure helpers (unit-tested) ─────────────────────────

/** omp login provider → what people call it. */
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  'google-gemini-cli': 'Gemini',
  'google-antigravity': 'Antigravity',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
};
export const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;

/** The ids of a provider's accounts, preferred first. */
export const orderIds = (p: Pick<ProviderAccountOrder, 'accounts'>): number[] => p.accounts.map((a) => a.credentialId);

export const sameIds = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** ids with the one at `from` moved to `to` (clamped); a copy. */
export function moveId(ids: readonly number[], from: number, to: number): number[] {
  const out = [...ids];
  if (from < 0 || from >= out.length) return out;
  const dest = Math.max(0, Math.min(out.length - 1, to));
  const [x] = out.splice(from, 1);
  out.splice(dest, 0, x);
  return out;
}

/** A draft order kept across a fresh list: its accounts that are still signed in, in its order, then the ones signed in
 *  since (in the list's order). null → nothing left to change (no draft, or it says what the list says). */
export function reconcileDraft(draft: readonly number[] | null, ids: readonly number[]): number[] | null {
  if (!draft) return null;
  const kept = draft.filter((id) => ids.includes(id));
  const next = [...kept, ...ids.filter((id) => !kept.includes(id))];
  return sameIds(next, ids) ? null : next;
}

const emailOf = (label: string): string | undefined => /[^\s()<>@]+@[^\s()<>]+/.exec(label)?.[0];

/** Short names that still tell a provider's accounts apart: the email's name part ("alice"), else the whole email,
 *  else "email · org" (one person in two orgs), else the label. */
export function shortNames(accounts: readonly Pick<OrderedAccount, 'credentialId' | 'label'>[]): Map<number, string> {
  const tiers = (label: string): string[] => {
    const email = emailOf(label);
    const full = accountName(label);
    return email ? [email.split('@')[0], email, full, `${full} #`] : [full, `${full} #`];
  };
  const out = new Map<number, string>();
  const options = accounts.map((a) => tiers(a.label));
  for (let i = 0; i < accounts.length; i++) {
    let pick = options[i][options[i].length - 1];
    for (let t = 0; t < options[i].length - 1; t++) {
      const name = options[i][t];
      if (!options.some((o, j) => j !== i && o[Math.min(t, o.length - 1)].toLowerCase() === name.toLowerCase())) {
        pick = name;
        break;
      }
    }
    out.set(accounts[i].credentialId, pick.endsWith(' #') ? `${pick}${accounts[i].credentialId}` : pick);
  }
  return out;
}

/** The limit with the most used (the one that decides when omp moves on); undefined when none says how much. */
export function tightestLimit(limits: readonly UsageLimit[] | undefined): UsageLimit | undefined {
  let best: UsageLimit | undefined;
  let bestPct = -Infinity;
  for (const l of limits ?? []) {
    const pct = usedPct(l);
    if (pct !== null && pct > bestPct) [best, bestPct] = [l, pct];
  }
  return best;
}

/** "5 Hour" → "5h", "7 Day (Fable)" → "7d (Fable)". */
export function windowShort(label: string): string {
  return label
    .replace(/(\d+)\s*hours?\b/i, '$1h')
    .replace(/(\d+)\s*days?\b/i, '$1d')
    .replace(/(\d+)\s*weeks?\b/i, '$1w')
    .replace(/(\d+)\s*months?\b/i, '$1mo')
    .trim();
}

/** "5h 38% used" for an account's most-used limit, with its colour level; null when unknown. */
export function limitBrief(limits: readonly UsageLimit[] | undefined): { text: string; level: UsageLevel } | null {
  const l = tightestLimit(limits);
  if (!l) return null;
  return { text: `${windowShort(l.window ?? l.label)} ${fmtPct(usedPct(l)!)} used`, level: usageLevel(l) };
}

// ───────────────────────── The page's copy ─────────────────────────

/** A cached order older than this is read again when a menu or the page opens (the server then checks usage again). */
const FRESH_MS = 60_000;

export interface AccountOrderClient {
  readonly order: AccountOrder | null;
  /** Why the last read failed (the order on screen, if any, is the one before). */
  readonly error: string | null;
  readonly loading: boolean;
  provider(id: string): ProviderAccountOrder | undefined;
  /** Read it when it was never read, is older than a minute, or force (the server then also checks usage again). */
  ensure(force?: boolean): Promise<void>;
  /** set_account_order: resolves with the new order (also pushed to every tab); rejects with why. */
  save(provider: string, ids: number[]): Promise<AccountOrder>;
  /** Called after every change of order / error / loading. */
  subscribe(fn: () => void): () => void;
}

const clients = new WeakMap<Store, AccountOrderClient>();

export function accountOrder(store: Store): AccountOrderClient {
  const known = clients.get(store);
  if (known) return known;
  let order: AccountOrder | null = null;
  let error: string | null = null;
  let at = 0; // when `order` was last answered or pushed
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[account-order] listener threw', err);
      }
    }
  };
  const take = (next: AccountOrder | undefined) => {
    if (!next) return;
    order = next;
    error = next.error ?? null;
    at = Date.now();
  };

  store.subscribe((_s, msg?: ServerMsg) => {
    if (!msg) return;
    if (msg.t === 'account_order') {
      take(msg.order);
      notify();
    } else if (msg.t === 'snapshot' && order) {
      at = 0; // reconnected: what changed meanwhile is unknown — read again on the next look
    }
  });

  async function read(force: boolean): Promise<void> {
    try {
      const res = await store.request<{ order?: AccountOrder } | undefined>({ t: 'get_account_order', reqId: '', ...(force ? { force: true } : {}) });
      take(res?.order);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const client: AccountOrderClient = {
    get order() {
      return order;
    },
    get error() {
      return error;
    },
    get loading() {
      return !!inflight;
    },
    provider: (id) => order?.providers.find((p) => p.provider === id),
    ensure(force = false) {
      if (inflight) return inflight;
      if (!force && order && Date.now() - at < FRESH_MS) return Promise.resolve();
      inflight = read(force).finally(() => {
        inflight = null;
        notify();
      });
      notify();
      return inflight;
    },
    async save(provider, ids) {
      const res = await store.request<{ order?: AccountOrder } | undefined>({ t: 'set_account_order', reqId: '', provider, credentialIds: ids });
      if (res?.order) {
        take(res.order);
        notify();
      }
      return res?.order ?? order ?? { providers: [] };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  clients.set(store, client);
  return client;
}

// ───────────────────────── The order editor ─────────────────────────

/** Six dots: the drag handle (the icon set's "grip" is the sheet handle, a single bar). */
function dragDots(): SVGSVGElement {
  const tpl = document.createElement('template');
  const dots = [7, 12, 17].flatMap((y) => [9, 15].map((x) => `<circle cx="${x}" cy="${y}" r="1.5"/>`)).join('');
  tpl.innerHTML = `<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">${dots}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

export interface OrderEditorOptions {
  provider: string;
  client: AccountOrderClient;
  /** People whose current chat picked its own account of this provider (they follow the new order once it's saved). */
  ownPicks(): number;
  /** Saved (the new order) or Cancel pressed. */
  onDone?(saved: AccountOrder | null): void;
  onError(text: string): void;
  /** Show Cancel even with nothing changed (the chat menu: back to the chat's own choice). */
  cancelable?: boolean;
  /** Each row's tightest limit (default true; Models & providers lists them with the accounts already). */
  limits?: boolean;
  /** A drag ended: whoever holds the editor may redraw around it again (moving it mid-drag would drop the drag). */
  onDragEnd?(): void;
}

export interface OrderEditor {
  readonly el: HTMLElement;
  /** Draw again from the client's copy (keeps a draft; waits while a row is being dragged). */
  update(): void;
  readonly dirty: boolean;
  /** A row is being dragged: don't move the editor in the page until onDragEnd. */
  readonly dragging: boolean;
}

/** One provider's order as a list to rearrange, with Save (for every chat) once it differs from the saved one. */
export function createOrderEditor(opts: OrderEditorOptions): OrderEditor {
  let draft: number[] | null = null;
  let saving = false;
  let dragging = false;
  let owed = false;
  let focusAfter: { id: number; part: string } | null = null;
  const el = h('div', { class: 'ord' });
  const list = h('ol', { class: 'ord-list', 'aria-label': `${providerLabel(opts.provider)} accounts, preferred first` });
  const foot = h('div', { class: 'ord-foot' });
  el.append(list, foot);

  const current = (): ProviderAccountOrder | undefined => opts.client.provider(opts.provider);
  const ids = (): number[] => {
    const p = current();
    return p ? (draft ?? orderIds(p)) : [];
  };

  function move(id: number, to: number, part: string) {
    const p = current();
    if (!p || saving) return;
    const base = orderIds(p);
    const now = draft ?? base;
    const next = moveId(now, now.indexOf(id), to);
    draft = sameIds(next, base) ? null : next;
    focusAfter = { id, part };
    render();
  }

  /** Save is offered for a changed order, for omp's own order (nothing saved yet: saving makes it the global one) and,
   *  in a chat's menu, for the saved order as it is: saving again is how every chat drops its own pick ("set the
   *  global order" must work without moving anything). */
  const canSave = (p: ProviderAccountOrder): boolean => !!draft || !p.saved || !!opts.cancelable;

  async function save() {
    const p = current();
    if (!p || !canSave(p) || saving) return;
    const ids = draft ?? orderIds(p);
    saving = true;
    render();
    try {
      const order = await opts.client.save(opts.provider, ids);
      draft = null;
      opts.onDone?.(order);
    } catch (err) {
      opts.onError(`Couldn’t save the ${providerLabel(opts.provider)} order: ${(err as Error).message}`);
    } finally {
      saving = false;
      render();
    }
  }

  function startDrag(ev: PointerEvent, row: HTMLElement, id: number) {
    if (saving || ev.button !== 0) return;
    ev.preventDefault();
    const rows = [...list.querySelectorAll<HTMLElement>('.ord-row')];
    const from = rows.indexOf(row);
    if (from < 0 || rows.length < 2) return;
    const grip = ev.currentTarget as HTMLElement;
    grip.setPointerCapture(ev.pointerId);
    const tops = rows.map((r) => r.offsetTop);
    const step = rows.length > 1 ? tops[1] - tops[0] : row.offsetHeight;
    const startY = ev.clientY;
    let to = from;
    dragging = true;
    row.classList.add('is-dragging');
    const onMove = (e: PointerEvent) => {
      const dy = Math.max(tops[0] - tops[from], Math.min(tops[rows.length - 1] - tops[from], e.clientY - startY));
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = from < to && i > from && i <= to ? -step : from > to && i < from && i >= to ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      dragging = false;
      for (const r of rows) r.style.transform = '';
      row.classList.remove('is-dragging');
      if (to !== from) move(id, to, 'grip');
      else if (owed) render();
      opts.onDragEnd?.();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  }

  function row(a: OrderedAccount, i: number, n: number, name: string, p: ProviderAccountOrder): HTMLElement {
    const lim = opts.limits === false ? null : limitBrief(a.limits);
    const full = accountName(a.label);
    const r: HTMLElement = h('li', { class: 'ord-row', 'data-id': String(a.credentialId) });
    const grip = h(
      'button',
      {
        type: 'button',
        class: 'ord-grip',
        'data-part': 'grip',
        disabled: saving || n < 2,
        title: 'Drag to move — or use the arrow keys',
        'aria-label': `${name}, number ${i + 1} of ${n}. Arrow keys move it.`,
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          e.stopPropagation(); // not the menu's own ↑/↓
          move(a.credentialId, i + (e.key === 'ArrowUp' ? -1 : 1), 'grip');
        },
        onpointerdown: (e: PointerEvent) => startDrag(e, r, a.credentialId),
      },
      dragDots(),
    );
    const btn = (part: 'up' | 'down') =>
      h(
        'button',
        {
          type: 'button',
          class: 'ord-move',
          'data-part': part,
          disabled: saving || (part === 'up' ? i === 0 : i === n - 1),
          'aria-label': `Move ${name} ${part}`,
          title: part === 'up' ? 'Move up' : 'Move down',
          onclick: () => move(a.credentialId, i + (part === 'up' ? -1 : 1), part),
        },
        icon(part === 'up' ? 'arrowUp' : 'arrowDown', 13),
      );
    append(r, [
      grip,
      h('span', { class: 'ord-rank num', 'aria-hidden': 'true' }, String(i + 1)),
      h(
        'span',
        { class: 'ord-who' },
        h('span', { class: 'ord-name', title: full }, name),
        h(
          'span',
          { class: 'ord-sub' },
          [
            name !== full ? full : null,
            p.saved && !a.placed && !draft ? 'signed in after the order was saved' : null,
            a.inUse ? `${a.inUse} ${a.inUse === 1 ? 'chat' : 'chats'} on it now` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      // always there (empty when unknown), so the ↑ ↓ buttons line up from row to row
      h(
        'span',
        { class: ['ord-lim', lim && `is-${lim.level}`], title: lim ? (a.stale ? 'The last limits it reported — this account couldn’t be checked just now' : 'Its most-used limit') : undefined },
        lim ? (a.stale ? `~${lim.text}` : lim.text) : '',
      ),
      btn('up'),
      btn('down'),
    ]);
    return r;
  }

  function render() {
    if (dragging) {
      owed = true;
      return;
    }
    owed = false;
    const p = current();
    draft = p ? reconcileDraft(draft, orderIds(p)) : draft;
    const hadFocus = el.contains(document.activeElement);
    const focusedRow = hadFocus ? (document.activeElement as HTMLElement).closest<HTMLElement>('.ord-row') : null;
    const want =
      focusAfter ?? (focusedRow ? { id: Number(focusedRow.dataset.id), part: (document.activeElement as HTMLElement).dataset.part ?? 'grip' } : null);
    focusAfter = null;
    if (!p) {
      setChildren(list);
      setChildren(foot, h('p', { class: 'ord-note' }, opts.client.loading ? 'Checking accounts…' : 'No signed-in accounts to put in order.'));
      return;
    }
    const byId = new Map(p.accounts.map((a) => [a.credentialId, a]));
    const shown = ids().map((id) => byId.get(id)).filter((a): a is OrderedAccount => !!a);
    const names = shortNames(p.accounts);
    setChildren(list, shown.map((a, i) => row(a, i, shown.length, names.get(a.credentialId) ?? a.label, p)));
    el.classList.toggle('is-dirty', !!draft);
    const savable = canSave(p);
    // Saving the saved order unchanged only re-applies it (every chat drops its own pick); else it sets a new order.
    const reapply = savable && !draft && p.saved;
    const picks = savable ? opts.ownPicks() : 0;
    const label = providerLabel(opts.provider);
    setChildren(
      foot,
      draft || (savable && !p.saved) || (reapply && picks > 0)
        ? h(
            'p',
            { class: 'ord-note is-warn', role: 'status' },
            icon('alert', 13),
            h(
              'span',
              null,
              reapply
                ? `Every chat follows this order unless it picked its own account. Applying it again makes chats that picked their own ${label} account drop that pick — until you pick one again in that chat.`
                : `Saving applies to every chat right away: chats that picked their own ${label} account drop that pick and follow this order — until you pick one again in that chat.`,
              picks ? (picks === 1 ? ' 1 chat has its own pick now.' : ` ${picks} chats have their own pick now.`) : '',
            ),
          )
        : h(
            'p',
            { class: 'ord-note' },
            p.saved ? 'Every chat follows this order unless it picked its own account.' : 'No order saved: the default (first signed in first).',
          ),
      draft || opts.cancelable || savable
        ? h(
            'div',
            { class: 'ord-actions' },
            draft || opts.cancelable
              ? h(
                  'button',
                  { type: 'button', class: 'btn btn-ghost btn-sm', disabled: saving, onclick: () => ((draft = null), render(), opts.onDone?.(null)) },
                  draft ? 'Cancel' : 'Back',
                )
              : null,
            savable
              ? h(
                  'button',
                  { type: 'button', class: ['btn', 'btn-sm', 'ord-save', draft || !p.saved ? 'btn-primary' : 'btn-ghost'], disabled: saving, onclick: () => void save() },
                  saving ? h('span', { class: 'spinner spinner-sm' }) : icon('check', 14),
                  saving ? 'Saving…' : reapply ? 'Apply to all chats' : 'Save for all chats',
                )
              : null,
          )
        : null,
    );
    if (want) {
      const r = list.querySelector<HTMLElement>(`.ord-row[data-id="${want.id}"]`);
      const target = r?.querySelector<HTMLButtonElement>(`[data-part="${want.part}"]:not(:disabled)`) ?? r?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  }

  render();
  return {
    el,
    update: render,
    get dirty() {
      return !!draft;
    },
    get dragging() {
      return dragging;
    },
  };
}
