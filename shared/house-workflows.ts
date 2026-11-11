// Which workflows a house sees: its own. Each workflow belongs to one house (made there, or imported from the shared
// library). Used by the page and the core (jobs.ts) with the lists the agent system sends: `workflows` (always empty
// now; an older CAST sent its built-ins there, which every house had), each house's own, the library.
import type { LibraryWorkflow, Workflow } from './protocol';

/** `builtins` (from an older server: every house had them; the house's own version of one wins), then the house's
 *  own. With no builtins: the house's own. */
export function houseWorkflowList(builtins: readonly Workflow[], own: readonly Workflow[]): Workflow[] {
  const out = builtins.map((b) => own.find((w) => w.id === b.id) ?? b);
  for (const w of own) if (!builtins.some((b) => b.id === w.id)) out.push(w);
  return out;
}

/** What the page has from the server. houseWorkflows absent: an older server, whose `workflows` is the one list every
 *  house sees; present: `workflows` is what every house has besides its own (none from this CAST). */
export interface WorkflowLists {
  workflows: readonly Workflow[];
  houseWorkflows?: Readonly<Record<string, readonly Workflow[]>>;
  library?: readonly LibraryWorkflow[];
}

/** This house's own workflows as the server sent them. Own keys only: a house id like "constructor" must not find
 *  Object's. */
export function ownOf(s: Pick<WorkflowLists, 'houseWorkflows'>, projectId: string | null | undefined): readonly Workflow[] {
  const m = s.houseWorkflows;
  const own = projectId && m && Object.hasOwn(m, projectId) ? m[projectId] : undefined;
  return Array.isArray(own) ? own : [];
}

/** The workflows this house can see and run. */
export function workflowsOf(s: WorkflowLists, projectId: string | null | undefined): Workflow[] {
  if (!s.houseWorkflows) return [...s.workflows];
  return houseWorkflowList(s.workflows, ownOf(s, projectId));
}

/** One of them by id. */
export function workflowOf(s: WorkflowLists, projectId: string | null | undefined, id: string | null | undefined): Workflow | undefined {
  if (!id) return undefined;
  return workflowsOf(s, projectId).find((w) => w.id === id);
}
