// The account chip under the chat box: which signed-in account (Claude, ChatGPT, Google) this chat runs on. Shown when
// the chat's provider has two or more sign-ins (or the chat picked one). Its menu, without leaving the chat:
//  · this chat's own account — picking one moves only this chat (the global order no longer moves it);
//  · "Follow the global order" — drop the pick;
//  · "Set the global order…" — rearrange the provider's accounts right there. Saving applies to EVERY chat: the ones
//    that picked their own account drop it and follow the new order, until they pick again in their own chat.
import type { AgentInfo, ChatAccount, OrderedAccount, ProviderAccountOrder } from '../../../shared/protocol';
import { h, setChildren, type Child } from './dom';
import { icon } from './icons';
import { openPopover } from './popover';
import { accountOrder, createOrderEditor, limitBrief, providerLabel, shortNames, type OrderEditor } from './providers-order';
import type { Shell } from './shell';
import { accountName } from './usage-text';

/** set_chat_account on the wire, per person: the account asked for (null: back to the order). */
const asking = new Map<string, number | null>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Redraw the chips when the order (names, limits) or a pick on the wire changes. Returns the unsubscribe. */
export function watchAccountChips(shell: Shell, fn: () => void): () => void {
  const off = accountOrder(shell.store).subscribe(fn);
  listeners.add(fn);
  return () => {
    off();
    listeners.delete(fn);
  };
}

/** People whose current chat picked its own account of this provider. */
function ownPicks(shell: Shell, provider: string): number {
  return Object.values(shell.store.state.agents).filter((x) => x.account?.provider === provider && x.account.pinned).length;
}

/** The short name of the chat's account ("alice"), told apart from the provider's other accounts when the order is known. */
function nameOf(acc: ChatAccount, p: ProviderAccountOrder | undefined): string {
  if (acc.credentialId === null) return 'By order';
  const known = p?.accounts.some((x) => x.credentialId === acc.credentialId);
  const list = known ? p!.accounts : [{ credentialId: acc.credentialId, label: acc.label }];
  return shortNames(list).get(acc.credentialId) ?? acc.label;
}

/** What redraws the chip (chat-tab memo). */
export function accountChipKey(shell: Shell, a: AgentInfo | undefined): unknown {
  if (!a?.account) return null;
  const p = accountOrder(shell.store).provider(a.account.provider);
  const mine = p?.accounts.find((x) => x.credentialId === a.account!.credentialId);
  return [a.id, a.threadId, a.account, p?.accounts.map((x) => [x.credentialId, x.label]), limitBrief(mine?.limits), asking.has(a.id) ? asking.get(a.id) : 'idle'];
}

export function accountChip(shell: Shell, a: AgentInfo): HTMLElement | null {
  const acc = a.account;
  // shown with one account too: its menu is where another account gets added
  if (!acc) return null;
  const client = accountOrder(shell.store);
  // names that tell the accounts apart, and limits: read once (after this render — ensure() notifies the chips)
  if (!client.order && !client.loading && !client.error) queueMicrotask(() => void client.ensure());
  const p = client.provider(acc.provider);
  const mine = p?.accounts.find((x) => x.credentialId === acc.credentialId);
  const lim = limitBrief(mine?.limits);
  const name = nameOf(acc, p);
  const busy = asking.has(a.id);
  const full = acc.credentialId === null ? '' : accountName(acc.label);
  const state = acc.pinned ? 'this chat’s own pick' : 'follows the global order';
  const title =
    acc.credentialId === null
      ? `${providerLabel(acc.provider)} account: picked by the global order (Models & providers) when the chat next runs`
      : `${providerLabel(acc.provider)} account: ${full} — ${state}${acc.pending ? ' (switches after this turn)' : ''}${lim ? ` · ${lim.text}` : ''}`;
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: ['perm-chip', 'chip-account', acc.pinned && 'is-pinned', lim && lim.level !== 'ok' && `is-${lim.level}`],
      'data-chip': 'account',
      title,
      'aria-label': `${title}. Change`,
      'aria-haspopup': 'dialog',
      onclick: () => openAccountMenu(shell, a.id, chip),
    },
    busy ? h('span', { class: 'spinner spinner-sm' }) : icon(acc.pending ? 'clock' : acc.pinned ? 'pin' : 'layers', 12),
    h('span', { class: 'chip-label' }, name),
    icon('chevronUp', 11),
  );
  return chip;
}

let openClose: (() => void) | null = null;

