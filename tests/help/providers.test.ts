// Models & providers (finding #73): the README and the app agree. OpenRouter, which the docs name, has a card with its
// sign-in before anything is connected (it used to appear only once already connected, so it could never be set up in
// the app), and connected accounts list omp's other models next to the tested catalog.
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CATALOG, ModelRegistry } from '../../server/agents/models';

const tmp = mkdtempSync(join(tmpdir(), 'cast-test-prov-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake omp whose `models --json` lists these credentialed models. */
function registry(name: string, models: { provider: string; id: string; name?: string }[]): ModelRegistry {
  const bin = join(tmp, `${name}.sh`);
  const json = JSON.stringify({ models: models.map((m) => ({ ...m, selector: `${m.provider}/${m.id}` })) });
  writeFileSync(bin, `#!/bin/bash\nif [ "$1" = models ]; then echo '${json}'; exit 0; fi\nexit 3\n`);
  chmodSync(bin, 0o755);
  return new ModelRegistry(bin, { HOME: tmp, PATH: process.env.PATH });
}

describe('provider cards', () => {
  test('nothing connected: one card per vendor with a sign-in, OpenRouter included, no "Other providers"', async () => {
    const r = registry('none', []);
    await r.detect();
    expect(r.providers().map((p) => p.vendor)).toEqual(['anthropic', 'openai', 'deepseek', 'google', 'openrouter']);
    expect(r.providers().every((p) => !p.connected)).toBe(true);
    expect(r.providers().find((p) => p.vendor === 'openrouter')!.how).toContain('cast-agent login openrouter');
  });

  test('"Other providers" appears once a provider CAST has no card for is connected', async () => {
    const r = registry('other', [{ provider: 'zai', id: 'glm-9' }]);
    await r.detect();
    const other = r.providers().find((p) => p.vendor === 'other');
    expect(other?.connected).toBe(true);
  });

  test('OpenRouter connected: its card says so, and its models are listed by maker with openrouter/ ids', async () => {
    const r = registry('or', [
      { provider: 'openrouter', id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5 (OpenRouter)' },
      { provider: 'openrouter', id: 'meta-llama/llama-5-70b' },
    ]);
    await r.detect();
    expect(r.providers().find((p) => p.vendor === 'openrouter')!.connected).toBe(true);
    const models = r.models();
    expect(models.slice(0, DEFAULT_CATALOG.length).map((m) => m.id)).toEqual(DEFAULT_CATALOG.map((m) => m.id)); // the tested catalog first
    expect(models.find((m) => m.id === 'openrouter/anthropic/claude-opus-5-5')).toMatchObject({ vendor: 'anthropic', available: true });
    expect(models.find((m) => m.id === 'openrouter/meta-llama/llama-5-70b')).toMatchObject({ vendor: 'openrouter', available: true });
    // CAST never runs the catalog's Claude through OpenRouter on its own: the user picks the openrouter/ model
    expect(r.isAvailable('anthropic/claude-opus-5-5')).toBe(false);
  });
});
