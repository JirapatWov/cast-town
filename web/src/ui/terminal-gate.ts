// The browser terminal is a real shell on the server machine, with the rights of the user CAST runs as — nothing about
// it is sandboxed. Before the first shell on a machine this browser asks once, naming the machine and the user; a
// root shell stays marked in red in the dock. When the owner turned the terminal off (config `terminal: false` /
// CAST_TERMINAL=0) the entry points go away and anything that still reaches here says why.
import './css/trust.css';
import type { TerminalAccess } from '../../../shared/terminal-protocol';
import { loadSession, onSession, sessionInfo } from '../net/session';
import { h, setChildren, storage } from './dom';
import { icon } from './icons';
import type { Shell } from './shell';

/** Per city (each city is another machine): the user@host this browser agreed to open shells as. */
const OK_KEY = 'rlt.term.confirmed';

export function terminalAccess(): TerminalAccess | undefined {
  return sessionInfo()?.terminal;
}

/** False only once the server said the terminal is off (unknown → offered; the server refuses /term anyway). */
export function terminalOffered(): boolean {
  return terminalAccess()?.enabled !== false;
}

export const TERMINAL_OFF_TEXT = 'The terminal is turned off on this server. Its owner can turn it on again: "terminal": true in config.json (or remove CAST_TERMINAL=0) and restart CAST.';

function who(t: TerminalAccess): string {
  return `${t.user}@${t.host}`;
}

/** Resolve true when a shell may open now: the terminal is on and this browser confirmed it for this machine/user. */
export async function confirmTerminal(shell: Shell): Promise<boolean> {
  const info = sessionInfo() ?? (await loadSession());
  const t = info?.terminal;
  if (t && !t.enabled) {
    shell.toast('warn', TERMINAL_OFF_TEXT);
    return false;
  }
  if (!t) return true; // an older server: nothing to say who the shell runs as
  if (storage.get(OK_KEY) === who(t)) return true;
  const body = h(
    'div',
    { class: 'term-confirm' },
    h('p', null, 'This opens a real shell on ', h('strong', null, t.host), ' as ', h('strong', null, t.user), '. Anything you type runs with that user’s rights — nothing here is sandboxed, and nothing is checked by an AI.'),
    t.root
      ? h('p', { class: 'term-confirm-root' }, icon('alert', 15), h('span', null, h('strong', null, 'This shell runs as root.'), ' It can change or delete anything on this machine. Running CAST as a normal user is safer.'))
      : null,
    h('p', { class: 'muted small' }, 'The owner can turn the terminal off: "terminal": false in config.json, or CAST_TERMINAL=0, then restart CAST.'),
  );
  const ok = await shell.confirm({ title: 'Open a real shell?', body, confirmLabel: 'Open the terminal', icon: 'terminal', tone: t.root ? 'danger' : 'default' });
  if (ok) storage.set(OK_KEY, who(t));
  return ok;
}

/** The dock's "who am I" chip: user@host, red when root. Fills itself in when the session info arrives. */
export function terminalWhoChip(): HTMLElement {
  const chip = h('span', { class: 'term-chip term-who', hidden: true });
  const render = () => {
    const t = terminalAccess();
    chip.hidden = !t;
    if (!t) return;
    chip.classList.toggle('is-root', t.root);
    chip.title = t.root
      ? `This shell runs as root on ${t.host}: it can change anything on this machine`
      : `Shells here run as ${t.user} on ${t.host}, with that user’s rights`;
    // user and @host apart: a phone's dock keeps only the root marker, and only "root" fits there (css/trust.css).
    setChildren(chip, t.root ? icon('alert', 13) : icon('users', 13), h('span', { class: 'term-who-user' }, t.user), h('span', { class: 'term-who-host' }, `@${t.host}`));
  };
  onSession(render);
  render();
  return chip;
}
