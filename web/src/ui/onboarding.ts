// First-run welcome: three illustrated cards (town / house / person), three plain facts (what the people run on, what
// they can touch on this machine, the Board and Settings) and a clear next step. With no AI account connected nobody
// can work, so that comes first: the first fact says so and the first button connects one. Shown once per device
// (deviceStorage): whoever opens CAST on a new browser should meet it, whichever city they open first.
import { APP_NAME } from '../../../shared/brand';
import { agentsState } from './agents-health';
import { liveProviders } from '../../../shared/live-providers';
import { deviceStorage, h, setChildren } from './dom';
import { icon } from './icons';
import { ONBOARDING_ART } from './illustrations';
import { onboardingTargets } from './suggestions';
import { focusFirst, trapFocus } from './layers';
import type { Shell } from './shell';
import { isPhoneSized, pointWord } from './touch';
import { connectFirst, modelFact, welcomeCards } from './welcome-copy';

const DISMISSED_KEY = 'rlt.onboarded.v1';

export function onboardingDismissed(): boolean {
  return deviceStorage.get(DISMISSED_KEY) === '1'; // a person learns CAST once, not once per city
}

export function createOnboarding(shell: Shell) {
  const { store } = shell;
  const actions = h('div', { class: 'onb-actions' });
  const facts = h('ul', { class: 'onb-facts', 'aria-label': 'Before you start' });
  const cardList = h('ul', { class: 'onb-cards' });
  const panel = h(
    'div',
    { class: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'onb-title' },
    h('h1', { id: 'onb-title', class: 'onb-title' }, 'Welcome to your town'),
    h('p', { class: 'onb-lead' }, `${APP_NAME} turns AI agents into people you can watch, talk to and team up — for code, writing or research.`),
    cardList,
    facts,
    actions,
  );
  const el = h('div', { class: 'onb-backdrop', hidden: true }, panel);
  let removeLayer: (() => void) | null = null;
  let untrap: (() => void) | null = null;
  let sig = ''; // what facts and actions show: re-render only when it changes (keeps focus on a button)
  let cardsFor: boolean | null = null; // the view the cards were written for (Board or 3D)

  function renderCards() {
    cardsFor = shell.focusMode;
    setChildren(
      cardList,
      ...welcomeCards(pointWord(), shell.focusMode, isPhoneSized()).map((c, i) =>
        h('li', { class: 'onb-card glass-strong', style: { '--i': i } }, h('div', { class: 'onb-art', html: ONBOARDING_ART[i] }), h('h2', null, c.title), h('p', null, c.body)),
      ),
    );
  }

  const openProviders = () => {
    close();
    shell.openProviders();
  };

  /** What the people run on: an AI account, or why nobody can work yet (welcome-copy.ts modelFact). */
  function modelFactEl(): HTMLElement {
    const s = store.state;
    const f = modelFact(agentsState(s.hello).kind, liveProviders(s));
    const go = f.button?.to === 'install' ? () => (close(), shell.openHelp('omp')) : openProviders;
    return h(
      'li',
      { class: ['onb-fact', f.tone && `is-${f.tone}`] },
      icon(f.icon, 16, 'onb-fact-icon'),
      h('div', null, h('strong', null, f.strong), f.text, f.cost ? h('span', { class: 'onb-fact-cost' }, f.cost) : null),
      f.button ? h('button', { type: 'button', class: 'btn btn-sm onb-fact-btn', onclick: go }, f.button.icon ? icon(f.button.icon, 14) : null, f.button.label) : null,
    );
  }

  /** What the people run on, and what they can reach here — read before the first task, not discovered after. */
  function renderFacts() {
    const s = store.state;
    const model = modelFactEl();
    const runAs = s.hello?.runAs;
    const safety = h(
      'li',
      { class: 'onb-fact' },
      icon('hand', 16, 'onb-fact-icon'),
      h(
        'div',
        null,
        h('strong', null, runAs ? `People run as the user “${runAs}” on this server. ` : 'People run as the user that started this server. '),
        'Each works in its house’s folder, which is not a sandbox. By default they ask before running commands — in houses without git, before every change too. Change it per house with the permission button.',
      ),
    );
    // Two ways to see the town, and where the device's own choices live (theme, text size, keys, devices).
    const board = shell.focusMode;
    const views = h(
      'li',
      { class: 'onb-fact' },
      icon('board', 16, 'onb-fact-icon'),
      h(
        'div',
        null,
        h('strong', null, 'Two ways to look. '),
        isPhoneSized()
          ? 'The Board lists every house. The 3D town is a bigger download, so a phone starts on the Board. Settings has the theme, text size and your devices.'
          : 'The 3D town, or the Board: every house as a list, lighter on a phone or a slow computer. Settings has the theme, text size, keyboard shortcuts and your devices.',
      ),
      h(
        'div',
        { class: 'onb-fact-btns' },
        h('button', { type: 'button', class: 'btn btn-sm onb-fact-btn', onclick: () => (close(), shell.setFocusMode(!board)) }, icon(board ? 'cube' : 'board', 14), board ? '3D town' : 'Board'),
        h('button', { type: 'button', class: 'btn btn-sm onb-fact-btn', onclick: () => (close(), shell.openSettings()) }, icon('gear', 14), 'Settings'),
      ),
    );
    setChildren(facts, model, safety, views);
  }

  function renderActions() {
    const first = connectFirst(agentsState(store.state.hello).kind, liveProviders(store.state));
    const connect = first
      ? h('button', { type: 'button', class: 'btn btn-lg btn-primary', onclick: openProviders }, icon('key', 17), 'Connect an AI account')
      : null;
    const targets = onboardingTargets(store.state.city.projects);
    const buttons = targets.map((t, i) =>
      h(
        'button',
        {
          type: 'button',
          class: ['btn', 'btn-lg', i === 0 && !first ? 'btn-primary' : 'btn-soft'],
          onclick: () => {
            close();
            if (t.id) shell.enterProject(t.id);
            else shell.openPlacement();
          },
        },
        icon(t.kind === 'place' ? 'folderPlus' : 'home', 17),
        t.label,
      ),
    );
    setChildren(actions, connect, ...buttons, h('button', { type: 'button', class: 'btn btn-ghost btn-lg', onclick: () => close() }, 'Look around first'));
  }

  function renderLive(force = false) {
    const s = store.state;
    const next = JSON.stringify([agentsState(s.hello).kind, liveProviders(s), s.hello?.runAs, onboardingTargets(s.city.projects), shell.focusMode]);
    if (!force && next === sig) return;
    // a board start switches the view under an open welcome: the cards say which view this is
    if (cardsFor !== shell.focusMode) renderCards();
    sig = next;
    renderFacts();
    renderActions();
  }

  function render() {
    renderCards();
    renderLive(true);
  }

  function close(remember = true) {
    if (el.hidden) return;
    if (remember) deviceStorage.set(DISMISSED_KEY, '1');
    removeLayer?.();
    untrap?.();
    removeLayer = untrap = null;
    el.classList.remove('is-open');
    setTimeout(() => (el.hidden = true), 240);
  }

  return {
    el,
    open() {
      render();
      if (!el.hidden) return;
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('is-open'));
      removeLayer = shell.layers.push({ id: 'onboarding', close: () => close(), modal: true });
      untrap = trapFocus(panel);
      requestAnimationFrame(() => focusFirst(panel));
    },
    /** The town, its models or the machine info changed: keep what it says true while it is open. */
    onCity() {
      if (!el.hidden) renderLive();
    },
    get isOpen() {
      return !el.hidden;
    },
  };
}
