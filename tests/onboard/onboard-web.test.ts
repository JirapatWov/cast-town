// g9 (first run, providers copy, wording), web side: with no AI account the town asks to connect one first and says
// nobody can work until then, paths people can tell apart, empty-chat suggestions that fit the job, and the welcome's
// next steps. Pure modules only (no DOM).
import { describe, expect, test } from 'bun:test';
import type { ModelInfo, ProviderStatus } from '../../shared/protocol';
import { liveProviders } from '../../shared/live-providers';
import { modelStatus, noneConnected } from '../../web/src/ui/model-state';
import { shortPath, tildePath } from '../../web/src/ui/display-path';
import { chatSuggestions, onboardingTargets, workKindOf } from '../../web/src/ui/suggestions';
import { connectFirst, modelFact, welcomeCards } from '../../web/src/ui/welcome-copy';

const prov = (connected: boolean, id = 'anthropic'): ProviderStatus => ({ id, connected }) as unknown as ProviderStatus;
const model = (vendor: string, available: boolean): ModelInfo => ({ id: `${vendor}/m`, vendor, available }) as unknown as ModelInfo;

describe('no AI account connected (#26, #27)', () => {
  test('nothing connected → "Connect AI", never a green "0 live"', () => {
    const s = { providers: [prov(false)], models: [model('openai', false)] };
    expect(liveProviders(s)).toBe(0);
    expect(noneConnected(s)).toBe(true);
    expect(modelStatus(s)).toMatchObject({ tone: 'none', label: 'Connect AI' });
    expect(modelStatus({ providers: [], models: [] })).toMatchObject({ tone: 'none', label: 'Connect AI' });
  });
  test('connected providers are counted (cards first, else vendors of available models)', () => {
    expect(modelStatus({ providers: [prov(true), prov(true, 'openai'), prov(false, 'google')], models: [] })).toMatchObject({ tone: 'live', label: '2 live' });
    expect(liveProviders({ providers: [], models: [model('openai', true), model('openai', true), model('deepseek', true)] })).toBe(2);
  });
});

describe('the welcome’s first fact, by state', () => {
  test('nothing connected: amber, connect an account first, nobody can work until then', () => {
    const f = modelFact('ok', 0);
    expect(f.tone).toBe('setup');
    expect(f.strong).toBe('Connect an AI account first. ');
    expect(f.text).toContain('nobody can read, write or run anything');
    expect(f.text).toContain('API key');
    expect(f.button).toEqual({ label: 'Connect an AI account', to: 'providers', icon: 'key' });
  });
  test('the first check runs: says so, no button', () => {
    const f = modelFact('checking', 0);
    expect(f.tone).toBeNull();
    expect(f.strong).toContain('Checking your AI accounts');
    expect(f.text).toContain('The agent can take a minute');
    expect(f.button).toBeNull();
  });
  test('the check failed: nobody can work until one works; leads to Models & providers', () => {
    const f = modelFact('check-failed', 0);
    expect(f.tone).toBe('setup');
    expect(f.strong).toContain('Couldn’t check your AI accounts');
    expect(f.text).toContain('Nobody can work until a check works');
    expect(f.button).toMatchObject({ label: 'Models & providers', to: 'providers' });
    expect(modelFact('check-failed', 2).strong).toBe(f.strong); // a stale count doesn't make it look connected
  });
  test('agent missing: nobody can work until it is built; leads to the build help', () => {
    const f = modelFact('omp-missing', 0);
    expect(f.tone).toBe('setup');
    expect(`${f.strong}${f.text}`).toBe('The agent (cast-agent) isn’t built — nobody can work until it is.');
    expect(f.button).toMatchObject({ label: 'How to build it', to: 'install' });
  });
  test('connected: green, with the count and what leaves this machine', () => {
    expect(modelFact('ok', 1)).toMatchObject({ tone: 'live', strong: '1 provider connected. ' });
    const f = modelFact('ok', 3);
    expect(f.strong).toBe('3 providers connected. ');
    expect(f.text).toContain('sent to that provider');
    expect(f.button).toMatchObject({ label: 'Models & providers', to: 'providers' });
  });
  test('no state calls it a demo or says it works without an account', () => {
    for (const h of ['ok', 'checking', 'omp-missing', 'check-failed'] as const) {
      for (const live of [0, 1]) {
        const f = modelFact(h, live);
        expect(`${f.strong}${f.text}${f.button?.label ?? ''}`).not.toMatch(/\bdemo\b|nothing is billed|local script/i);
      }
    }
  });
  test('connecting comes first while nothing is connected (not while omp is missing); then place or enter leads', () => {
    expect(connectFirst('ok', 0)).toBe(true);
    expect(connectFirst('check-failed', 0)).toBe(true);
    expect(connectFirst('checking', 0)).toBe(true);
    expect(connectFirst('omp-missing', 0)).toBe(false);
    expect(connectFirst('ok', 1)).toBe(false);
  });
});

