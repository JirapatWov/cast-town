// Chat thread bar: the current conversation's title, a menu of older chats with this person, "New chat" and
// "Compact" (shrink the chat's context now; omp keeps a summary). A lead's menu also sets, pauses or drops its goal.
// The menu searches this person's chats — titles at once, what was said from the server (finding #44) — and opens
// "Find in this chat".
import './css/trust.css';
import type { AgentInfo, ChatThread, ServerMsg, ThreadSearchHit } from '../../../shared/protocol';
import { chatIcon } from './chat-icons';
import { h, memo, setChildren } from './dom';
import { isAgentBusy, timeAgo } from './format';
import { canHaveGoal, goalAction, openGoalDialog } from './goal-bar';
import { icon } from './icons';
import { MAIN_JOB } from './jobs';
import { fitPlacement, openPopover } from './popover';
import { isRunActive } from './runs';
import type { Shell } from './shell';

function currentThread(threads: ChatThread[] | undefined, agent: AgentInfo): ChatThread | undefined {
  return threads?.find((t) => t.id === agent.threadId) ?? threads?.find((t) => t.current);
}

/** The server's activity detail while a Compact runs (agent-runtime.ts compact()). */
const COMPACTING_DETAIL = 'Compacting the chat…';

function msgCount(n: number): string {
  return n === 1 ? '1 message' : `${n} messages`;
}

/** What a chat is called in the bar and the menu: an untitled chat with nothing in it yet is "Chat with <name>"
 *  (not a second "New chat" next to the New chat button). */
function threadLabel(t: { title?: string; messages: number } | undefined, fallback: string): string {
  const title = t?.title?.trim();
  if (!title || (title === 'New chat' && !t?.messages)) return fallback;
  return title;
}

