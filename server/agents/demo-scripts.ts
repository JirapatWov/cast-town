// The scripted test model (CAST_MOCK_LLM=1, tests and development only): decides what the mock LLM answers for one
// chat-completions request.
//
// Routing: omp's side requests (auto-thinking judgment) → a one-word answer; the `[rlt-role:…]` marker in the
// system prompt picks the person's script (an old example team's step gets its own script only with that step's
// persona, legacy-examples.ts; else the generic work/review script); requests without a marker are subagents
// spawned by `task`.
// A workflow role prompted outside a run (the user just chats with them, no "Task:/Brief:" instruction)
// behaves like the Assistant.
// Scripts live in ./demo/* — each is a list of steps that read real files and call real omp tools.
import { assistantTurn } from './demo/assistant';
import { decoderTurn, implementerTurn, reviewerTurn } from './demo/code-workflow';
import { parseConversation, type Conversation } from './demo/conversation';
import { genericReviewTurn, genericWorkTurn } from './demo/generic';
import { helperTurn } from './demo/helper';
import { editorTurn, ideaMakerTurn, writerTurn } from './demo/novel';
import { makeCtx, type Ctx, type TurnPlan } from './demo/script';
import { isStepPrompt } from './demo/workflow-prompt';
import { LEGACY_EXAMPLES } from './legacy-examples';

export { parseConversation, type Conversation, type TurnPlan };

const ROLE_SCRIPTS: Record<string, (ctx: Ctx) => TurnPlan> = {
  decoder: decoderTurn,
  implementer: implementerTurn,
  reviewer: reviewerTurn,
  'idea-maker': ideaMakerTurn,
  writer: writerTurn,
  editor: editorTurn,
};

/** The start of each example step's persona, by step id: a team designed in chat may name its steps Writer or
 *  Reviewer too, and must not get the example novel/code scripts. */
const EXAMPLE_PERSONAS = new Map(LEGACY_EXAMPLES.flatMap((w) => w.steps.map((s) => [s.id, s.persona.slice(0, 60)] as const)));

/** The dedicated script of an example step (its role id and its persona in the system prompt), else none. A run's
 *  temporary people (`x-decoder`: other models, or another job's workflow) play their step's script too. */
function roleScript(role: string, system: string): ((ctx: Ctx) => TurnPlan) | undefined {
  const step = role.replace(/^x-/, '');
  const persona = EXAMPLE_PERSONAS.get(step);
  return persona && system.includes(persona) ? ROLE_SCRIPTS[step] : undefined;
}

function judgmentTurn(conv: Conversation): TurnPlan {
  if (conv.tools.has('submit_judgment') && !conv.turn.some((c) => c.name === 'submit_judgment')) {
    return { calls: [{ name: 'submit_judgment', args: { answer: 'low' }, id: `rlt_judge_${Date.now().toString(36)}` }] };
  }
  return { text: 'low' };
}

export function demoTurn(conv: Conversation): TurnPlan {
  if (conv.isJudgment) return judgmentTurn(conv);
  const ctx = makeCtx(conv);
  if (conv.role === null) return helperTurn(ctx);
  if (conv.role === 'assistant' || conv.isWake || !isStepPrompt(conv.userText)) return assistantTurn(ctx);
  const script = roleScript(conv.role, conv.system);
  if (script) return script(ctx);
  return conv.stepKind === 'review' ? genericReviewTurn(ctx) : genericWorkTurn(ctx);
}
