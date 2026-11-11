// Models & providers → "Connect another account": every sign-in `omp login` offers (shared/omp-login-providers.ts,
// generated from omp's source), searchable and grouped, each with its omp id, how it signs in and one Connect button
// that runs the page's own sign-in flow. Connected ones say so and come first in their group. A sign-in started here
// for a provider that has no card yet shows its steps in the row; one with a card (featured or its own) shows them on
// that card.
// Also the folded parts of the page (a card's models and usage, the list's groups): unfolded ones are remembered per
// device (deviceStorage), and the toggle that unfolds them.
import { OMP_LOGIN_PROVIDERS, OMP_LOGIN_PROVIDERS_VERSION, type OmpLoginProvider } from '../../../shared/omp-logins';
import type { LoginState } from '../../../shared/protocol';
import { deviceStorage, h, setChildren, type Child } from './dom';
import { icon } from './icons';
import { KIND_TAG, KIND_TEXT, OPEN_PARTS_KEY, groupLogins, isTallHead, parseOpenParts, serializeOpenParts } from './provider-catalog';
import './css/providers-list.css';

// ───────────────────────── folded parts ─────────────────────────

export interface OpenParts {
  has(key: string): boolean;
  set(key: string, open: boolean): void;
}

/** The parts the user unfolded on this device. */
export function openParts(): OpenParts {
  const open = parseOpenParts(deviceStorage.get(OPEN_PARTS_KEY));
  return {
    has: (key) => open.has(key),
    set(key, on) {
      if (on === open.has(key)) return;
      if (on) open.add(key);
      else open.delete(key);
      deviceStorage.set(OPEN_PARTS_KEY, serializeOpenParts(open));
    },
  };
}

/** An id safe in an attribute ("usage:p:llama.cpp" → "part-usage-p-llama-cpp"). */
export const partId = (key: string) => `part-${key.replace(/[^\w-]+/g, '-')}`;

/** A one-line toggle that folds a part (`aria-controls` it): "12 models ▸", "Usage · 5h 38% used ▸". A native button,
 *  so Enter and Space work; its focus key brings the focus back to it after the page is rebuilt. */
export function partToggle(o: { key: string; open: boolean; label: Child; meta?: Child; className?: string; onToggle(open: boolean): void }): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: ['part-toggle', o.open && 'is-open', o.className],
      'aria-expanded': o.open ? 'true' : 'false',
      'aria-controls': partId(o.key),
      'data-focus-key': `part:${o.key}`,
      onclick: () => o.onToggle(!o.open),
    },
    icon('chevronRight', 13, 'part-chev'),
    h('span', { class: 'part-label' }, o.label),
    o.meta ? h('span', { class: 'part-meta' }, o.meta) : null,
  );
}

// ───────────────────────── a tall header ─────────────────────────

/** The dialog's header stays put while its body scrolls. With very large text on a small screen it can fill most of
 *  the screen (an iPhone SE at 200 %): then the whole dialog scrolls instead, header included (`is-tall-head`).
 *  Returns the function that stops watching. */
export function watchTallHead(dialog: HTMLElement): () => void {
  const head = dialog.querySelector<HTMLElement>('.modal-head');
  if (!head || typeof ResizeObserver === 'undefined') return () => {};
  const check = () => dialog.classList.toggle('is-tall-head', isTallHead(head.getBoundingClientRect().height, window.innerHeight));
  const ro = new ResizeObserver(check); // the text size or the width changed
  ro.observe(head);
  window.addEventListener('resize', check);
  check();
  return () => {
    ro.disconnect();
    window.removeEventListener('resize', check);
  };
}

// ───────────────────────── the list ─────────────────────────

export interface LoginListOptions {
  parts: OpenParts;
  /** Rebuild the whole page (a group folded, a sign-in started). */
  render(): void;
  /** Start `omp login <id>` (the page's flow). */
  start(id: string): void;
}

export interface LoginListView {
  /** Connected sign-in ids; the sign-in running (null: none); its steps (the page's panel); where its panel shows. */
  connected: ReadonlySet<string>;
  login: LoginState | null;
  panel(l: LoginState): HTMLElement;
  homeOf(id: string): 'vendor' | 'card' | 'list';
}

