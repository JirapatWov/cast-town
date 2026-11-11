// Team words (shared/team-text.ts): a saved team's description comes from its people, and personas read as lines
// about the person on cards; the scripted test lead names models by their labels and puts reviewers on another vendor.
// The teams are the two older CAST versions had in every house (server/agents/legacy-examples.ts).
import { describe, expect, test } from 'bun:test';
import type { Workflow } from '../../shared/protocol';
import { describeTeam, thirdPerson } from '../../shared/team-text';
import { LEGACY_EXAMPLES } from '../../server/agents/legacy-examples';
import { savedReply } from '../../server/agents/demo/workflow-design';

const [CODE_WORKFLOW, NOVEL_WORKFLOW] = LEGACY_EXAMPLES as [Workflow, Workflow];
const label = (m: string) => ({ 'anthropic/claude-opus-5-5': 'Claude Opus 5.5', 'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro', 'openai/gpt-6.1-sol': 'GPT-6.1 Sol' })[m] ?? m;

describe('describeTeam', () => {
  test('names each person with their model, in order, and who sends work back', () => {
    expect(describeTeam(CODE_WORKFLOW.steps, label)).toBe(
      'Decoder (Claude Opus 5.5) → Implementer (DeepSeek V4 Pro) → Reviewer (GPT-6.1 Sol). Reviewer checks the work and sends it back to Implementer when it needs changes.',
    );
  });

  test('a parallel group reads "at the same time"', () => {
    const steps = [
      { id: 'a', name: 'A', model: 'x', kind: 'work' as const },
      { id: 'b', name: 'B', model: 'y', kind: 'work' as const, parallel: true },
      { id: 'r', name: 'R', model: 'z', kind: 'review' as const },
    ];
    expect(describeTeam(steps, (m) => m.toUpperCase())).toBe('A (X) + B (Y) at the same time → R (Z). R checks the work.');
  });
});

describe('thirdPerson', () => {
  test('turns the example teams’ personas into lines about the person', () => {
    const [idea, writer, editor] = NOVEL_WORKFLOW.steps.map((s) => thirdPerson(s.persona));
    expect(idea).toStartWith('The Idea-maker of a small fiction studio. Reads the project');
    expect(idea).toContain('Never writes chapters themselves.');
    expect(writer).toStartWith('The Writer. Writes warm, sensory prose');
    expect(editor).toStartWith('The Editor. Polishes the prose lightly');
    expect(thirdPerson(CODE_WORKFLOW.steps[1]!.persona)).toStartWith('The Implementer. Implements the plan they are given');
  });

  test('verbs joined to the first one agree too, nouns after "and" stay (#66)', () => {
    const [idea, , editor] = NOVEL_WORKFLOW.steps.map((s) => thirdPerson(s.persona));
    expect(idea).toContain('outline and characters and pitches vivid');
    expect(editor).toContain('and only sends a chapter back');
    expect(thirdPerson(CODE_WORKFLOW.steps[1]!.persona)).toContain('Adds or updates tests');
    expect(thirdPerson(CODE_WORKFLOW.steps[2]!.persona)).toContain('; mentions style nits');
    expect(thirdPerson('You read the outline and characters.')).toBe('Reads the outline and characters.');
  });

  test('leaves text that is not English alone', () => {
    expect(thirdPerson('คุณเป็นบรรณาธิการ ตรวจงานให้ละเอียด')).toBe('คุณเป็นบรรณาธิการ ตรวจงานให้ละเอียด');
  });
});

describe('the old novel team', () => {
  test('the two old example teams keep their ids, and no built-in flag', () => {
    expect(CODE_WORKFLOW.id).toBe('decode-implement-review');
    expect(NOVEL_WORKFLOW.id).toBe('novel');
    expect(LEGACY_EXAMPLES.some((w) => 'builtin' in w)).toBe(false);
  });
  test('writes in the book’s own language, not a fixed one', () => {
    const text = JSON.stringify(NOVEL_WORKFLOW);
    expect(text).not.toContain('Thai');
    expect(text).toContain('book’s language');
  });
});

describe('the scripted test lead after workflow_save', () => {
  test('names models by their labels and leaves the raw id out', () => {
    const args = { name: 'Plan team', steps: [{ id: 'planner', name: 'Planner', model: 'anthropic/claude-opus-5-5' }, { id: 'checker', name: 'Checker', model: 'openai/gpt-6.1-sol', kind: 'review', loopBackTo: 'planner' }] };
    const reply = savedReply('Saved “Plan team” (id plan-team).', args, false);
    expect(reply).toContain('**Planner** — Claude Opus 5.5');
    expect(reply).toContain('**Checker** — GPT-6.1 Sol, checks the work and sends it back to the Planner');
    expect(reply).not.toContain('anthropic/');
    expect(reply).not.toContain('(id');
  });
});
