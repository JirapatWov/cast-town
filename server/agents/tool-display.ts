// How omp tools look in RLT: which Activity (→ house station) a tool maps to, and short human titles.
import type { Activity } from '../../shared/protocol';
import { truncate } from './util';

export function activityForTool(tool: string): Activity {
  const t = tool.toLowerCase();
  if (t === 'ask') return 'waiting_approval';
  if (t === 'task' || t === 'team_start' || t === 'team_continue' || t === 'team_stop') return 'delegating';
  if (t === 'team_status' || t === 'workflow_list' || t === 'workflow_get') return 'reading';
  if (t === 'workflow_save' || t === 'workflow_delete' || t === 'workflow_import' || t === 'workflow_promote' || t === 'team_assign' || t === 'team_edit') return 'thinking';
  if (t.startsWith('todo')) return 'thinking';
  if (t === 'ast_edit' || t === 'edit' || t === 'write' || t === 'apply_patch' || t.startsWith('notebook')) return 'writing';
  if (['read', 'grep', 'find', 'glob', 'ls', 'lsp'].includes(t) || t.startsWith('ast')) return 'reading';
  if (['bash', 'exec', 'eval', 'python', 'shell'].includes(t)) return 'running';
  if (t === 'web_search' || t === 'fetch' || t.startsWith('browser')) return 'searching';
  return 'thinking';
}

/** Tools whose completion may have changed files (→ refresh the git TV). */
export function mayChangeFiles(tool: string): boolean {
  return ['edit', 'write', 'apply_patch', 'ast_edit', 'bash', 'exec', 'eval', 'python', 'shell'].includes(tool) || tool.startsWith('notebook');
}

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** `src/app.ts:10-20` → `src/app.ts` */
function cleanPath(p: string): string {
  return p.replace(/:(raw|conflicts|img|-?\d[\d,+\-:]*)(:raw)?$/i, '') || p;
}