const mark = (p: OmpLoginProvider) => (p.label.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase();

export function createLoginList(o: LoginListOptions) {
  let query = '';
  let view: LoginListView | null = null;
  const groupsEl = h('div', { class: 'login-groups', id: 'login-groups' });
  const status = h('p', { class: 'login-status', role: 'status', 'aria-live': 'polite' });
  // kept across renders: what was typed and the focus survive the page being rebuilt
  const search = h('input', {
    class: 'input login-search',
    type: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: `Search ${OMP_LOGIN_PROVIDERS.length} providers`,
    'aria-label': 'Search providers',
    'aria-controls': 'login-groups',
    oninput: () => {
      query = search.value;
      fill(); // only the list: the rest of the page stays as it is while typing
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Escape' && search.value) {
        e.preventDefault();
        e.stopPropagation(); // clears the search; a second Escape closes the dialog
        search.value = query = '';
        fill();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        groupsEl.querySelector<HTMLButtonElement>('.login-connect')?.focus(); // the first match's Connect
      }
    },
  });

  function row(p: OmpLoginProvider, v: LoginListView): HTMLElement {
    const on = v.connected.has(p.id);
    const l = v.login && v.login.phase !== 'cancelled' && v.login.provider === p.id ? v.login : null;
    const here = l && v.homeOf(p.id) === 'list';
    const action = on ? (p.kind === 'key' ? 'Replace key' : 'Add account') : 'Connect';
    return h(
      'li',
      { class: ['login-row', on && 'is-connected', here && 'is-signing'], 'data-login': p.id },
      h('span', { class: 'login-mark', 'aria-hidden': 'true' }, mark(p)),
      h('div', { class: 'login-titles' }, h('span', { class: 'login-name' }, p.label), h('code', { class: 'login-id', title: p.name !== p.label ? p.name : undefined }, p.id)),
      h(
        'div',
        { class: 'login-side' },
        h('span', { class: ['login-kind', `is-${p.kind}`], title: KIND_TEXT[p.kind] }, KIND_TAG[p.kind]),
        on ? h('span', { class: 'conn-pill is-on' }, h('span', { class: 'conn-dot' }), 'Connected') : null,
        here
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: ['btn', 'btn-sm', 'login-connect', on ? 'btn-ghost' : 'btn-soft'],
                // the sign-in's Cancel has the same key: the focus moves to it, and back here when it ends
                'data-focus-key': `signin:${p.id}`,
                'aria-label': `${action}: ${p.label} (${KIND_TEXT[p.kind]})`,
                onclick: () => o.start(p.id),
              },
              action,
            ),
      ),
      here && l ? h('div', { class: 'login-panel', 'data-signin-for': p.id }, v.panel(l)) : null,
    );
  }

  function fill() {
    const v = view;
    if (!v) return;
    const searching = !!query.trim();
    const groups = groupLogins(query, v.connected);
    const signingHere = v.login && v.login.phase !== 'cancelled' && v.homeOf(v.login.provider) === 'list' ? v.login.provider : null;
    setChildren(
      groupsEl,
      groups.map((g) => {
        const key = `group:${g.group}`;
        // searching shows every match; a sign-in running in a row keeps its group open
        const open = searching || o.parts.has(key) || g.providers.some((p) => p.id === signingHere);
        const count = h('span', { class: 'login-count' }, String(g.providers.length));
        return h(
          'section',
          { class: 'login-group', 'aria-label': g.title },
          searching
            ? h('h4', { class: 'login-group-title' }, g.title, ' ', count)
            : partToggle({
                key,
                open,
                className: 'login-group-toggle',
                label: [g.title, ' ', count],
                meta: g.connected ? `${g.connected} connected` : null,
                onToggle: (next) => {
                  o.parts.set(key, next);
                  o.render();
                },
              }),
          h('ul', { class: 'login-rows', id: partId(key), hidden: !open }, open ? g.providers.map((p) => row(p, v)) : null),
        );
      }),
    );
    const hits = groups.reduce((n, g) => n + g.providers.length, 0);
    status.textContent = searching ? (hits ? `${hits} ${hits === 1 ? 'provider matches' : 'providers match'}` : `No provider matches “${query.trim()}”.`) : '';
    status.hidden = !searching;
  }

  return {
    /** The section, rebuilt with what the page knows now. */
    el(v: LoginListView): HTMLElement {
      view = v;
      fill();
      return h(
        'section',
        { class: 'login-list', 'aria-labelledby': 'login-list-title' },
        h(
          'div',
          { class: 'login-list-head' },
          h('h3', { id: 'login-list-title' }, 'Connect another account'),
          h('p', { class: 'login-list-note' }, `Every sign-in cast-agent ${OMP_LOGIN_PROVIDERS_VERSION} offers. Connect runs the same sign-in as `, h('code', null, 'cast-agent login'), '.'),
        ),
        h('div', { class: 'login-search-wrap' }, icon('search', 14, 'login-search-icon'), search),
        status,
        groupsEl,
      );
    },
  };
}
