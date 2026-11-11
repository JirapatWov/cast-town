// Run once against the engine BEFORE the continuation change: writes golden/prompts.json (E12).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from './cworld';
import { runScenarios } from './golden-scenarios';

const out = await runScenarios();
mkdirSync(join(import.meta.dir, 'golden'), { recursive: true });
writeFileSync(join(import.meta.dir, 'golden', 'prompts.json'), `${JSON.stringify(out, null, 2)}\n`);
cleanup();
console.log(Object.entries(out).map(([k, v]) => `${k}: ${v.length - 1} prompts — ${v[0]}`).join('\n'));
