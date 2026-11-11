import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from './cworld';
import { leadScenarios } from './lead-scenarios';
const out = await leadScenarios();
writeFileSync(join(import.meta.dir, 'golden', 'lead-replies.orig.json'), `${JSON.stringify(out, null, 2)}\n`);
cleanup();
console.log(Object.keys(out).join('\n'));