/** `text` with the parts that match `q` (case-insensitive) in <mark>. */
function marked(text: string, q: string, at?: [number, number]): (string | HTMLElement)[] {
  if (at && at[1] > at[0] && at[1] <= text.length) return [text.slice(0, at[0]), h('mark', null, text.slice(at[0], at[1])), text.slice(at[1])];
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [text] : [text.slice(0, i), h('mark', null, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

/** onCompacting: a Compact this bar asked for started or ended (the composer holds messages meanwhile).
 *  onFind: show "Find in this chat" (with the words searched for, after a search result opened its chat). */
export function createThreadBar(shell: Shell, hooks: { onCompacting?(): void; onFind?(query?: string): void } = {}) {
  const { store } = shell;
  let agentId: string | null = null;
  let pending: 'new' | string | null = null; // 'new' or the thread id being opened
  let menuClose: (() => void) | null = null;
  let menuList: HTMLElement | null = null;
  const asked = new Set<string>();
  const changed = memo();
  let wasBusy = false;
  const compacting = new Set<string>(); // people this tab asked to Compact, waiting for the answer
  // search in the menu
  let query = '';
  let results: ThreadSearchHit[] | null = null; // the server's answer for `query`
  let searching = false;
  let searchNote = '';
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** A Compact of this person's chat runs — asked here, or from another tab / before a reload (their activity says so). */
  const isCompacting = (a: AgentInfo | undefined) => !!a && (compacting.has(a.id) || (isAgentBusy(a) && a.detail === COMPACTING_DETAIL));

  const titleBtn = h('button', { type: 'button', class: 'thread-btn', 'aria-haspopup': 'dialog' });
  // On a phone the label shortens to "New" (mobile.css) rather than leaving a bare icon: touch shows no tooltip.
  const newBtn = h('button', { type: 'button', class: 'thread-new btn btn-ghost btn-sm' }, icon('chatPlus', 15), h('span', null, 'New chat'));
  const compactBtn = h('button', { type: 'button', class: 'thread-new thread-compact btn btn-ghost btn-sm' }, chatIcon('compact', 15), h('span', null, 'Compact'));
  const el = h('div', { class: 'thread-bar', hidden: true }, titleBtn, compactBtn, newBtn);

  const agent = () => (agentId ? store.state.agents[agentId] : undefined);
  /** Threads exist on servers that know about jobs; helpers have no threads. */
  const supported = (a: AgentInfo | undefined) => !!a && a.kind !== 'subagent' && (a.threadId !== undefined || Object.keys(store.state.jobs).length > 0);
  /** A team run of the person's job: their chat can't be compacted meanwhile (the server refuses too). */
  const teamRunning = (a: AgentInfo) =>
    Object.values(store.state.runs).some((r) => isRunActive(r) && r.projectId === a.projectId && (r.jobId ?? MAIN_JOB) === (a.jobId ?? MAIN_JOB));
  /** Why Compact can't run now ('' → it can). */
  function compactBlock(a: AgentInfo, cur: ChatThread | undefined): string {
    if ((cur?.messages ?? 0) === 0) return 'This chat is still empty';
    if (isAgentBusy(a)) return a.available ? `Wait until ${a.name}’s helpers finish` : `Wait until ${a.name} finishes`;
    if (teamRunning(a)) return 'Wait until the team run ends';
    return '';
  }

  function ask(id: string, force = false) {
    if (!force && asked.has(id)) return;
    asked.add(id);
    store.send({ t: 'list_threads', agentId: id });
  }

  async function newChat() {
    const a = agent();
    if (!a || pending) return;
    pending = 'new';
    menuClose?.();
    render(true);
    try {
      await store.request({ t: 'new_thread', reqId: '', agentId: a.id });
      ask(a.id, true);
    } catch (err) {
      shell.toast('error', `Could not start a new chat: ${(err as Error).message}`);
    } finally {
      pending = null;
      render(true);
    }
  }

  async function compact() {
    const a = agent();
    if (!a || isCompacting(a) || pending || compactBlock(a, currentThread(store.state.threads[a.id], a))) return;
    menuClose?.();
    // It can't be undone (the details give way to a summary), and on a touch screen the bare icon explains nothing.
    const ok = await shell.confirm({
      title: 'Compact this chat?',
      body: `${a.name} replaces the conversation so far with a short summary, to get room to think. The messages stay on screen, but ${a.name} only remembers the summary. This can’t be undone.`,
      confirmLabel: 'Compact',
    });
    if (!ok || agent()?.id !== a.id || isCompacting(a) || compactBlock(a, currentThread(store.state.threads[a.id], a))) return;
    compacting.add(a.id);
    menuClose?.();
    render(true);
    hooks.onCompacting?.();
    try {
      const data = await store.request<{ tokensBefore?: number; nothing?: true } | undefined>({ t: 'compact', reqId: '', agentId: a.id });
      if (data?.nothing) shell.toast('info', `Nothing to compact yet — ${a.name}’s chat is still small, or was just compacted.`, { agentId: a.id });
    } catch (err) {
      shell.toast('error', `Could not compact the chat: ${(err as Error).message}`, { agentId: a.id });
    } finally {
      compacting.delete(a.id);
      render(true);
      if (menuList) renderMenu();
      hooks.onCompacting?.();
    }
  }

  async function open(thread: ChatThread) {
    const a = agent();
    if (!a || pending) return;
    if (thread.id === currentThread(store.state.threads[a.id], a)?.id) {
      menuClose?.();
      return;
    }
    pending = thread.id;
    renderMenu();
    try {
      await store.request({ t: 'switch_thread', reqId: '', agentId: a.id, threadId: thread.id });
      menuClose?.();
      ask(a.id, true);
    } catch (err) {
      shell.toast('error', `Could not open that chat: ${(err as Error).message}`);
    } finally {
      pending = null;
      render(true);
      renderMenu();
    }
  }

  /** Delete one chat for good (its transcript and AI session). The current chat is replaced by a fresh one first. */
  async function remove(thread: ChatThread) {
    const a = agent();
    if (!a || pending) return;
    const isCur = thread.id === currentThread(store.state.threads[a.id], a)?.id;
    menuClose?.();
    const ok = await shell.confirm({
      title: 'Delete this chat?',
      body: h('div', null,
        h('p', null, h('strong', null, `“${threadLabel(thread, 'Empty chat')}”`), ` (${msgCount(thread.messages)}) is deleted for good: the messages, ${a.name}’s AI session for it, and pictures only it used.`),
        h('p', { class: 'muted small' }, isCur ? `${a.name} starts a fresh chat. Files the chat changed stay as they are.` : 'Files the chat changed stay as they are.'),
      ),
      confirmLabel: 'Delete chat',
      tone: 'danger',
      icon: 'trash',
    });
    if (!ok) return;
    pending = thread.id;
    render(true);
    try {
      await store.request({ t: 'delete_thread', reqId: '', agentId: a.id, threadId: thread.id });
      shell.toast('success', 'Chat deleted.', { agentId: a.id });
    } catch (err) {
      shell.toast('error', `Could not delete the chat: ${(err as Error).message}`, { agentId: a.id });
    } finally {
      pending = null;
      ask(a.id, true);
      render(true);
    }
  }


  async function runSearch() {
    searchTimer = undefined;
    const a = agent();
    const q = query.trim();
    const mine = ++searchSeq;
    if (!a || q.length < 2) {
      results = null;
      searching = false;
      searchNote = '';
      renderMenu();
      return;
    }
    searching = true;
    renderMenu();
    try {
      const data = await store.request<{ results?: ThreadSearchHit[] } | undefined>({ t: 'search_threads', reqId: '', agentId: a.id, query: q });
      if (mine !== searchSeq) return;
      results = data?.results ?? [];
      searchNote = '';
    } catch (err) {
      if (mine !== searchSeq) return;
      results = null;
      const m = (err as Error).message;
      // a server from before chat search: titles only
      searchNote = /unknown|cannot handle|invalid message/i.test(m) ? 'This CAST server can only match titles — update it to search inside chats.' : `Couldn’t search inside chats: ${m}`;
    } finally {
      if (mine === searchSeq) {
        searching = false;
        renderMenu();
      }
    }
  }

  /** A search result: open that chat (unless it is this one), then find the words in it. */
  async function openHit(hit: ThreadSearchHit) {
    const a = agent();
    if (!a) return;
    const q = query.trim();
    const t = store.state.threads[a.id]?.find((x) => x.id === hit.threadId) ?? { id: hit.threadId, agentId: a.id, title: hit.title, createdAt: hit.updatedAt, updatedAt: hit.updatedAt, messages: hit.messages, current: hit.current };
    await open(t);
    if (agent()?.id === a.id && hit.hits > 0) hooks.onFind?.(q);
  }

  function searchRows(a: AgentInfo, threads: ChatThread[] | undefined, cur: ChatThread | undefined): HTMLElement[] {
    const q = query.trim();
    const rows: HTMLElement[] = [h('div', { class: 'thread-sec' }, `Chats with ${a.name} matching “${q}”`)];
    const hits: ThreadSearchHit[] =
      results ??
      (threads ?? [])
        .filter((t) => threadLabel(t, 'Empty chat').toLowerCase().includes(q.toLowerCase()))
        .map((t) => ({ threadId: t.id, title: threadLabel(t, 'Empty chat'), updatedAt: t.updatedAt, messages: t.messages, current: t.id === cur?.id, hits: 0, snippet: '' }));
    for (const hit of hits) {
      const isCur = hit.threadId === cur?.id;
      rows.push(
        h(
          'button',
          { type: 'button', class: ['thread-item', 'thread-hit', isCur && 'is-current'], disabled: !!pending && pending !== hit.threadId, onclick: () => void openHit(hit), title: hit.title },
          h('span', { class: 'thread-ic' }, pending === hit.threadId ? h('span', { class: 'spinner spinner-sm' }) : icon(isCur ? 'check' : 'chat', 15)),
          h(
            'span',
            { class: 'thread-text' },
            h('span', { class: 'thread-title' }, ...marked(threadLabel({ title: hit.title, messages: hit.messages }, 'Empty chat'), q)),
            hit.hits && hit.snippet ? h('span', { class: 'thread-snippet' }, ...marked(hit.snippet, q, hit.at)) : null,
            h('span', { class: 'thread-meta' }, isCur ? h('span', { class: 'thread-cur' }, 'Current') : null, [hit.hits ? (hit.hits === 1 ? '1 match' : `${hit.hits} matches`) : 'title', timeAgo(hit.updatedAt)].join(' · ')),
          ),
        ),
      );
    }
    if (searching) rows.push(h('div', { class: 'thread-empty' }, h('span', { class: 'spinner spinner-sm' }), 'Searching inside the chats…'));
    else if (searchNote) rows.push(h('div', { class: 'thread-empty' }, searchNote));
    else if (!hits.length) rows.push(h('div', { class: 'thread-empty' }, q.length < 2 && !results ? 'Type a little more to search inside the chats.' : `No chat with ${a.name} mentions “${q}”.`));
    return rows;
  }

  function renderMenu() {
    const a = agent();
    if (!menuList || !a) return;
    if (query.trim()) {
      const threads = store.state.threads[a.id];
      setChildren(menuList, ...searchRows(a, threads, currentThread(threads, a)));
      return;
    }
    const threads = store.state.threads[a.id];
    const cur = currentThread(threads, a);
    const busy = isAgentBusy(a);
    const cBlock = compactBlock(a, cur);
    const compactingNow = isCompacting(a);
    const action = (label: string, ic: Node, meta: string, disabled: boolean, onclick: () => void, cls?: string) =>
      h(
        'button',
        { type: 'button', class: ['thread-item', 'thread-item-new', cls], disabled, onclick },
        h('span', { class: 'thread-ic' }, ic),
        h('span', { class: 'thread-text' }, h('span', { class: 'thread-title' }, label), h('span', { class: 'thread-meta' }, meta)),
      );
    const rows: HTMLElement[] = [
      h(
        'button',
        { type: 'button', class: 'thread-item thread-item-new', disabled: !!pending || busy || (cur?.messages ?? 0) === 0, onclick: () => void newChat() },
        h('span', { class: 'thread-ic' }, pending === 'new' ? h('span', { class: 'spinner spinner-sm' }) : icon('chatPlus', 15)),
        h('span', { class: 'thread-text' }, h('span', { class: 'thread-title' }, 'New chat'), h('span', { class: 'thread-meta' }, busy ? `Wait until ${a.name} finishes` : (cur?.messages ?? 0) === 0 ? 'This chat is still empty' : `Fresh start with ${a.name}; this one stays here`)),
      ),
      action(
        'Compact this chat',
        compactingNow ? h('span', { class: 'spinner spinner-sm' }) : chatIcon('compact', 15),
        compactingNow ? 'Compacting…' : cBlock || `${a.name} keeps a summary and gets room to think`,
        !!pending || compactingNow || !!cBlock,
        () => void compact(),
      ),
    ];
    if (hooks.onFind && (cur?.messages ?? 0) > 0)
      rows.push(
        action('Find in this chat', icon('search', 15), 'Ctrl+F in the chat — also in folded tool steps', false, () => {
          menuClose?.();
          hooks.onFind?.();
        }),
      );
    if (canHaveGoal(a)) {
      const g = a.goal;
      const run = (op: 'pause' | 'resume' | 'drop') => () => {
        menuClose?.();
        void goalAction(shell, a.id, op);
      };
      if (!g)
        rows.push(
          action('Set a goal…', chatIcon('target', 15), `${a.name} keeps working on its own until it’s done`, !!pending, () => {
            menuClose?.();
            openGoalDialog(shell, a.id);
          }),
        );
      else {
        rows.push(
          g.status === 'paused'
            ? action('Resume the goal', icon('play', 15), g.objective, !!pending, run('resume'))
            : action('Pause the goal', chatIcon('pause', 15), g.objective, !!pending, run('pause')),
        );
        rows.push(action('Drop the goal…', icon('x', 15), 'Stop working toward it', !!pending, run('drop')));
      }
    }
    rows.push(h('div', { class: 'thread-sec' }, `Chats with ${a.name}`));
    if (!threads) rows.push(h('div', { class: 'thread-empty' }, h('span', { class: 'spinner spinner-sm' }), 'Loading chats…'));
    else if (!threads.length) rows.push(h('div', { class: 'thread-empty' }, 'No chats yet. Say hi below.'));
    else
      for (const t of threads) {
        const isCur = t.id === cur?.id;
        const del = h('button', { type: 'button', class: 'icon-btn thread-del', 'aria-label': `Delete chat “${threadLabel(t, 'Empty chat')}”`, title: busy && isCur ? `Wait until ${a.name} finishes` : 'Delete this chat', disabled: !!pending || (busy && isCur) || (isCur && !t.messages), onclick: () => void remove(t) }, icon('trash', 14));
        rows.push(h('div', { class: 'thread-row' },
          h(
            'button',
            {
              type: 'button',
              class: ['thread-item', isCur && 'is-current'],
              'aria-current': isCur ? 'true' : undefined,
              disabled: !!pending && pending !== t.id,
              onclick: () => void open(t),
              title: t.title,
            },
            h('span', { class: 'thread-ic' }, pending === t.id ? h('span', { class: 'spinner spinner-sm' }) : isCur ? icon('check', 15) : icon('chat', 15)),
            h(
              'span',
              { class: 'thread-text' },
              h('span', { class: 'thread-title' }, threadLabel(t, 'Empty chat')),
              h('span', { class: 'thread-meta' }, isCur ? h('span', { class: 'thread-cur' }, 'Current') : null, `${timeAgo(t.updatedAt)} · ${msgCount(t.messages)}`),
            ),
          ),
          del,
        ));
      }
    const focusedIdx = [...menuList.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement);
    setChildren(menuList, ...rows);
    if (focusedIdx >= 0) menuList.querySelectorAll<HTMLButtonElement>('button')[focusedIdx]?.focus({ preventScroll: true });
  }

  function openMenuPop() {
    const a = agent();
    if (!a) return;
    ask(a.id, true);
    menuList = h('div', { class: 'thread-list' });
    query = '';
    results = null;
    searchNote = '';
    searching = false;
    const search = h('input', { type: 'search', class: 'thread-search-input', placeholder: 'Search chats…', 'aria-label': `Search chats with ${a.name}`, enterkeyhint: 'search', maxlength: '200' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      query = search.value;
      results = null;
      searchNote = '';
      searchSeq++; // an answer for the old words is stale
      searching = false;
      clearTimeout(searchTimer);
      renderMenu();
      if (query.trim().length >= 2) searchTimer = setTimeout(() => void runSearch(), 250);
    });
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        clearTimeout(searchTimer);
        if (query.trim() && !results && !searching) void runSearch();
        else menuList?.querySelector<HTMLButtonElement>('.thread-hit:not(:disabled)')?.focus();
      }
    });
    const pop = h(
      'div',
      { class: 'thread-menu glass-strong', role: 'dialog', 'aria-label': `Chats with ${a.name}` },
      h('label', { class: 'thread-search' }, icon('search', 14), search),
      menuList,
    );
    pop.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const items: HTMLElement[] = [search, ...pop.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    });
    renderMenu();
    const fit = fitPlacement(titleBtn, 200, 440);
    pop.style.maxHeight = `${fit.maxHeight}px`;
    menuClose = openPopover(shell.root, shell.layers, titleBtn, pop, {
      id: 'thread-menu',
      placement: fit.placement,
      align: 'start',
      onClose: () => {
        menuClose = null;
        menuList = null;
        clearTimeout(searchTimer);
        searchSeq++;
        query = '';
      },
    });
    (pop.querySelector<HTMLElement>('.thread-item.is-current') ?? pop.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
  }

  titleBtn.addEventListener('click', () => (menuClose ? menuClose() : openMenuPop()));
  newBtn.addEventListener('click', () => void newChat());
  compactBtn.addEventListener('click', () => void compact());

  function render(force = false) {
    const a = agent();
    if (!supported(a)) {
      el.hidden = true;
      changed(null);
      return;
    }
    const threads = store.state.threads[a!.id];
    const cur = currentThread(threads, a!);
    const busy = isAgentBusy(a);
    const cBlock = compactBlock(a!, cur);
    const compactingNow = isCompacting(a);
    if (!changed([a!.id, a!.threadId, busy, cur, threads?.length, pending, compactingNow, cBlock]) && !force) return;
    el.hidden = false;
    const older = (threads?.length ?? 0) - (cur ? 1 : 0);
    const label = threadLabel(cur, `Chat with ${a!.name}`);
    setChildren(titleBtn,
      icon('history', 15, 'thread-btn-ic'),
      h('span', { class: 'thread-btn-title' }, pending && pending !== 'new' ? 'Opening chat…' : label),
      cur && cur.messages ? h('span', { class: 'thread-btn-meta' }, String(cur.messages)) : null,
      older > 0 ? h('span', { class: 'thread-btn-more' }, `${older} older`) : null,
      icon('chevronDown', 14, 'thread-btn-chev'),
    );
    titleBtn.setAttribute('aria-label', `Current chat: ${label}. ${older > 0 ? `${older} older chats. ` : ''}Show chats`);
    titleBtn.title = `${label}${older > 0 ? ` · ${older} older` : ''} — show chats`;
    const empty = (cur?.messages ?? 0) === 0;
    // An empty chat already is a new chat: no second "New chat" next to it.
    newBtn.hidden = empty && pending !== 'new';
    newBtn.disabled = !!pending || busy || empty;
    newBtn.title = busy ? `Wait until ${a!.name} finishes` : empty ? 'This chat is still empty' : 'New chat — start fresh (the current one is kept)';
    setChildren(newBtn, pending === 'new' ? h('span', { class: 'spinner spinner-sm' }) : icon('chatPlus', 15), h('span', { class: 'thread-new-long' }, 'New chat'), h('span', { class: 'thread-new-short', 'aria-hidden': 'true' }, 'New'));
    newBtn.setAttribute('aria-label', 'New chat');
    // Compact sits next to New chat while there is something to compact.
    compactBtn.hidden = empty && !compactingNow;
    compactBtn.disabled = !!pending || compactingNow || !!cBlock;
    compactBtn.title = compactingNow ? COMPACTING_DETAIL : cBlock ? `Compact — ${cBlock}` : `Compact — shrink the chat now: ${a!.name} keeps a summary of it and gets room to think`;
    compactBtn.classList.toggle('is-working', compactingNow);
    compactBtn.setAttribute('aria-label', compactingNow ? 'Compacting the chat' : 'Compact the chat');
    setChildren(compactBtn, compactingNow ? h('span', { class: 'spinner spinner-sm' }) : chatIcon('compact', 15), h('span', null, compactingNow ? 'Compacting…' : 'Compact'));
  }

  return {
    el,
    isCompacting,
    show(id: string) {
      if (id !== agentId) {
        agentId = id;
        menuClose?.();
      }
      const a = agent();
      wasBusy = isAgentBusy(a);
      if (supported(a)) ask(id);
      render(true);
    },
    onState(msg?: ServerMsg) {
      if (!agentId) return;
      if (msg?.t === 'threads' && msg.agentId !== agentId) return;
      if (msg?.t === 'agent' && msg.agent.id !== agentId) return;
      if (msg?.t === 'snapshot') asked.clear();
      if (msg && !['threads', 'agent', 'snapshot', 'jobs', 'transcript_reset', 'run'].includes(msg.t)) return;
      const a = agent();
      // A finished reply changes the message count; the server pushes it too, this covers older servers.
      const busyNow = isAgentBusy(a);
      if (wasBusy && !busyNow && supported(a)) ask(agentId, true);
      wasBusy = busyNow;
      if (msg?.t === 'snapshot' && supported(a)) ask(agentId);
      render();
      if (menuList) renderMenu();
    },
  };
}
