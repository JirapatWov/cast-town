// The Add a city / Re-pair forms take another machine's pairing link or token: a password for that machine. It is
// hidden while typed or pasted (password-style field, Show / Hide beside it), nothing autofills it or offers to save
// it, and the forms never put it in a text field. (No DOM here: the field's attributes and the toggle wording are
// pure, and the forms are checked in their source.)
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { location?: unknown }).location ??= { pathname: '/', protocol: 'http:', host: 'localhost' };

let secret: typeof import('../../web/src/ui/secret-field.ts');
beforeAll(async () => {
  secret = await import('../../web/src/ui/secret-field.ts');
});

const citiesUi = readFileSync(resolve(import.meta.dir, '../../web/src/ui/cities.ts'), 'utf8');

describe('pairing token field', () => {
  test('a password-style input that password managers and autocorrect leave alone', () => {
    const a = secret.secretInputAttrs({ name: 'pairing' });
    expect(a.type).toBe('password');
    expect(a.autocomplete).toBe('one-time-code'); // not offered for saving as a site password
    expect(a.spellcheck).toBe('false');
    expect(a.autocapitalize).toBe('off');
    expect(a['data-1p-ignore']).toBe('true');
    expect(a.name).toBe('pairing');
    expect(String(a.class)).toContain('input-mono');
  });

  test('the toggle says what it does, for sighted and screen-reader users', () => {
    expect(secret.secretToggleText(false, 'the pairing token')).toEqual({ text: 'Show', label: 'Show the pairing token' });
    expect(secret.secretToggleText(true, 'the pairing token')).toEqual({ text: 'Hide', label: 'Hide the pairing token' });
  });

  test('Add a city and Re-pair both use it; no pairing input is a plain text field', () => {
    expect(citiesUi.match(/secretField\(/g)?.length).toBe(2);
    expect(citiesUi).not.toMatch(/textInput\(\{[^}]*name: 'pairing'/);
    expect(citiesUi).not.toMatch(/textInput\(\{[^}]*placeholder: 'Pairing link/);
    expect(citiesUi).toMatch(/field\('Pairing link or token', pairField\.el/);
  });
});
