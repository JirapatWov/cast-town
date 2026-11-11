// Cities in the UI: the switcher in the top bar (#city-switcher, before the breadcrumb), its menu (Home + each city
// the hub knows, Add a city…, Manage cities…), the Add and Manage dialogs, the "Accounts on <city>" note of the
// Models & providers panel and the reconnect banner's "Back to Home".
//
// One city = one machine running CAST. The hub (the server this browser paired with) shows another city under
// /city/<id>/, so switching is a page load: each city runs the web app of its own server, with its own houses, people
// and AI accounts. Nothing here ever moves accounts between cities.
import './css/cities.css';
import type { CitySummary } from '../../../shared/cities';
import { CITY_ID } from '../net/base';
import {
  addCity, cityStatusText, citiesView, currentCityName, hasManyCities, loadCities, onCities, rememberCurrentCity, removeCity,
  restoreLastCity, switchCity, updateCity, type CitiesView,
} from '../net/cities';
import { h, memo, setChildren } from './dom';
import { icon } from './icons';
import { openMenu, type MenuItem } from './menu';
import { openModal, type ModalHandle } from './modal';
import { secretField } from './secret-field';
import type { Shell } from './shell';

const STATUS_COLOR: Record<CitySummary['status'], string> = { online: 'var(--ok)', offline: 'var(--text-3)', error: 'var(--amber)' };
/** After this long without a connection, the reconnect banner of a city offers to go back home. */
const OFFLINE_HOME_AFTER_MS = 8000;
// A city's pages are served through this hub on its own address, so they can do here whatever you can (SECURITY.md).
const TRUST_LINE = 'Only add machines you control — a city’s pages run inside this CAST and can do here whatever you can.';

/** A note that follows the city list: rendered by `render`, re-rendered whenever the list changes while it is in
 *  the page (it stops listening once it has left the page). */
function live(el: HTMLElement, render: (v: CitiesView) => void): HTMLElement {
  let seen = false;
  render(citiesView());
  const off = onCities((v) => {
    if (el.isConnected) seen = true;
    else if (seen) return off();
    render(v);
  });
  if (!citiesView().data) void loadCities();
  return el;
}

/** "Accounts on <city>" + why, for the Models & providers panel; empty while there is only one city. */
export function cityAccountsNote(): HTMLElement {
  const el = h('span', { class: 'city-accounts' });
  return live(el, (v) => {
    if (!hasManyCities(v)) return setChildren(el);
    setChildren(el, icon('building', 13), h('span', null, 'Accounts on ', h('b', null, currentCityName(v)), '. Each city (machine) keeps its own AI accounts.'));
  });
}

/** The reconnect banner (ui/index.ts) of a city opened through a hub: after a while, offer to go back home. */
export function attachCityOffline(banner: HTMLElement): void {
  if (!CITY_ID) return;
  const home = h('button', { type: 'button', class: 'btn btn-sm btn-soft offline-home', hidden: true, onclick: () => switchCity('home') }, icon('home', 14), 'Back to Home');
  banner.append(home);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    if (banner.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
      home.hidden = true;
    } else if (!timer && home.hidden) {
      timer = setTimeout(() => {
        timer = null;
        if (!banner.hidden) home.hidden = false;
      }, OFFLINE_HOME_AFTER_MS);
    }
  };
  new MutationObserver(sync).observe(banner, { attributes: true, attributeFilter: ['hidden'] });
  sync();
}