/** The account menu of a person's current chat. */
export function openAccountMenu(shell: Shell, agentId: string, anchor: HTMLElement): void {
  if (openClose && shell.layers.has('chip-account')) {
    openClose();
    return;
  }
  const { store } = shell;
  const client = accountOrder(store);
  const start = store.state.agents[agentId]?.account;
  if (!start) return;
  const provider = start.provider;
  const plabel = providerLabel(provider);
  let view: 'chat' | 'order' = 'chat';
  let saved = false;
  let editor: OrderEditor | null = null;
  const pop = h('div', { class: ['menu', 'glass-strong', 'perm-menu', 'acct-menu'], role: 'dialog', 'aria-label': `${plabel} account for this chat` });

  const person = (): AgentInfo | undefined => store.state.agents[agentId];

  async function pick(credentialId: number | null, label: string) {
    const a = person();
    if (!a?.account) return;
    close();
    asking.set(agentId, credentialId);
    changed();
    try {
      const res = await store.request<{ pending?: boolean } | undefined>({
        t: 'set_chat_account',
        reqId: '',
        agentId,
        ...(a.threadId ? { threadId: a.threadId } : {}),
        provider,
        credentialId,
      });
      if (res?.pending)
        shell.toast(
          'info',
          credentialId === null
            ? `${a.name}’s chat follows the global ${plabel} order again — from the end of this turn.`
            : `${a.name}’s chat moves to ${label} when this turn ends.`,
          { agentId },
        );
    } catch (err) {
      shell.toast('error', `Couldn’t change the account: ${(err as Error).message}`, { agentId });
    } finally {
      asking.delete(agentId);
      changed();
    }
  }

  function choice(opts: { label: string; hint: Child; icon: string; checked: boolean; onSelect(): void }): HTMLElement {
    return h(
      'button',
      {
        type: 'button',
        class: ['menu-item', 'acct-choice', opts.checked && 'is-checked'],
        role: 'menuitemradio',
        'aria-checked': String(opts.checked),
        onclick: opts.onSelect,
      },
      icon(opts.icon, 15),
      h('span', { class: 'menu-label' }, opts.label),
      h('span', { class: 'menu-hint' }, opts.hint),
      opts.checked ? icon('check', 15, 'menu-check') : null,
    );
  }

  function chatView(a: AgentInfo, acc: ChatAccount): Child[] {
    const p = client.provider(provider);
    const accounts: OrderedAccount[] = p?.accounts ?? (acc.credentialId !== null ? [{ credentialId: acc.credentialId, label: acc.label, placed: false, inUse: 0 }] : []);
    const names = shortNames(accounts);
    const cur = acc.credentialId;
    const curName = cur === null ? '' : (names.get(cur) ?? acc.label);
    const rank = p ? accounts.map((x) => names.get(x.credentialId) ?? x.label) : [];
    return [
      h('div', { class: 'menu-section' }, `${plabel} account for this chat`),
      choice({
        label: 'Follow the global order',
        icon: 'layers',
        hint: acc.pinned
          ? 'Drop this chat’s own pick'
          : cur === null
            ? 'The first account that isn’t at a limit is used when the chat next runs'
            : `Now on ${curName}${acc.pending ? ' — switching after this turn' : ''}`,
        checked: !acc.pinned,
        onSelect: () => (acc.pinned ? void pick(null, '') : close()),
      }),
      ...accounts.map((x) => {
        const lim = limitBrief(x.limits);
        const n = names.get(x.credentialId) ?? x.label;
        const full = accountName(x.label);
        const parts: Child[] = [
          n !== full ? full : null,
          lim ? h('span', { class: `is-${lim.level}` }, `${x.stale ? '~' : ''}${lim.text}`) : null,
          x.credentialId === cur && acc.pending ? 'switching after this turn' : null,
        ].filter(Boolean);
        return choice({
          label: n,
          icon: acc.pinned && x.credentialId === cur ? 'pin' : 'users',
          hint: parts.length ? parts.flatMap((part, i) => (i ? [' · ', part] : [part])) : 'Only this chat',
          checked: acc.pinned && x.credentialId === cur,
          onSelect: () => (acc.pinned && x.credentialId === cur ? close() : void pick(x.credentialId, n)),
        });
      }),
      !p && client.loading ? h('p', { class: 'acct-menu-note' }, h('span', { class: 'spinner spinner-sm' }), `Checking ${plabel} accounts…`) : null,
      !p && !client.loading && client.error
        ? h('p', { class: 'acct-menu-note is-err' }, `Couldn’t list the accounts: ${client.error} `, h('button', { type: 'button', class: 'link-btn', onclick: () => void client.ensure(true) }, 'Retry'))
        : null,
      h('div', { class: 'menu-section' }, 'Global order · every chat'),
      saved ? h('p', { class: 'acct-menu-note is-ok', role: 'status' }, icon('checkCircle', 13), 'Saved — every chat follows this order now.') : null,
      p
        ? h('p', { class: 'acct-order-sum' }, rank.map((n, i) => h('span', null, h('b', { class: 'num' }, String(i + 1)), ' ', n)), p.saved ? null : h('span', { class: 'muted' }, '(default order: first signed in first)'))
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'menu-item acct-set-order',
          role: 'menuitem',
          disabled: !p || p.accounts.length < 2,
          onclick: () => {
            view = 'order';
            saved = false;
            render();
            pop.querySelector<HTMLElement>('.ord-grip:not(:disabled)')?.focus({ preventScroll: true });
          },
        },
        icon('pencil', 15),
        h('span', { class: 'menu-label' }, 'Set the global order…'),
        h('span', { class: 'menu-hint' }, 'Applies to every chat — and clears their own picks'),
      ),
      h(
        'button',
        { type: 'button', class: 'menu-item acct-add', role: 'menuitem', onclick: () => (close(), shell.openProviders()) },
        icon('plus', 15),
        h('span', { class: 'menu-label' }, `Add another ${plabel} account…`),
        h('span', { class: 'menu-hint' }, 'Sign in under Models & providers'),
      ),
      h('div', { class: 'menu-foot' }, 'Picking an account here moves only this chat. An account that is out of quota (or can’t report its usage) may still be skipped.'),
    ];
  }

  function orderView(): Child[] {
    editor ??= createOrderEditor({
      provider,
      client,
      cancelable: true,
      ownPicks: () => ownPicks(shell, provider),
      onError: (text) => shell.toast('error', text),
      onDone: (order) => {
        view = 'chat';
        saved = !!order;
        render();
        pop.querySelector<HTMLElement>('.acct-set-order')?.focus({ preventScroll: true });
      },
    });
    editor.update();
    return [
      h(
        'div',
        { class: 'acct-order-head' },
        h('button', { type: 'button', class: 'icon-btn acct-back', 'aria-label': 'Back to this chat’s account', title: 'Back', onclick: () => ((view = 'chat'), render()) }, icon('arrowLeft', 15)),
        h('span', null, `Global ${plabel} order`),
      ),
      h('p', { class: 'acct-menu-note' }, 'Every chat starts on the first account that isn’t at a limit and moves down the list when a limit is used up.'),
      editor.el,
    ];
  }

  function place() {
    if (!anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const mh = `${Math.max(160, Math.round(r.top - 16))}px`;
    if (pop.style.maxHeight !== mh) pop.style.maxHeight = mh; // unchanged → no resize (the observer below calls this)
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 8)}px`;
  }

  function render() {
    const a = person();
    const acc = a?.account;
    if (!a || !acc || acc.provider !== provider) {
      close(); // the person left, or their chat moved to a model of another provider
      return;
    }
    const keep = pop.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const keepKey = keep?.closest('.ord') ? null : keep ? [...pop.querySelectorAll('button')].indexOf(keep as HTMLButtonElement) : -1;
    setChildren(pop, view === 'chat' ? chatView(a, acc) : orderView());
    if (view === 'chat' && keepKey !== null && keepKey >= 0) pop.querySelectorAll('button')[keepKey]?.focus({ preventScroll: true });
    place();
  }

  // ↑/↓ walk the menu's rows (the order editor's grips move their row instead).
  pop.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const items = [...pop.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];
    if (!items.length) return;
    ev.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });

  // Content changes size (the order loads, the editor's note shows up): stay above the chip, inside the screen.
  const sized = new ResizeObserver(() => place());
  const offOrder = client.subscribe(() => render());
  const offStore = store.subscribe((_s, msg) => {
    if (msg && ((msg.t === 'agent' && msg.agent.id === agentId) || (msg.t === 'agent_removed' && msg.agentId === agentId))) render();
  });
  let close = () => {};
  setChildren(pop, chatView(person()!, start));
  close = openPopover(shell.root, shell.layers, anchor, pop, {
    id: 'chip-account',
    placement: 'above',
    align: 'start',
    onClose: () => {
      sized.disconnect();
      offOrder();
      offStore();
      if (openClose === close) openClose = null;
    },
  });
  openClose = close;
  place();
  sized.observe(pop);
  (pop.querySelector<HTMLElement>('.acct-choice.is-checked') ?? pop.querySelector<HTMLElement>('.menu-item:not(:disabled)'))?.focus({ preventScroll: true });
  void client.ensure();
}