describe('paths people can tell apart (#85)', () => {
  test('home is written as ~', () => {
    expect(tildePath('/home/me/code/app', '/home/me')).toBe('~/code/app');
    expect(tildePath('/home/me', '/home/me/')).toBe('~');
    expect(tildePath('/home/meow/x', '/home/me')).toBe('/home/meow/x');
    expect(tildePath('/srv/x', null)).toBe('/srv/x');
  });
  test('long paths lose the middle, never the folder name', () => {
    const p = '/tmp/build-cache/runner-7f3a9c11-5b2e-4d0a-9c8e-0e1f2a3b4c5d/work/ws/todo-api';
    const q = '/tmp/build-cache/runner-7f3a9c11-5b2e-4d0a-9c8e-0e1f2a3b4c5d/work/ws/moonlight-novel';
    const a = shortPath(p, null, 40);
    const b = shortPath(q, null, 40);
    expect(a.endsWith('/todo-api')).toBe(true);
    expect(b.endsWith('/moonlight-novel')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith('/tmp/…/')).toBe(true);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(shortPath('/home/me/a/b/c/d/e/f/g/project', '/home/me', 20)).toBe('~/…/d/e/f/g/project'); // 19 characters: as many last folders as fit
    expect(shortPath('/short/path', null, 40)).toBe('/short/path');
  });
});

describe('empty-chat suggestions fit the job (#29)', () => {
  const assistant = { kind: 'resident', roleId: 'assistant', name: 'Assistant' } as const;
  test('a writing job gets writing asks, not "fix the failing tests"', () => {
    const k = workKindOf({ jobKind: 'write' });
    expect(k).toBe('write');
    const tips = chatSuggestions(assistant as never, k);
    expect(tips).toContain('Write the next chapter');
    expect(tips.join(' ')).not.toMatch(/tests|code/i);
  });
  test('the job kind decides; a team id no longer does (no example teams); nothing known → general', () => {
    expect(workKindOf({ jobKind: 'research' })).toBe('research');
    expect(workKindOf({ jobKind: 'code' })).toBe('code');
    expect(workKindOf({ jobKind: 'general', workflowId: 'novel' } as never)).toBe('general');
    expect(workKindOf({ jobKind: 'general', workflowId: 'decode-implement-review' } as never)).toBe('general');
    expect(workKindOf({ jobKind: null })).toBe('general');
    expect(workKindOf({})).toBe('general');
    expect(chatSuggestions(assistant as never, 'code')).toContain('Fix the failing tests and get them reviewed');
    expect(chatSuggestions({ kind: 'subagent', roleId: null, name: 'h' } as never, 'code')).toEqual([]);
  });
});

