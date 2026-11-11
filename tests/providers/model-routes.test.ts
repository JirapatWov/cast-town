// F4: the same model name reached through two sign-ins (Claude Opus 5.5 from Anthropic, and through Antigravity) is
// told apart in every model picker: the server says which sign-in an extra runs through (ModelInfo.route), pickers name
// it when the name is shared ("Claude Opus 5.5 · via Antigravity") and group a sign-in's extras under it.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, routeOf } from '../../server/agents/models';
import type { ModelInfo } from '../../shared/protocol';
import { modelGroupTitle, modelGroups, modelLabel, modelNames } from '../../web/src/ui/format';
import { modelOptions } from '../../web/src/ui/plans';

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-routes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function registry(models: { provider: string; id: string; name?: string }[]): ModelRegistry {
  const bin = join(tmp, `omp-${Math.random().toString(36).slice(2)}.sh`);
  const json = JSON.stringify({ models: models.map((m) => ({ ...m, selector: `${m.provider}/${m.id}` })) });
  writeFileSync(bin, `#!/bin/bash\nif [ "$1" = models ]; then echo '${json}'; exit 0; fi\nexit 3\n`);
  chmodSync(bin, 0o755);
  return new ModelRegistry(bin, { HOME: tmp, PATH: process.env.PATH });
}

/** Anthropic signed in, and Antigravity (a Google sign-in that also serves Claude). */
async function both(): Promise<ModelInfo[]> {
  const r = registry([
    { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { provider: 'google-antigravity', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { provider: 'google-antigravity', id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { provider: 'google-antigravity', id: 'gemini-4-flash', name: 'Gemini 4 Flash' },
  ]);
  await r.detect();
  return r.models();
}

describe('ModelInfo.route (server)', () => {
  test('extras name the sign-in they run through; a maker’s own API and the catalog don’t', async () => {
    const models = await both();
    const by = (id: string) => models.find((m) => m.id === id)!;
    expect(by('google-antigravity/claude-opus-5-5')).toMatchObject({ label: 'Claude Opus 5.5', vendor: 'google', route: 'Antigravity', available: true });
    expect(by('anthropic/claude-opus-5-5').route).toBeUndefined();
    expect(by('google/gemini-4-argon').route).toBeUndefined(); // the catalog entry: whichever Google sign-in has it
    expect(routeOf('openai-codex')).toBe('ChatGPT');
    expect(routeOf('openrouter')).toBe('OpenRouter');
    expect(routeOf('anthropic')).toBeUndefined();
    expect(routeOf('xai')).toBe('xAI API'); // the name omp's sign-in menu gives it
    expect(routeOf('github-copilot')).toBe('GitHub Copilot');
    expect(routeOf('my-llm')).toBe('My llm'); // a provider of the user's models.yml: after its id
  });
});

describe('every signed-in provider keeps its models in the pickers', () => {
  test('a provider with hundreds of models (xAI here) doesn’t push another one’s out: at most 40 each', async () => {
    const r = registry([
      ...Array.from({ length: 70 }, (_, i) => ({ provider: 'xai', id: `grok-${i}` })),
      { provider: 'cerebras', id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
      { provider: 'github-copilot', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    ]);
    await r.detect();
    const models = r.models();
    expect(models.filter((m) => m.id.startsWith('xai/'))).toHaveLength(40);
    expect(models.find((m) => m.id === 'cerebras/gpt-oss-120b')).toMatchObject({ available: true, route: 'Cerebras' });
    expect(models.find((m) => m.id === 'github-copilot/claude-opus-5-5')).toMatchObject({ available: true, route: 'GitHub Copilot' });
  });
});

describe('pickers (client helpers)', () => {
  test('a shared name says its route; a name of its own stays as it is', async () => {
    const models = await both();
    const names = modelNames(models);
    expect(names.get('anthropic/claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(names.get('google-antigravity/claude-opus-5-5')).toBe('Claude Opus 5.5 · via Antigravity');
    expect(names.get('google-antigravity/gemini-4-argon')).toBe('Gemini 4 Argon · via Antigravity'); // the catalog has one too
    expect(names.get('google-antigravity/gemini-4-flash')).toBe('Gemini 4 Flash');
    expect(modelLabel('google-antigravity/claude-opus-5-5', models)).toBe('Claude Opus 5.5 · via Antigravity');
    expect(modelNames(models)).toBe(names); // kept per list
  });

  test('a sign-in’s extras get a section of their own, after the maker’s own models', async () => {
    const models = await both();
    const groups = modelGroups(models);
    const titles = groups.map(modelGroupTitle);
    expect(titles.indexOf('Google · via Antigravity')).toBe(titles.indexOf('Google') + 1);
    const via = groups.find((g) => g.route === 'Antigravity')!;
    expect(via.models.map((m) => m.id)).toEqual(['google-antigravity/claude-opus-5-5', 'google-antigravity/gemini-4-argon', 'google-antigravity/gemini-4-flash']);
    expect(groups.find((g) => g.vendor === 'anthropic' && !g.route)!.models.some((m) => m.id === 'anthropic/claude-opus-5-5')).toBe(true);
    expect(modelGroupTitle({ vendor: 'openrouter', route: 'OpenRouter' })).toBe('OpenRouter');
    expect(modelGroupTitle({ vendor: 'other', route: 'Xai' })).toBe('Xai');
  });

  test('the plan card’s select: connected models, named the same way, a route’s models together', async () => {
    const models = await both();
    const opts = modelOptions(models, 'anthropic/claude-opus-5-5');
    expect(opts.find((o) => o.id === 'google-antigravity/claude-opus-5-5')).toMatchObject({ label: 'Claude Opus 5.5 · via Antigravity', route: 'Antigravity' });
    const google = opts.filter((o) => o.vendor === 'google').map((o) => o.route ?? '');
    expect(google.lastIndexOf('')).toBeGreaterThanOrEqual(0);
    expect(google.lastIndexOf('')).toBeLessThan(google.indexOf('Antigravity')); // Google's own first, then Antigravity's
  });
});
