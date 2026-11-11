// The banner under the top bar about the agent and the AI accounts (agents-health.ts), most important first:
//   agent missing   — nobody can work: the build command, the install guide, Check again
//   check failed    — the real reason; nobody can work until a check works; Retry
//   checking        — the first account check still runs (the agent can take a minute on a busy computer)
//   another version — CAST is tested with one agent release (shared/omp-version.ts); dismissed per version
// None while offline: the reconnect banner has that spot. The first two can be closed until they change.
// "How to fix" opens Help at its Agent section: the build command, with Copy.
import { AGENT_BUILD_COMMAND, ompVersionWarning } from '../../../shared/omp-version';
import { agentsState, recheckAgents } from './agents-health';
import './css/health.css';
import { h, setChildren, storage } from './dom';
import { projectLinks } from './help-info';
import { icon } from './icons';
import type { Shell } from './shell';

/** The agent version whose warning was dismissed. */
const DISMISSED_KEY = 'rlt.ompWarning.dismissed';

type Banner = { key: string; tone: 'error' | 'warn' | 'info'; body: Node[]; close?: () => void };

export function createOmpWarning(shell: Shell) {
  const text = h('span', { class: 'omp-warn-text' });
  const mark = h('span', { class: 'omp-warn-icon', 'aria-hidden': 'true' });
  const close = h('button', { type: 'button', class: 'omp-warn-close', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: dismiss }, icon('x', 14));
  const el = h('div', { class: 'omp-warn glass', role: 'status', hidden: true }, mark, text, close);
  let shown = '';
  let current: Banner | null = null;
  // its height, for the town board under it on a phone (health.css)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (!el.hidden) shell.root.style.setProperty('--omp-banner-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    }).observe(el);
  }
  const closed = new Set<string>(); // this page only: back after a reload, or when the state changes

  const btn = (label: string, onclick: () => void, busy = false) =>
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm omp-warn-btn', disabled: busy, onclick }, busy ? h('span', { class: 'spinner spinner-sm' }) : null, busy ? 'Checking…' : label);
  const fix = () => h('button', { type: 'button', class: 'omp-warn-fix', onclick: () => shell.openHelp('omp') }, 'How to fix');
  // CAST's own README; without a public repository Help says where the guide is
  const installGuide = (): Node[] => {
    const links = projectLinks();
    return links ? [h('span', null, ' · '), h('a', { href: `${links.home}#install`, target: '_blank', rel: 'noopener noreferrer' }, 'Install guide')] : [];
  };

  function banner(): Banner | null {
    const { hello, connected } = shell.store.state;
    if (!hello || !connected) return null;
    const st = agentsState(hello);
    const checking = !!hello.agents?.checking;
    if (st.kind === 'omp-missing') {
      return {
        key: `missing:${st.path}`,
        tone: 'error',
        body: [
          h('span', null, `The agent (cast-agent) isn’t built, so nobody can work yet (CAST looked at ${st.path}). In the CAST folder, run `),
          h('code', { class: 'omp-warn-cmd', title: 'Run this in a terminal, then press Check again' }, AGENT_BUILD_COMMAND),
          ...installGuide(),
          fix(),
          btn('Check again', () => recheckAgents(shell), checking),
        ],
        close: () => closed.add(`missing:${st.path}`),
      };
    }
    if (st.kind === 'check-failed') {
      const key = `failed:${st.reason}`;
      return {
        key,
        tone: 'warn',
        body: [h('span', null, `Couldn’t check your AI accounts: ${st.reason}. Nobody can work until a check works — CAST tries again by itself.`), btn('Retry', () => recheckAgents(shell), checking)],
        close: () => closed.add(key),
      };
    }
    if (st.kind === 'checking') {
      return { key: 'checking', tone: 'info', body: [h('span', { class: 'spinner spinner-sm' }), h('span', null, 'Checking AI accounts… The agent can take a minute on a busy computer. Messages wait for it.')] };
    }
    const w = ompVersionWarning(hello.ompVersion, hello.ompTested || undefined); // a server from before the pin sends none
    if (w && storage.get(DISMISSED_KEY) !== hello.ompVersion) {
      return {
        key: `version:${hello.ompVersion}`,
        tone: 'warn',
        body: [h('span', null, w), fix()],
        close: () => {
          if (hello.ompVersion) storage.set(DISMISSED_KEY, hello.ompVersion);
        },
      };
    }
    return null;
  }

  function render() {
    let b = banner();
    if (b && closed.has(b.key)) b = null;
    current = b;
    el.hidden = !b;
    shell.root.classList.toggle('has-omp-banner', !!b);
    if (!b) {
      shown = '';
      return;
    }
    const key = `${b.key}|${shell.store.state.hello?.agents?.checking}`;
    if (key === shown) return;
    shown = key;
    el.dataset.tone = b.tone;
    setChildren(mark, icon(b.tone === 'info' ? 'sparkle' : 'alert', 15));
    mark.hidden = b.tone === 'info'; // the spinner says it
    setChildren(text, ...b.body);
    close.hidden = !b.close;
  }

  function dismiss() {
    current?.close?.();
    render();
  }

  return { el, render };
}