describe('the welcome’s next step after connecting (#29)', () => {
  test('one house → enter it; none → place one', () => {
    expect(onboardingTargets([{ id: 'x', name: 'mine' }])).toEqual([{ id: 'x', label: 'Enter mine', kind: 'enter' }]);
    expect(onboardingTargets([])).toEqual([{ id: null, label: 'Place your first project', kind: 'place' }]);
  });
  test('houses named like the old samples get no special offer: the first house, like any other', () => {
    const t = onboardingTargets([{ id: 'p1', name: 'todo-api' }, { id: 'p2', name: 'moonlight-novel' }]);
    expect(t).toEqual([{ id: 'p1', label: 'Enter todo-api', kind: 'enter' }]);
    expect(onboardingTargets([{ id: 'p2', name: 'moonlight-novel' }, { id: 'p1', name: 'todo-api' }])[0]!.id).toBe('p2');
  });
});

describe('the folder name stays in view on narrow cards (#85)', () => {
  test('pathParts splits the shortened path before the folder name', async () => {
    const { pathParts } = await import('../../web/src/ui/display-path');
    const p = '/tmp/build-cache/runner-7f3a9c11-5b2e-4d0a-9c8e-0e1f2a3b4c5d/work/ws/todo-api';
    const { head, tail } = pathParts(p, null, 44);
    expect(tail).toBe('/todo-api');
    expect(head.endsWith('/')).toBe(false);
    expect(head + tail).toBe(shortPath(p, null, 44));
    expect(pathParts('/home/me', '/home/me')).toEqual({ head: '', tail: '~' });
    expect(pathParts('/home/me/notes', '/home/me')).toEqual({ head: '~', tail: '/notes' });
    expect(pathParts('/srv', null)).toEqual({ head: '', tail: '/srv' });
    expect(pathParts('/', null)).toEqual({ head: '', tail: '/' });
  });
  test('cards and the place dialog render the path as head + tail (the head is what CSS cuts)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const root = `${import.meta.dir}/../../web/src/ui`;
    expect(readFileSync(`${root}/focus-view.ts`, 'utf8')).toContain("pathLine('p', 'fv-path'");
    expect(readFileSync(`${root}/placement.ts`, 'utf8')).toContain("pathLine('span', 'picked-path'");
    const css = readFileSync(`${root}/css/hud.css`, 'utf8');
    expect(css).toMatch(/\.path-head\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.path-tail\s*\{[^}]*flex:\s*0 0 auto/);
  });
});

describe('the welcome points at the Board (#29)', () => {
  test('the town card says where the plain list is; the person card follows the pointer word', async () => {
    const { welcomeCards } = await import('../../web/src/ui/welcome-copy');
    const cards = welcomeCards('Tap');
    expect(cards).toHaveLength(3);
    expect(cards[0]!.body).toContain('Board');
    expect(cards[0]!.body).not.toMatch(/take the car/);
    expect(cards[2]!.body.startsWith('Tap someone')).toBe(true);
    expect(welcomeCards('Click')[2]!.body.startsWith('Click someone')).toBe(true);
  });
  test('on a phone it points at the More menu: its top bar has no Board / 3D switch', () => {
    for (const board of [false, true]) {
      expect(welcomeCards('Tap', board, true)[0]!.body).toContain('More menu');
      expect(welcomeCards('Tap', board, true)[0]!.body).not.toContain('top bar');
    }
    expect(welcomeCards('Click', false, false)[0]!.body).toContain('top bar');
  });
});

describe('nothing sits on top of the welcome (first run)', () => {
  test('the 3D loading caption is hidden while the welcome is open', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const css = readFileSync(`${import.meta.dir}/../../web/src/ui/css/dialogs.css`, 'utf8');
    expect(css).toMatch(/body:has\(\.rlt-ui \.onb-backdrop\.is-open\) #curtain-note \{\s*visibility: hidden;/);
    // the caption still lives outside the UI layer, above it (why the rule is needed)
    const html = readFileSync(`${import.meta.dir}/../../web/index.html`, 'utf8');
    expect(html).toContain('id="curtain-note"');
  });
});
