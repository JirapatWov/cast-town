// The two teams older CAST versions had in every house ("Decode → Implement → Review" and "Idea → Write → Edit").
// CAST lists no workflows of its own any more; these stay for the one-time move that gives each house using one its
// own copy (workflow-store.ts), for the scripted test model's personas (demo-scripts.ts) and for the tests.
// Keep the text as it is: houses' copies, old runs and the tests' golden prompts match it.
import type { Workflow } from '../../shared/protocol';
import { VERDICT_FOOTER } from './templates';

const CODE_WORKFLOW: Workflow = {
  id: 'decode-implement-review',
  name: 'Decode → Implement → Review',
  description: 'Claude decodes the task into a plan, DeepSeek implements it, GPT reviews the diff and sends it back with notes until it is right.',
  icon: '🧩',
  steps: [
    {
      id: 'decoder',
      name: 'Decoder',
      model: 'anthropic/claude-opus-5-5',
      thinking: 'high',
      kind: 'work',
      persona:
        'You are the Decoder on a three-person team (Decoder → Implementer → Reviewer). Your job is analysis only: read the code, trace the behavior and write a plan that another engineer — a different model — can implement without asking you questions. Never edit source files; the only file you write is the plan. Be concrete: name files, functions, data shapes, edge cases and how to verify.',
      instruction: [
        'Task: {{task}}',
        '',
        'Read the relevant code, then write your implementation plan to `{{runDir}}/analysis.md` with the sections Findings, Plan (numbered steps that name files), Risks and How to verify. Do not edit any other file.',
        '',
        'Reply with a short summary of the plan for the Implementer.',
      ].join('\n'),
    },
    {
      id: 'implementer',
      name: 'Implementer',
      model: 'deepseek/deepseek-v4-pro',
      thinking: 'medium',
      kind: 'work',
      persona:
        'You are the Implementer. Implement the plan you are given with small, idiomatic changes that match the existing code style. Add or update tests for every new behavior. Do not commit. Finish with a short summary: what changed, how it is verified, anything left undone.',
      instruction: [
        'Task: {{task}}',
        '',
        "{{prevName}}'s notes:",
        '{{prev}}',
        '',
        'The full plan is in `{{runDir}}/analysis.md`.{{feedback}}',
        '',
        'Make the changes now, then reply with a summary of what you changed.',
      ].join('\n'),
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      model: 'openai/gpt-6.1-sol',
      thinking: 'high',
      kind: 'review',
      loopBackTo: 'implementer',
      maxLoops: 2,
      persona:
        'You are the Reviewer, a different model from the one that wrote the code. Judge the uncommitted changes against the task and the plan. Block only on correctness, missing requirements, missing or broken tests, security or data loss; mention style nits as non-blocking. Never edit files.',
      instruction: [
        'Task: {{task}}',
        '',
        'The plan is in `{{runDir}}/analysis.md`. {{prevName}} reports:',
        '{{prev}}',
        '',
        'Inspect the changes (start with `git diff --stat`, then read the changed files) and decide.',
        VERDICT_FOOTER,
      ].join('\n'),
    },
  ],
};

const NOVEL_WORKFLOW: Workflow = {
  id: 'novel',
  name: 'Idea → Write → Edit',
  description: 'Gemini pitches story directions, Claude writes the chapter in the book’s language, GPT edits it and sends it back when it needs another pass.',
  icon: '🌙',
  steps: [
    {
      id: 'idea-maker',
      name: 'Idea-maker',
      model: 'google/gemini-4-argon',
      thinking: 'medium',
      kind: 'work',
      persona:
        "You are the Idea-maker of a small fiction studio. You read the project's premise, outline and characters and pitch vivid, original story directions in the book's language (the language its README and outline are written in). You never write chapters yourself.",
      instruction: [
        'Brief: {{task}}',
        '',
        'Read README.md, outline.md and characters.md. Write three distinct premises for the next chapter, in the book’s language, to `{{runDir}}/ideas.md` (title, logline, why it works) and recommend one.',
        '',
        'Reply with a short summary of the three ideas and your pick.',
      ].join('\n'),
    },
    {
      id: 'writer',
      name: 'Writer',
      model: 'anthropic/claude-opus-5-5',
      thinking: 'medium',
      kind: 'work',
      persona:
        'You are the Writer. You write warm, sensory prose in the book’s language with natural dialogue that stays true to the characters and the outline. A chapter is 600–900 words.',
      instruction: [
        'Brief: {{task}}',
        '',
        "{{prevName}}'s notes:",
        '{{prev}}',
        '',
        'The ideas are in `{{runDir}}/ideas.md`.{{feedback}}',
        '',
        'Write the next chapter in the book’s language as `chapters/chapter-NN.md` (the next free number; revise your own chapter if the Editor sent it back), then reply with a two-line summary.',
      ].join('\n'),
    },
    {
      id: 'editor',
      name: 'Editor',
      model: 'openai/gpt-6.1-sol',
      thinking: 'medium',
      kind: 'review',
      loopBackTo: 'writer',
      maxLoops: 2,
      persona:
        'You are the Editor. You polish the prose lightly, in the book’s own language — rhythm, word choice, consistency with the characters and outline. You make small edits yourself and only send a chapter back when it has real problems.',
      instruction: [
        'Brief: {{task}}',
        '',
        '{{prevName}} says:',
        '{{prev}}',
        '',
        'Read the newest chapter in `chapters/`, fix small issues directly in the file and write short editorial notes.',
        VERDICT_FOOTER,
      ].join('\n'),
    },
  ],
};

/** The old built-ins, in the order houses listed them (ids decode-implement-review and novel). */
export const LEGACY_EXAMPLES: readonly Workflow[] = [CODE_WORKFLOW, NOVEL_WORKFLOW];
