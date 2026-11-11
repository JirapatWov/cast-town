// Adversarial review R6: the demo lead (the LLM in demo mode and the mock e2e) took ordinary team asks that say
// "only"/"just" for a continuation of the last run — "team" counted as naming a part of the run, and "just fix …"
// needed no part at all — so "ask the team to fix only the typo" continued an unrelated earlier run (or failed with
// "no team run to continue") instead of starting the team on it.
import { expect, test } from 'bun:test';
import { LEAD_TOOL_NAMES } from '../../server/agents/lead-tools.ts';
import { classifyAsk } from '../../server/agents/demo/assistant.ts';

const tools = new Set(LEAD_TOOL_NAMES);

test('team asks with "only"/"just" that name no part of the run start the team', () => {
  for (const ask of [
    'ask the team to fix only the typo in README',
    'have the team fix the login bug, just make sure the tests pass',
    'ให้ทีมแก้แค่ไฟล์ server.ts',
  ]) {
    expect({ ask, intent: classifyAsk(ask, tools) }).toEqual({ ask, intent: 'team-run' });
  }
});

test('plain asks with "just fix" / "just rerun" are not a continuation', () => {
  for (const ask of ['just fix the typo in README.md', 'please just rerun the tests in server.ts']) {
    expect({ ask, intent: classifyAsk(ask, tools) }).not.toEqual({ ask, intent: 'team-continue' });
  }
});

test('asks that name a part of the run still continue it', () => {
  for (const ask of ['just redo the review', 'just fix the last step', 'fix only the later part', 'แก้แค่ขั้นสุดท้าย', 'ให้ทีมแก้แค่ส่วนท้าย']) {
    expect({ ask, intent: classifyAsk(ask, tools) }).toEqual({ ask, intent: 'team-continue' });
  }
});
