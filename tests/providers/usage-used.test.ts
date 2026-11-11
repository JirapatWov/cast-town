// Usage in Models & providers says what is USED, never what is left (web/src/ui/usage-text.ts, providers-order.ts):
//   - the share used comes from omp's usedPct, else 100 − remainingPct, else used / limit;
//   - the colour: warning from 75 % used (or omp's "warning"), error at 100 % used (or "exhausted");
//   - the line after a bar: "17% used · resets in 3 h 9 min", "4.2 of 25 h used" where omp gives amounts;
//   - a card's folded usage says its most-used limit: "5h 38% used".
// And what the page lists beyond the featured cards (web/src/ui/provider-catalog.ts): every sign-in of omp's menu,
// grouped and searchable with the connected ones first; a card for each other signed-in provider; folded parts.
import { describe, expect, test } from 'bun:test';
import type { ModelInfo, ProviderAccount, UsageLimit } from '../../shared/protocol';
import { OMP_LOGIN_PROVIDERS } from '../../shared/omp-logins';
import { amountText, fmtPct, usageLevel, usageLine, usedPct, usedText, WARN_USED_PCT } from '../../web/src/ui/usage-text';
import { limitBrief, tightestLimit } from '../../web/src/ui/providers-order';
import {
  connectedLogins, deviceCode, groupLogins, matchesLogin, modelCount, otherProviders, parseOpenParts, serializeOpenParts, signedInProviders, signInHome,
} from '../../web/src/ui/provider-catalog';

const L = (over: Partial<UsageLimit>): UsageLimit => ({ id: 'x:5h', label: '5 Hour', window: '5 Hour', remainingPct: null, usedPct: null, status: 'ok', ...over });
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

describe('how much is used', () => {
  test('omp’s used share first, else what is left turned round, else the amounts', () => {
    expect(usedPct(L({ usedPct: 17, remainingPct: 10 }))).toBe(17);
    expect(usedPct(L({ remainingPct: 62 }))).toBe(38);
    expect(usedPct(L({ used: 5, limit: 20 }))).toBe(25);
    expect(usedPct(L({ remainingPct: -5 }))).toBe(100);
    expect(usedPct(L({ usedPct: 140 }))).toBe(100);
    expect(usedPct(L({}))).toBeNull();
    expect(usedPct(L({ used: 3, limit: 0 }))).toBeNull();
  });

  test('warning from 75 % used, error when used up; omp’s own status counts too', () => {
    expect(WARN_USED_PCT).toBe(75);
    expect(usageLevel(L({ usedPct: 74 }))).toBe('ok');
    expect(usageLevel(L({ usedPct: 75 }))).toBe('warn');
    expect(usageLevel(L({ remainingPct: 20 }))).toBe('warn');
    expect(usageLevel(L({ usedPct: 100 }))).toBe('err');
    expect(usageLevel(L({ usedPct: 10, status: 'warning' }))).toBe('warn');
    expect(usageLevel(L({ usedPct: 10, status: 'exhausted' }))).toBe('err');
    expect(usageLevel(L({ status: 'unknown' }))).toBe('ok');
  });

  test('a sliver is never rounded to 0 % or 100 %', () => {
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(0.3)).toBe('<1%');
    expect(fmtPct(99.7)).toBe('99%');
    expect(fmtPct(100)).toBe('100%');
  });

  test('the line after a bar: used, then when it resets', () => {
    expect(usageLine(L({ remainingPct: 83, resetsAt: NOW + (3 * 60 + 9) * 60_000 }), NOW)).toBe('17% used · resets in 3 h 9 min');
    expect(usageLine(L({ usedPct: 40, resetsAt: NOW + 25 * 60_000 }), NOW)).toBe('40% used · resets in 25 min');
    expect(usageLine(L({ usedPct: 0, reset: true, resetsAt: NOW + 60_000 }), NOW)).toBe('0% used · reset just now');
    expect(usageLine(L({ usedPct: 12 }), NOW)).toBe('12% used');
    expect(usageLine(L({}), NOW)).toBe('Usage unknown');
    for (const l of [L({ remainingPct: 83 }), L({ usedPct: 5, resetsAt: NOW + 1e6 }), L({ used: 1, limit: 4, unit: 'tokens' })]) {
      expect(usageLine(l, NOW)).not.toMatch(/left|remaining/i);
    }
  });

  test('amounts where omp gives them: hours, tokens, dollars; a percentage stays a percentage', () => {
    expect(amountText({ used: 252, limit: 1500, unit: 'minutes' })).toBe('4.2 of 25 h used');
    expect(amountText({ used: 30, limit: 90, unit: 'minutes' })).toBe('30 of 90 min used');
    expect(amountText({ used: 1_200_000, limit: 5_000_000, unit: 'tokens' })).toBe('1.2M of 5M tokens used');
    expect(amountText({ used: 4.2, limit: 25, unit: 'usd' })).toBe('$4.20 of $25 used');
    expect(amountText({ used: 17, limit: 100, unit: 'percent' })).toBeNull();
    expect(amountText({ used: 3, limit: 0, unit: 'tokens' })).toBeNull();
    expect(usedText(L({ used: 17, limit: 100, unit: 'percent', usedPct: 17 }))).toBe('17% used');
  });

  test('a card’s folded usage: its most-used limit, short', () => {
    const limits = [L({ id: 'a:5h', remainingPct: 62 }), L({ id: 'a:7d', label: '7 Day (Fable)', window: '7 Day (Fable)', remainingPct: 88 })];
    expect(tightestLimit(limits)?.id).toBe('a:5h');
    expect(limitBrief(limits)).toEqual({ text: '5h 38% used', level: 'ok' });
    expect(limitBrief([L({ usedPct: 91, window: '7 Day' })])).toEqual({ text: '7d 91% used', level: 'warn' });
    expect(limitBrief([L({})])).toBeNull();
    expect(limitBrief(undefined)).toBeNull();
  });
});