export function createCitySwitcher(shell: Shell) {
  const name = h('span', { class: 'city-name' });
  const dot = h('span', { class: 'city-dot', 'aria-hidden': 'true' });
  const el = h(
    'button',
    { type: 'button', id: 'city-switcher', class: 'tb-btn city-switcher', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    icon('building', 15, 'city-icon'),
    name,
    dot,
    icon('chevronDown', 13, 'city-chev'),
  );
  let closeMenu: (() => void) | null = null;

  function render() {
    const v = citiesView();
    const label = currentCityName(v);
    const up = shell.store.state.connected;
    name.textContent = label;
    el.title = `${label} — switch city`;
    el.setAttribute('aria-label', `City: ${label}${up ? '' : ' (reconnecting)'}. Switch city`);
    dot.style.background = up ? STATUS_COLOR.online : 'var(--amber)';
    dot.classList.toggle('is-down', !up);
    // with one city the machine's name says nothing the house name does not: the Board's phone top bar hides it
    el.classList.toggle('is-solo', !hasManyCities(v));
  }

  function menuItems(v: CitiesView): MenuItem[] {
    const here = CITY_ID ?? 'home';
    if (!v.data) return [{ label: v.loading ? 'Loading cities…' : 'Couldn’t load the cities', disabled: true, onSelect() {} }];
    return [
      { label: v.data.home.name, hint: 'Home', swatch: STATUS_COLOR.online, checked: here === 'home', onSelect: () => switchCity('home') },
      ...v.data.cities.map((c) => ({
        label: c.name,
        hint: cityStatusText(c),
        swatch: STATUS_COLOR[c.status],
        checked: here === c.id,
        onSelect: () => switchCity(c.id),
      })),
    ];
  }

  function open() {
    if (closeMenu) return;
    const v = citiesView();
    closeMenu = openMenu(
      shell.root,
      shell.layers,
      el,
      [
        { title: 'Cities', items: menuItems(v) },
        {
          items: [
            { label: 'Add a city…', icon: 'plus', onSelect: () => openAddCity(shell) },
            { label: 'Manage cities…', icon: 'pencil', disabled: !v.data, onSelect: () => openManageCities(shell) },
          ],
        },
      ],
      {
        id: 'city-menu',
        className: 'city-menu',
        minWidth: 260,
        footer: v.error ? h('span', { class: 'form-error' }, v.error) : 'Each city is a machine running CAST, with its own houses and AI accounts.',
      },
    );
    const done = closeMenu;
    // openMenu's close also runs on outside clicks/Esc; notice it through aria-expanded going back to false.
    const watch = new MutationObserver(() => {
      if (el.getAttribute('aria-expanded') !== 'true') {
        watch.disconnect();
        if (closeMenu === done) closeMenu = null;
      }
    });
    watch.observe(el, { attributes: true, attributeFilter: ['aria-expanded'] });
    // Fresh statuses: reopen in place only when something the menu shows has changed.
    const shown = JSON.stringify(menuItems(v).map((i) => [i.label, i.hint, i.swatch]));
    void loadCities().then((next) => {
      if (closeMenu !== done || JSON.stringify(menuItems(next).map((i) => [i.label, i.hint, i.swatch])) === shown) return;
      done();
      closeMenu = null;
      open();
    });
  }

  el.addEventListener('click', () => (closeMenu ? closeMenu() : open()));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      open();
    }
  });

  let first = true;
  onCities((v) => {
    render();
    if (first && v.data) {
      first = false;
      if (!restoreLastCity(v)) rememberCurrentCity();
    }
  });
  shell.store.subscribe(() => {
    if (dot.classList.contains('is-down') === shell.store.state.connected) render();
  });
  render();
  void loadCities();
  return { el, render };
}

// ───────────────────────── Add a city ─────────────────────────

function field(label: string, input: HTMLElement, hint?: string, optional = false): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label, optional ? h('span', { class: 'field-optional' }, ' optional') : null),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

function textInput(attrs: Record<string, unknown>): HTMLInputElement {
  return h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs });
}

export function openAddCity(shell: Shell): ModalHandle {
  const formId = 'city-add-form';
  const nameIn = textInput({ name: 'name', placeholder: 'e.g. Studio PC', maxlength: 40 });
  const urlIn = textInput({ name: 'url', inputmode: 'url', placeholder: 'https://other-machine.tailnet.ts.net:8443' });
  // the pairing link is a password for that machine: hidden while typed or pasted (Show checks it)
  const pairField = secretField({ name: 'pairing', placeholder: 'http://…/?token=…  or the token' });
  const pairIn = pairField.input;
  const error = h('p', { class: 'form-error city-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', form: formId, class: 'btn btn-primary' }, icon('plus', 15), 'Add city');
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modal.close() }, 'Cancel');
  let busy = false;

  const form = h(
    'form',
    { id: formId, class: 'city-form', novalidate: true },
    h('p', { class: 'city-trust' }, icon('alert', 15), TRUST_LINE),
    field('Name', nameIn, 'What the city is called here. Empty: the name that machine gives itself.', true),
    field('Address', urlIn, 'How this CAST server reaches the other machine — or http://192.168.1.20:4860 on your network.'),
    field('Pairing link or token', pairField.el, 'Shown on the other machine when CAST starts there (it says where to find the pairing link). Paste the whole link, or just the token.'),
    error,
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    const url = urlIn.value.trim();
    const pairing = pairIn.value.trim();
    urlIn.classList.toggle('is-invalid', !url && !/^https?:\/\//i.test(pairing));
    pairIn.classList.toggle('is-invalid', !pairing);
    if (!pairing || (!url && !/^https?:\/\//i.test(pairing))) {
      showError(!pairing ? 'Paste the pairing link or token of the other machine.' : 'Enter the address of the other machine.');
      (!pairing ? pairIn : urlIn).focus();
      return;
    }
    setBusy(true);
    addCity({ url, pairing, name: nameIn.value.trim() || undefined })
      .then((city) => {
        modal.close();
        shell.toast('success', `${city.name} added — open it`, { onClick: () => switchCity(city.id) });
      })
      .catch((err: Error) => {
        setBusy(false);
        showError(err.message);
      });
  });

  function showError(text: string) {
    error.textContent = text;
    error.hidden = false;
  }

  function setBusy(on: boolean) {
    busy = on;
    for (const i of [nameIn, urlIn, pairIn]) i.disabled = on;
    submit.disabled = on;
    setChildren(submit, on ? h('span', { class: 'spinner spinner-sm' }) : icon('plus', 15), on ? 'Checking…' : 'Add city');
    if (on) error.hidden = true;
  }

  const modal = openModal(shell.root, shell.layers, {
    id: 'city-add',
    className: 'modal-city',
    title: 'Add a city',
    subtitle: 'Another machine running CAST becomes a city you can switch to. Its houses and AI accounts stay on that machine.',
    body: form,
    footer: [cancel, submit],
    dismissible: false,
  });
  return modal;
}

