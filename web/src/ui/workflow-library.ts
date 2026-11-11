// The shared workflow library as the page shows it (the Workflow tab, the remove-house dialog). A saved workflow
// belongs to one house; the user puts a copy of one in the library (promote_workflow) and any house imports a copy
// from there (import_workflow), which is that house's own from then on.
// An older server sends no houseWorkflows and no library: nothing here is offered then.
import { ownOf } from '../../../shared/house-workflows';
import type { Workflow } from '../../../shared/protocol';
import type { ClientState } from '../core/types';
import { listJoin } from './format';

type Lists = Pick<ClientState, 'houseWorkflows' | 'library'>;

/** The house's own saved workflows (saved or imported here): the ones that can go in the library. */
export function ownWorkflows(s: Lists, projectId: string | null | undefined): readonly Workflow[] {
  return ownOf(s, projectId);
}

/** "Put in the library" is offered for this workflow of the house (its own saved one, on a server with a library). */
export function canPromote(s: Lists, projectId: string | null | undefined, workflowId: string | null | undefined): boolean {
  return !!s.library && !!workflowId && ownWorkflows(s, projectId).some((w) => w.id === workflowId);
}

/** One row of the Library section. */
export interface LibraryRow {
  id: string;
  name: string;
  icon: string;
  description: string;
  people: number;
  /** "from my-novel" / "from this house" (the house's name now when it is still in the town); '' when unknown. */
  from: string;
  /** The house has a workflow with this id already (an import replaces it, after asking). */
  here: boolean;
}

/** The library as this house sees it, oldest first (as the server keeps it). */
export function libraryRows(s: Lists & Pick<ClientState, 'city'>, projectId: string | null | undefined): LibraryRow[] {
  const own = ownOf(s, projectId);
  return (s.library ?? []).map((e) => {
    const w = e.workflow;
    const house = e.from ? (e.from.projectId === projectId ? 'this house' : (s.city.projects.find((p) => p.id === e.from!.projectId)?.name ?? e.from.house)) : '';
    return {
      id: w.id,
      name: w.name,
      icon: w.icon || '•',
      description: w.description,
      people: w.steps.length,
      from: house ? `from ${house}` : 'from the old shared list',
      here: own.some((x) => x.id === w.id),
    };
  });
}

export const peopleText = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** A question before a library change, for shell.confirm. */
export interface LibraryAsk {
  title: string;
  text: string[];
  confirmLabel: string;
  danger: boolean;
}

/** Import: null → just import; else ask first, then send replace (the house has a workflow with that id). */
export function importAsk(s: Lists, projectId: string, workflowId: string): LibraryAsk | null {
  const mine = ownOf(s, projectId).find((w) => w.id === workflowId);
  if (!mine) return null;
  const lib = s.library?.find((e) => e.workflow.id === workflowId)?.workflow;
  return {
    title: `Import “${lib?.name ?? mine.name}”?`,
    text: [
      `This house already has “${mine.name}” — replace it with the library’s?`,
      'Jobs here that have it as their team get the library’s team. Other houses are not touched.',
    ],
    confirmLabel: 'Replace it',
    danger: true,
  };
}

/** Promote: null → just promote; else ask first, then send replace (the library has a workflow with that id). */
export function promoteAsk(s: Lists, wf: Pick<Workflow, 'id' | 'name'>): LibraryAsk | null {
  const there = s.library?.find((e) => e.workflow.id === wf.id);
  if (!there) return null;
  return {
    title: `Put “${wf.name}” in the library?`,
    text: [
      `The library already has “${there.workflow.name}” — replace it with this house’s?`,
      'Houses that imported it keep their own copy until they import it again.',
    ],
    confirmLabel: 'Replace it',
    danger: true,
  };
}

/** Taking a workflow out of the library: only the library's copy goes. */
export function removeFromLibraryAsk(name: string): LibraryAsk {
  return {
    title: `Take “${name}” out of the library?`,
    text: ['Houses that imported it keep their own copy. No house can import it from the library after this.'],
    confirmLabel: 'Remove from library',
    danger: true,
  };
}

/** The same workflow (both as the server keeps them). */
const sameWorkflow = (a: Workflow, b: Workflow) => JSON.stringify(a) === JSON.stringify(b);

/** The remove-house dialog's line: the house's own workflows go with it (null when it has none, or on an older
 *  server, where workflows weren't the house's). One the library has just as it is here is left out; one the
 *  library has another version of is named so ("not the library's version"). */
export function houseWorkflowsLine(s: Lists, projectId: string): string | null {
  const gone = ownWorkflows(s, projectId).filter((w) => !s.library?.some((e) => e.workflow.id === w.id && sameWorkflow(e.workflow, w)));
  if (!gone.length || !s.library) return null;
  const names = gone.map((w) => (s.library?.some((e) => e.workflow.id === w.id) ? `“${w.name}” (not the library’s version)` : `“${w.name}”`));
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : listJoin(names);
  return `Its own ${gone.length === 1 ? 'workflow' : 'workflows'} (${list}) ${gone.length === 1 ? 'goes' : 'go'} with the house — put any you want to keep in the library first (Workflow tab).`;
}