function editTarget(args: Args): string {
  const input = str(args.input);
  const m = input.match(/\[([^\]#\n]+)#[0-9A-Za-z]{2,8}\]/);
  return m ? m[1] : str(args.path) || 'a file';
}

/** The files a file-changing tool call wrote, as given in its arguments; null when the tool can change anything
 *  (a shell command, a helper) and the paths are unknown. */
export function changedPaths(tool: string, rawArgs: unknown): string[] | null {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Args;
  switch (tool) {
    case 'write':
    case 'ast_edit':
      return str(args.path) ? [cleanPath(str(args.path))] : null;
    case 'edit': {
      const t = editTarget(args);
      return t && t !== 'a file' ? [cleanPath(t)] : null;
    }
    case 'apply_patch': {
      const text = str(args.input) || str(args.patch);
      const files = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
      const moves = [...text.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((m) => m[1]!.trim());
      return files.length ? [...files, ...moves] : null;
    }
    default:
      return tool.startsWith('notebook') && str(args.path) ? [cleanPath(str(args.path))] : null;
  }
}

/** Short card title for the transcript, e.g. "read src/app.ts". */
export function toolTitle(tool: string, rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Args;
  switch (tool) {
    case 'read': {
      const p = cleanPath(str(args.path));
      return p === '.' || p === './' || p === '' ? 'read project folder' : `read ${p}`;
    }
    case 'glob':
      return `list ${str(args.path) || 'files'}`;
    case 'grep':
      return `search “${truncate(str(args.pattern), 40)}”${str(args.path) ? ` in ${str(args.path)}` : ''}`;
    case 'edit':
      return `edit ${editTarget(args)}`;
    case 'write':
      return `write ${str(args.path)}`;
    case 'bash':
      return `$ ${truncate(str(args.command).split('\n')[0], 80)}`;
    case 'task': {
      const n = Array.isArray(args.tasks) ? args.tasks.length : 1;
      return `delegate to ${n} helper${n === 1 ? '' : 's'}`;
    }
    case 'team_start': {
      // A one-off team by its people, a saved workflow by its id, else the job's own team with the task.
      // people who work at the same time (parallel) are joined with " + ", like the plan card
      const steps = Array.isArray(args.steps) ? args.steps.map((s) => (s && typeof s === 'object' ? (s as Args) : {})).filter((s) => str(s.name)) : [];
      const people = steps.map((s, i) => `${i === 0 ? '' : s.parallel === true ? ' + ' : ' → '}${str(s.name)}`).join('');
      if (people) return truncate(`start a team: ${people}`, 90);
      if (str(args.workflow_id)) return truncate(`start “${str(args.workflow_id)}”: ${str(args.task).replace(/\s+/g, ' ')}`, 90);
      return `start the team: ${truncate(str(args.task).replace(/\s+/g, ' '), 70)}`;
    }
    case 'team_continue':
      return truncate(`continue “${str(args.run_id).trim() || 'latest'}” from ${str(args.from_step).trim() || 'a step'}`, 90);
    case 'team_edit': {
      const what = editSummary(args);
      return truncate(`change the team's next steps${args.redo === true ? ' (redo)' : ''}${what ? ` — ${what}` : ''}`, 90);
    }
    case 'team_status':
      return str(args.run_id).trim() ? `check on run “${str(args.run_id).trim()}”` : 'check on the team';
    case 'team_stop':
      return 'stop the team';
    case 'team_assign':
      return str(args.workflow_id) ? `set the job's team: “${str(args.workflow_id)}”` : "clear the job's team";
    case 'workflow_list':
      return 'list workflows';
    case 'workflow_get':
      return `read workflow “${str(args.id)}”`;
    case 'workflow_save': {
      const steps = Array.isArray(args.steps) ? args.steps.map((s) => str((s as Args | null)?.name)).filter(Boolean) : [];
      return truncate(`save workflow “${str(args.name)}”${steps.length ? `: ${steps.join(' → ')}` : ''}`, 90);
    }
    case 'workflow_delete':
      return `delete workflow “${str(args.id)}”`;
    case 'workflow_import':
      return `import workflow “${str(args.id)}” from the library${args.replace === true ? ' (replace this house’s)' : ''}`;
    case 'workflow_promote':
      return `put workflow “${str(args.id)}” in the library${args.replace === true ? ' (replace the library’s)' : ''}`;
    case 'web_search':
      return `web search “${truncate(str(args.query), 50)}”`;
    case 'todo':
      return 'update todo list';
    case 'ask':
      return 'ask you a question';
    case 'eval':
      return str(args.title) || `run ${str(args.language) || 'code'}`;
    default:
      return tool;
  }
}

/** team_edit's ops in a few words: "Editor: instruction · add Proofreader · note to Writer". */
function editSummary(args: Args): string {
  const ops = Array.isArray(args.ops) ? args.ops.map((o) => (o && typeof o === 'object' ? (o as Args) : {})) : [];
  const words: Record<string, string> = { add_to_instruction: 'instruction', thinking: 'effort', loopBackTo: 'review loop', maxLoops: 'rounds', parallel: 'same time' };
  return ops
    .map((o) => {
      const who = str(o.step).trim();
      switch (str(o.op)) {
        case 'add':
          return `add ${str((o.person as Args | undefined)?.name).trim() || 'a person'}`;
        case 'remove':
          return `remove ${who}`;
        case 'move':
          return `move ${who}`;
        case 'note':
          return `note to ${who}`;
        default: {
          const fields = ['instruction', 'add_to_instruction', 'persona', 'model', 'thinking', 'name', 'kind', 'loopBackTo', 'maxLoops', 'parallel'].filter((k) => o[k] !== undefined).map((k) => words[k] ?? k);
          return `${who}: ${[...new Set(fields)].join(', ')}`;
        }
      }
    })
    .join(' · ');
}

/** Present-tense status line for the person's name tag, e.g. "Reading src/app.ts". */
export function toolDetail(tool: string, rawArgs: unknown): string {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Args;
  switch (tool) {
    case 'read': {
      const p = cleanPath(str(args.path));
      return p === '.' || p === '' ? 'Looking around the project' : `Reading ${p}`;
    }
    case 'glob':
      return 'Listing files';
    case 'grep':
      return `Searching for “${truncate(str(args.pattern), 30)}”`;
    case 'edit':
      return `Editing ${editTarget(args)}`;
    case 'write':
      return `Writing ${str(args.path)}`;
    case 'bash':
      return `Running ${truncate(str(args.command).split('\n')[0], 48)}`;
    case 'task': {
      const n = Array.isArray(args.tasks) ? args.tasks.length : 1;
      return `Briefing ${n} helper${n === 1 ? '' : 's'}`;
    }
    case 'web_search':
      return `Searching the web`;
    case 'todo':
      return 'Planning';
    case 'ask':
      return 'Has a question for you';
    case 'team_start':
      return Array.isArray(args.steps) ? 'Starting a team' : 'Starting the team';
    case 'team_continue':
      return 'Continuing the team';
    case 'team_edit':
      return "Changing the team's next steps";
    case 'team_status':
      return 'Checking on the team';
    case 'team_stop':
      return 'Stopping the team';
    case 'team_assign':
      return "Setting the job's team";
    case 'workflow_list':
    case 'workflow_get':
      return 'Looking at workflows';
    case 'workflow_save':
      return 'Designing a team';
    case 'workflow_delete':
      return 'Deleting a workflow';
    case 'workflow_import':
      return 'Importing a workflow';
    case 'workflow_promote':
      return 'Putting a workflow in the library';
    default:
      return `Using ${tool}`;
  }
}
