// A field for a secret the user pastes (another machine's pairing link or token): hidden like a password so it can't
// be read over a shoulder or in a screen share, with a Show / Hide button to check what was pasted. It is not a
// sign-in password, so password managers are asked to leave it alone (autocomplete one-time-code: browsers don't
// offer to save those; the data-* hints cover common extensions).
import { h } from './dom';

/** The input's attributes: a password-style field that nothing autofills or offers to save. */
export function secretInputAttrs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: 'input input-mono secret-input',
    type: 'password',
    autocomplete: 'one-time-code',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
    ...extra,
  };
}

/** What the toggle says while the secret is hidden or shown (`what` names it for screen readers). */
export function secretToggleText(shown: boolean, what: string): { text: string; label: string } {
  return shown ? { text: 'Hide', label: `Hide ${what}` } : { text: 'Show', label: `Show ${what}` };
}

export interface SecretField {
  /** The row to put in the form (input + Show button). */
  el: HTMLElement;
  input: HTMLInputElement;
  /** Hide it again (after a failed try, the dialog closing). */
  hide(): void;
}

export function secretField(attrs: Record<string, unknown> = {}, what = 'the pairing token'): SecretField {
  const input = h('input', secretInputAttrs(attrs)) as HTMLInputElement;
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm secret-toggle' });
  const set = (shown: boolean) => {
    input.type = shown ? 'text' : 'password';
    const t = secretToggleText(shown, what);
    toggle.textContent = t.text;
    toggle.setAttribute('aria-label', t.label);
  };
  set(false);
  toggle.addEventListener('click', () => {
    set(input.type === 'password');
    input.focus({ preventScroll: true });
  });
  const field: SecretField = {
    el: h('div', { class: 'secret-field' }, input, toggle),
    input,
    hide: () => set(false),
  };
  // the toggle follows the input when the form disables it while busy
  new MutationObserver(() => (toggle.disabled = input.disabled)).observe(input, { attributes: true, attributeFilter: ['disabled'] });
  return field;
}