const M = (id: string, available = true): ModelInfo => ({ id, label: id.split('/')[1]!, vendor: 'other' as ModelInfo['vendor'], available });
const A = (provider: string, credentialId: number): ProviderAccount => ({ provider, credentialId, label: `API key #${credentialId}` }) as ProviderAccount;

describe('what the page lists beyond the featured cards', () => {
  test('every sign-in of omp’s menu, in four groups, connected ones first', () => {
    const groups = groupLogins('', new Set(['cerebras']));
    expect(groups.map((g) => g.group)).toEqual(['signin', 'key', 'cloud', 'other']);
    expect(groups.reduce((n, g) => n + g.providers.length, 0)).toBe(OMP_LOGIN_PROVIDERS.length);
    const cloud = groups.find((g) => g.group === 'cloud')!;
    expect(cloud.providers[0]!.id).toBe('cerebras');
    expect(cloud.connected).toBe(1);
  });

  test('search: every word somewhere in the name, id, kind or group', () => {
    const copilot = OMP_LOGIN_PROVIDERS.find((p) => p.id === 'github-copilot')!;
    expect(matchesLogin(copilot, 'copilot')).toBe(true);
    expect(matchesLogin(copilot, 'GitHub device')).toBe(true);
    expect(matchesLogin(copilot, 'copilot key')).toBe(false);
    const hits = groupLogins('llama', new Set()).flatMap((g) => g.providers.map((p) => p.id));
    expect(hits).toContain('llama.cpp');
    expect(groupLogins('zzzz-nothing', new Set())).toEqual([]);
  });

  test('signed in: a stored account, or a model running through the provider; aliases count for their target', () => {
    const signedIn = signedInProviders([M('cerebras/gpt-oss-120b'), M('zai/glm-5', false)], [A('openai-codex', 1)]);
    expect([...signedIn].sort()).toEqual(['cerebras', 'openai-codex']);
    const on = connectedLogins(signedIn);
    expect(on.has('openai-codex')).toBe(true);
    expect(on.has('openai-codex-device')).toBe(true);
    expect(on.has('cerebras')).toBe(true);
    expect(on.has('zai')).toBe(false);
  });

  test('a card for each other signed-in provider, its models and accounts; featured ones are not repeated', () => {
    const cards = otherProviders(
      [M('anthropic/claude-opus-5-5'), M('cerebras/gpt-oss-120b'), M('cerebras/qwen-4'), M('github-copilot/gpt-6'), M('my-llm/big')],
      [A('github-copilot', 4), A('anthropic', 1)],
    );
    expect(cards.map((c) => c.provider)).toEqual(['github-copilot', 'cerebras', 'my-llm']);
    expect(cards[0]).toMatchObject({ label: 'GitHub Copilot', login: { id: 'github-copilot' } });
    expect(cards[0]!.accounts.map((a) => a.credentialId)).toEqual([4]);
    expect(cards[1]!.models).toHaveLength(2);
    expect(cards[2]).toMatchObject({ label: 'My llm' });
    expect(cards[2]!.login).toBeUndefined();
  });

  test('where a sign-in’s steps show: the featured card, the provider’s own card, or its row', () => {
    expect(signInHome('anthropic', new Set())).toBe('vendor');
    expect(signInHome('openai-codex-device', new Set())).toBe('vendor');
    expect(signInHome('cerebras', new Set(['cerebras']))).toBe('card');
    expect(signInHome('cerebras', new Set())).toBe('list');
  });

  test('folded parts remembered per device; junk ignored', () => {
    const open = parseOpenParts(serializeOpenParts(new Set(['models:v:anthropic', 'usage:p:cerebras'])));
    expect([...open].sort()).toEqual(['models:v:anthropic', 'usage:p:cerebras']);
    for (const raw of [null, '', 'nope', '[1]', '{"a":1}', 'null']) expect(parseOpenParts(raw).size).toBe(0);
    expect(modelCount(1)).toBe('1 model');
    expect(modelCount(12)).toBe('12 models');
  });

  test('a device code from the sign-in’s code field or its instructions', () => {
    expect(deviceCode({ userCode: 'ABCD-1234' })).toBe('ABCD-1234');
    expect(deviceCode({ instructions: 'Enter code: WXYZ-9876' })).toBe('WXYZ-9876');
    expect(deviceCode({ instructions: 'Copy your API key' })).toBeNull();
  });
});