// ───────────────────────── Manage cities ─────────────────────────

export function openManageCities(shell: Shell): ModalHandle {
  const list = h('div', { class: 'city-list', role: 'list' });
  const changed = memo();

  /** An open inline editor. One form per editing session: the list re-renders on every refresh (statuses come in
   *  every 30 s), and rebuilding the form would wipe what the user is typing. */
  interface Editor {
    mode: 'rename' | 'repair';
    form: HTMLFormElement;
    error: HTMLElement;
    busy: boolean;
    setBusy(on: boolean): void;
  }
  const editors = new Map<string, Editor>();

  function statusLine(c: CitySummary): Node[] {
    return [h('span', { class: 'city-url' }, c.url), h('span', { class: ['city-state', `is-${c.status}`] }, cityStatusText(c))];
  }

  function row(c: CitySummary): HTMLElement {
    const ed = editors.get(c.id);
    const actions = h(
      'div',
      { class: 'city-actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => edit(c, 'rename') }, icon('pencil', 14), 'Rename'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => edit(c, 'repair') }, icon('key', 14), 'Re-pair'),
      h('button', { type: 'button', class: 'btn btn-sm btn-deny', onclick: () => void remove(c) }, icon('trash', 14), 'Remove'),
    );
    const head = h(
      'div',
      { class: 'city-row-head' },
      h('span', { class: 'swatch', style: { background: STATUS_COLOR[c.status] } }),
      h('div', { class: 'city-row-text' }, h('div', { class: 'city-row-name' }, c.name, CITY_ID === c.id ? h('span', { class: 'city-here' }, 'you are here') : null), h('div', { class: 'city-row-meta' }, statusLine(c))),
      ed ? null : actions,
    );
    const problem = c.error && c.status !== 'online' && !ed ? h('p', { class: 'field-hint city-problem' }, c.error) : null;
    return h('div', { class: 'city-row', role: 'listitem' }, head, problem, ed?.form ?? null);
  }

  function makeEditor(c: CitySummary, mode: 'rename' | 'repair'): Editor {
    const error = h('p', { class: 'form-error city-error', role: 'alert', hidden: true });
    const cancel = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => edit(c, null) }, 'Cancel');
    const submit = h('button', { type: 'submit', class: 'btn btn-sm btn-primary' });
    const inputs: HTMLInputElement[] = [];
    let first: HTMLInputElement;
    let collect: () => { name?: string; pairing?: string; url?: string };
    let body: HTMLElement[];
    const label = (busy: boolean) =>
      mode === 'rename' ? [busy ? h('span', { class: 'spinner spinner-sm' }) : null, 'Save'] : [busy ? h('span', { class: 'spinner spinner-sm' }) : icon('key', 14), busy ? 'Checking…' : 'Re-pair'];
    if (mode === 'rename') {
      const name = textInput({ value: c.name, maxlength: 40, 'aria-label': `New name for ${c.name}` });
      inputs.push(name);
      first = name;
      body = [name];
      collect = () => ({ name: name.value.trim() });
    } else {
      const pairField = secretField({ placeholder: 'Pairing link or token of that machine' });
      const pair = pairField.input;
      const addr = textInput({ value: c.url, inputmode: 'url' });
      inputs.push(pair, addr);
      first = pair;
      body = [field('Pairing link or token', pairField.el, 'From that machine, as when you added it. Use this after its pairing token changed.'), field('Address', addr)];
      collect = () => {
        const url = addr.value.trim();
        return { pairing: pair.value.trim(), ...(url && url !== c.url ? { url } : {}) };
      };
    }
    const form = h('form', { class: 'city-edit', 'data-city': c.id }, body, h('div', { class: 'city-edit-actions' }, cancel, submit), error);
    const ed: Editor = {
      mode,
      form,
      error,
      busy: false,
      setBusy(on) {
        ed.busy = on;
        for (const i of inputs) i.disabled = on;
        submit.disabled = on;
        setChildren(submit, ...label(on));
        if (on) error.hidden = true;
      },
    };
    ed.setBusy(false);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (ed.busy) return;
      ed.setBusy(true);
      updateCity(c.id, collect())
        .then(() => {
          if (editors.get(c.id) === ed) editors.delete(c.id);
          render(true);
        })
        .catch((err: Error) => {
          ed.setBusy(false);
          error.textContent = err.message;
          error.hidden = false;
          first.focus({ preventScroll: true });
        });
    });
    requestAnimationFrame(() => {
      first.focus({ preventScroll: true });
      if (mode === 'rename') first.select();
    });
    return ed;
  }

  function edit(c: CitySummary, mode: 'rename' | 'repair' | null) {
    if (mode) editors.set(c.id, makeEditor(c, mode));
    else editors.delete(c.id);
    render(true);
  }

  async function remove(c: CitySummary) {
    const ok = await shell.confirm({
      title: `Remove ${c.name}?`,
      body: h('p', null, 'This hub forgets the city and its pairing. Nothing on that machine changes — its houses, chats and AI accounts stay there. You can add it again later.'),
      confirmLabel: 'Remove',
      tone: 'danger',
      icon: 'trash',
    });
    if (!ok) return;
    try {
      await removeCity(c.id);
      if (CITY_ID === c.id) switchCity('home');
    } catch (err) {
      shell.toast('error', `Could not remove ${c.name}: ${(err as Error).message}`);
    }
  }

  function render(force = false) {
    const v = citiesView();
    if (!list.isConnected && modal) return off();
    const sig = [v.data, v.error, [...editors.entries()].map(([id, e]) => [id, e.mode])];
    if (!changed(sig) && !force) return;
    // Re-attaching an open editor drops the caret: keep focus and selection where the user was typing.
    const active = document.activeElement instanceof HTMLInputElement && list.contains(document.activeElement) ? document.activeElement : null;
    const sel = active ? ([active.selectionStart, active.selectionEnd] as const) : null;
    const home = v.data?.home;
    for (const id of [...editors.keys()]) if (!v.data?.cities.some((c) => c.id === id)) editors.delete(id);
    setChildren(
      list,
      home
        ? h(
            'div',
            { class: 'city-row is-home', role: 'listitem' },
            h(
              'div',
              { class: 'city-row-head' },
              h('span', { class: 'swatch', style: { background: STATUS_COLOR.online } }),
              h('div', { class: 'city-row-text' }, h('div', { class: 'city-row-name' }, home.name, !CITY_ID ? h('span', { class: 'city-here' }, 'you are here') : null), h('div', { class: 'city-row-meta' }, h('span', null, 'Home — the CAST this browser is paired with'), h('span', { class: 'city-state is-online' }, `v${home.version}`))),
            ),
          )
        : null,
      v.data?.cities.length ? v.data.cities.map(row) : h('p', { class: 'muted small city-empty' }, 'No other cities yet. Add a machine running CAST to switch to it from the city menu.'),
      v.error ? h('p', { class: 'form-error' }, v.error) : null,
    );
    if (active?.isConnected && sel) {
      active.focus({ preventScroll: true });
      active.setSelectionRange(sel[0], sel[1]);
    }
  }

  let modal: ModalHandle | null = null;
  const off = onCities(() => render());
  render(true);
  modal = openModal(shell.root, shell.layers, {
    id: 'city-manage',
    className: 'modal-city',
    title: 'Cities',
    subtitle: 'Each city is a machine running CAST. Its houses, people and AI accounts stay on that machine.',
    body: h('div', { class: 'city-manage' }, list, h('p', { class: 'city-trust' }, icon('alert', 15), TRUST_LINE)),
    footer: [
      h('button', { type: 'button', class: 'btn btn-soft', onclick: () => { modal?.close(); openAddCity(shell); } }, icon('plus', 15), 'Add a city…'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => modal?.close() }, 'Done'),
    ],
    onClose: () => off(),
  });
  void loadCities();
  return modal;
}
