// Settings → Pair a phone, the parts for CAST as an installed app:
//  • the short code beside the QR code, to type into CAST on a Home Screen (that app has its own sign-in);
//  • "Install CAST on this device": the steps for this platform (web/src/pwa/install.ts), with Chrome's Install
//    button, or — on an iPhone in Safari — "Copy a link for the app", which makes a one-time link and copies it in
//    the same tap (Safari forgets the tap after an await: the copy gets a promise of the text instead).
import { newPairingLink } from '../net/session';
import { canPromptInstall, currentPlatform, formatShortCode, installHelp, onInstallPrompt, promptInstall } from '../pwa/install';
import { h, setChildren } from './dom';
import { icon } from './icons';
import type { Shell } from './shell';

/** "Or type this code in the CAST app": the short code, big, with a Copy button. */
export function shortCodeBlock(shell: Shell, short: string): HTMLElement | null {
  if (!short) return null;
  const code = formatShortCode(short);
  const copy = h('button', { type: 'button', class: 'btn btn-soft btn-sm' }, icon('copy', 14), 'Copy code');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      shell.toast('success', 'Code copied — it works once.');
    } catch {
      shell.toast('warn', 'Copy failed — type the code instead.');
    }
  });
  return h(
    'div',
    { class: 'set-pair-short' },
    h('p', { class: 'set-note' }, 'Or type this code in the CAST app:'),
    h('div', { class: 'set-pair-row' }, h('code', { class: 'set-short-code', 'aria-label': `Pairing code ${code.split('').join(' ')}` }, code), copy),
    h('p', { class: 'muted small' }, 'Scanning the QR code pairs Safari. For CAST on your Home Screen, type the code in the app instead.'),
  );
}

/** Copy a fresh one-time link in the same tap (ClipboardItem with a promise); null when that isn't possible here. */
async function copyFreshLink(): Promise<{ link: string; copied: boolean }> {
  const made = newPairingLink().then((r) => r.link);
  const CI = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (CI && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new CI({ 'text/plain': made.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return { link: await made, copied: true };
    } catch {
      /* fall back below */
    }
  }
  const link = await made;
  try {
    await navigator.clipboard.writeText(link);
    return { link, copied: true };
  } catch {
    return { link, copied: false };
  }
}

/** The "Install CAST on this device" block. */
export function installBlock(shell: Shell): HTMLElement {
  const body = h('div', { class: 'set-install-body' });
  const out = h('div', { 'aria-live': 'polite' });
  const render = () => {
    const help = installHelp(currentPlatform(), canPromptInstall());
    const steps = help.steps.length > 1 ? h('ol', { class: 'set-install-steps' }, help.steps.map((s) => h('li', null, s))) : h('p', { class: help.done ? 'set-note set-ok' : 'set-note' }, help.steps[0]);
    let button: HTMLElement | null = null;
    if (help.button === 'copy-app-link') {
      const b = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('copy', 14), 'Copy a link for the app');
      b.addEventListener('click', async () => {
        b.setAttribute('disabled', '');
        try {
          const r = await copyFreshLink();
          if (r.copied) {
            shell.toast('success', 'Copied — works once, for 10 minutes. Paste it in the CAST app.');
            setChildren(out);
          } else {
            setChildren(out, h('p', { class: 'set-note' }, 'Select the link and copy it:'), h('code', { class: 'set-link', tabindex: '0' }, r.link));
          }
        } catch (err) {
          shell.toast('error', `Could not make a link: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          b.removeAttribute('disabled');
        }
      });
      button = b;
    } else if (help.button === 'install') {
      const b = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('plus', 14), 'Install CAST');
      b.addEventListener('click', () => void promptInstall().then(render));
      button = b;
    }
    setChildren(body, steps, button ? h('div', { class: 'set-actions' }, button) : null, out);
  };
  render();
  const off = onInstallPrompt(render);
  const el = h('div', { class: 'set-install' }, h('h4', { class: 'set-sub' }, 'Install CAST on this device'), body);
  let shown = false;
  new MutationObserver((_m, obs) => {
    if (el.isConnected) shown = true;
    else if (shown) {
      off(); // the dialog closed
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  return el;
}
