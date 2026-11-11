// A new house has no workflows. Tests written for the two teams older CAST versions had in every house
// ("Decode → Implement → Review" and "Idea → Write → Edit", server/agents/legacy-examples.ts) give them to a house first.
import { LEGACY_EXAMPLES } from '../server/agents/legacy-examples.ts';
import type { WorkflowStore } from '../server/agents/workflow-store.ts';

/** Save the old example teams into this house (ids decode-implement-review and novel), each only if the house has no
 *  workflow with its id yet (idempotent: a restart, or a copy the one-time move already gave). */
export function giveExamples(store: WorkflowStore, projectId: string): void {
  for (const ex of LEGACY_EXAMPLES) if (!store.own(projectId).some((w) => w.id === ex.id)) store.save(projectId, structuredClone(ex));
}

export const CODE_EXAMPLE = LEGACY_EXAMPLES.find((w) => w.id === 'decode-implement-review')!;
export const NOVEL_EXAMPLE = LEGACY_EXAMPLES.find((w) => w.id === 'novel')!;
