// FINDING (owner, live 2026-11-04): every turn of a Gemini lead failed with Cloud Code Assist 400 "GenerateContentRequest
// .tools[0].function_declarations[14].parameters.properties[ops].items.properties[thinking].enum[0]: cannot be empty":
// team_edit's thinking listed '' (= the default effort) as an enum value. Gemini takes a function's parameters as an
// OpenAPI subset and refuses the WHOLE request (every tool goes in every turn), so one bad schema stops the lead entirely.
// Every tool CAST gives an agent must keep to what Gemini accepts. Run: bun test tests/auto/tool-schemas-gemini.test.ts
import { describe, expect, test } from 'bun:test';
import { LEAD_TOOLS } from '../../server/agents/lead-tools.ts';
import { parseRunEditOps } from '../../server/agents/run-edit.ts';

/** What Gemini would refuse in one schema, as paths like ops.items.thinking.enum[0]. */
function geminiProblems(schema: unknown, at = ''): string[] {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) return schema.flatMap((s, i) => geminiProblems(s, `${at}[${i}]`));
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(s.enum)) {
    if (s.type !== 'string') out.push(`${at}.enum on type ${String(s.type)} (Gemini takes enum on strings only)`);
    s.enum.forEach((v, i) => {
      if (typeof v !== 'string' || v === '') out.push(`${at}.enum[${i}] = ${JSON.stringify(v)} (cannot be empty)`);
    });
  }
  for (const [k, v] of Object.entries(s)) if (k !== 'enum' && v && typeof v === 'object') out.push(...geminiProblems(v, at ? `${at}.${k}` : k));
  return out;
}

describe('every lead tool is one Gemini accepts', () => {
  test('no empty enum value, enum only on strings', () => {
    const problems = LEAD_TOOLS.flatMap((t) => geminiProblems(t.parameters).map((p) => `${t.name}: ${p}`));
    expect(problems).toEqual([]);
  });

  test("team_edit: thinking 'default' puts a step back on the model's default effort ('' still works for the page)", () => {
    expect(parseRunEditOps([{ op: 'update', step: 'editor', thinking: 'default' }])).toEqual([{ op: 'update', step: 'editor', thinking: '' }]);
    expect(parseRunEditOps([{ op: 'update', step: 'editor', thinking: '' }])).toEqual([{ op: 'update', step: 'editor', thinking: '' }]);
    const thinking = (LEAD_TOOLS.find((t) => t.name === 'team_edit')!.parameters as any).properties.ops.items.properties.thinking;
    expect(thinking.enum[0]).toBe('default');
    expect(thinking.description).toContain("'default'");
  });
});
