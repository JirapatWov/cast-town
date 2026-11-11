// Live run timeline for the Workflow tab: every step attempt, review rounds, verdicts, timings, cost. Names and models
// come from the run's own team (run.team), so one-off teams and workflows edited since show as they ran. A run that
// ended can run again from a step ("Run again from here", continue_run): the steps before it keep their results. A
// run that did that (run.continues) shows those kept steps first, then where it started working again. While it runs,
// the steps that haven't started can change (Edit, Add a person) and the person working now can get a note — the run
// keeps going (run-edit.ts).
import type { WorkflowRun, WorkflowRunStep } from '../../../shared/protocol';
import { h } from './dom';
import { blockOpts } from './agents-health';
import { agentStatusText, fmtClock, fmtDuration, fmtUsd, listJoin, modelLabel, timeOfDay, vendorOfModel } from './format';
import { icon } from './icons';
import { kindInfo } from './jobs';
import { renderMarkdown } from './markdown';
import { stepGroups } from './plans';
import { RUN_STATUS_TEXT, attemptWaits, continuableSteps, continuedBy, isAdhocRun, isRunActive, reachedThrough, runElapsed, runTeam, runWorked, waitedFor, workedFor } from './runs';
import { approvalCard } from './approvals';
import { editableFrom, editedLine, workingNow } from './run-plan';
import type { Shell } from './shell';
import { agentModelChip, avatar } from './widgets';

const STEP_ICON: Record<WorkflowRunStep['status'], string> = {
  pending: 'circleDashed',
  running: 'spinner',
  done: 'checkCircle',
  failed: 'xCircle',
  skipped: 'minus',
};

/** Strip the trailing ```json verdict block from a review reply for the preview. */
function readable(output: string): string {
  return output.replace(/```json[\s\S]*?```\s*$/i, '').trim();
}

function verdictNotes(output: string | undefined): string | null {
  if (!output) return null;
  const m = /```json\s*([\s\S]*?)```/i.exec(output);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]) as { notes?: unknown };
    if (typeof parsed.notes === 'string') return parsed.notes;
    if (Array.isArray(parsed.notes)) return parsed.notes.join(' ');
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

export interface RunTimelineActions {
  onAbort(): void;
  onRevert(): void;
  onKeep?(anchor: HTMLElement): void;
  /** "Run again from here" on an ended run (absent while it runs): `stepId` is the first step of the group that works
   *  again, `anchor` the button (for the popover). */
  onContinue?(stepId: string, anchor: HTMLElement): void;
  /** Why "Run again from here" can't be used right now (another run is going in the job): it shows, but doesn't open. */
  continueBlocked?: string;
  /** Show another run of the job: the earlier run this one continues, or the later run that continued it. */
  onShowRun?(runId: string): void;
  /** While it runs: change a step that hasn't started (Edit on its up-next row). */
  onEditStep?(stepId: string): void;
  /** While it runs: add a person after the steps working now or a later one. */
  onAddStep?(): void;
  /** While it runs: a note to a person working now. */
  onNote?(stepId: string, name: string, anchor: HTMLElement): void;
}

export function runTimeline(shell: Shell, run: WorkflowRun, openOutputs: Set<string>, actions: RunTimelineActions): HTMLElement {
  const s = shell.store.state;
  const team = runTeam(s, run);
  const def = (stepId: string) => team.find((x) => x.id === stepId);
  const groupOf = (stepId: string) => stepGroups(team).find((g) => g.some((m) => m.id === stepId)) ?? [];
  const now = Date.now();
  const active = isRunActive(run);
  // what can change while it runs: the steps after the group working now; notes reach that group
  const editFrom = actions.onEditStep ? editableFrom(run) : Infinity;
  const noteTo = actions.onNote ? new Set(workingNow(run, team)) : new Set<string>();
  const changedChip = (stepId: string) =>
    team.find((m) => m.id === stepId)?.edited ? h('span', { class: 'chip chip-edited', title: 'Added or changed while this run went', 'aria-label': 'changed while this run went' }, icon('pencil', 10), h('span', { class: 'chip-edited-label' }, 'changed')) : null;

  const attemptCount = new Map<string, number>();
  const rows: HTMLElement[] = [];

  // "Run again from here": on the latest attempt of each step the run can go on from (the server checks again).
  const continuable = actions.onContinue ? continuableSteps(run, team, s.runs) : new Map<string, string>();
  const lastAttempt = new Map<string, number>();
  run.steps.forEach((st, i) => lastAttempt.set(st.stepId, i));
  const groupName = (stepId: string) => groupOf(stepId).map((m) => m.name).join(' + ') || def(stepId)?.name || stepId;
  const againBtn = (stepId: string): HTMLElement | null => {
    const start = continuable.get(stepId);
    if (!start || !actions.onContinue) return null;
    const name = groupName(start);
    const blocked = actions.continueBlocked;
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['btn', 'btn-ghost', 'btn-sm', 'tl-again', blocked && 'is-blocked'],
        'aria-label': `Run again from here: ${name}`,
        'aria-haspopup': blocked ? undefined : 'dialog',
        'aria-disabled': blocked ? 'true' : undefined,
        title: blocked ?? `Run again from ${name} — the steps before keep their results`,
      },
      icon('loop', 13),
      h('span', { class: 'tl-again-label' }, 'Run again from here'),
    );
    btn.addEventListener('click', () => (blocked ? shell.toast('info', `${blocked} — run again from here once it ends.`) : actions.onContinue!(start, btn)));
    return h('div', { class: 'tl-foot' }, btn);
  };

  // A continuation: its kept steps come first, then a divider where it started working again.
  const cont = run.continues;
  const earlier = cont ? s.runs[cont.runId] : undefined;
  const showEarlier = earlier && actions.onShowRun ? () => actions.onShowRun!(earlier.id) : null;
  let dividerShown = false;
  const divider = () => {
    dividerShown = true;
    if (!cont) return null;
    const anyKept = run.steps.some((st) => st.reused);
    return h(
      'div',
      { class: 'tl-continue', role: 'note' },
      icon('loop', 14),
      h(
        'div',
        null,
        h(
          'p',
          null,
          h('strong', null, `Runs again from ${groupName(cont.stepId)}`),
          anyKept ? ' — the steps above are kept from ' : ' — nothing kept from ',
          showEarlier ? h('button', { type: 'button', class: 'link-btn', onclick: showEarlier }, 'the earlier run') : 'the earlier run',
        ),
        cont.note ? h('p', { class: 'tl-continue-note' }, `“${cont.note}”`) : null,
      ),
    );
  };

  const noteBtn = (stepId: string, name: string) => {
    const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm tl-note', 'aria-haspopup': 'dialog', title: `${name} keeps working and reads it at their next step` }, icon('chat', 13), 'Send a note');
    btn.addEventListener('click', () => actions.onNote!(stepId, name, btn));
    return h('div', { class: 'tl-foot' }, btn);
  };

  run.steps.forEach((attempt, i) => {
    const step = def(attempt.stepId);
    const agent = s.agents[attempt.agentId];
    const n = (attemptCount.get(attempt.stepId) ?? 0) + 1;
    attemptCount.set(attempt.stepId, n);
    const prev = run.steps[i - 1];
    const group = groupOf(attempt.stepId);
    const reused = !!attempt.reused;
    if (cont && !reused && !dividerShown) rows.push(divider()!);

    // A repeated step means a reviewer sent the work back: show the round marker with their notes — once per round,
    // where the work went back (not again for the people after it in that round, nor for the other people of a
    // parallel group that starts over together).
    const at = (id: string) => team.findIndex((m) => m.id === id);
    const wentBack = !prev || at(attempt.stepId) < 0 || at(prev.stepId) < 0 || at(attempt.stepId) <= at(prev.stepId);
    if (n > 1 && wentBack && !(prev && group.length > 1 && group.some((m) => m.id === prev.stepId))) {
      const back = run.steps.slice(0, i).reverse().find((x) => x.verdict === 'revise') ?? prev;
      const reviewer = back ? def(back.stepId)?.name ?? s.agents[back.agentId]?.name ?? 'Reviewer' : 'Reviewer';
      const notes = verdictNotes(back?.output);
      rows.push(
        h(
          'div',
          { class: 'tl-loop' },
          icon('loop', 14),
          h('div', null, h('p', null, h('strong', null, `Round ${n}`), ` — ${reviewer} asked for changes`), notes ? h('p', { class: 'tl-loop-notes' }, `“${notes}”`) : null),
        ),
      );
    }

    const model = step?.model || agent?.model || '';
    const vendor = agent?.vendor ?? vendorOfModel(model, s.models);
    const name = step?.name || agent?.name || attempt.stepId;
    const together = group.length > 1 ? group.filter((m) => m.id !== attempt.stepId).map((m) => m.name) : [];
    const running = attempt.status === 'running';
    const waiting = attemptWaits(s, run, attempt);
    // a kept step didn't work in this run: no time of its own; time spent waiting for the user isn't working time
    const duration = workedFor(attempt, now);
    const waited = reused ? 0 : waitedFor(attempt, now);
    // the requests this person waits on: answered right here, where the user follows the run
    const asks = running ? Object.values(s.approvals).filter((a) => a.agentId === attempt.agentId).sort((a, b) => a.ts - b.ts) : [];
    const output = attempt.output ? readable(attempt.output) : '';

    const outputEl = output
      ? (() => {
          const preview = h('div', { class: 'tl-output md', html: renderMarkdown(output.length > 1600 ? `${output.slice(0, 1600)}…` : output) });
          const key = `${run.id}:${i}`;
          const open = openOutputs.has(key);
          const toggle = h('button', { type: 'button', class: 'link-btn tl-more', 'aria-expanded': String(open) }, open ? 'Show less' : 'Show more');
          const wrap = h('div', { class: ['tl-output-wrap', !open && 'is-clamped'] }, preview, toggle);
          toggle.addEventListener('click', () => {
            const clamped = wrap.classList.toggle('is-clamped');
            toggle.textContent = clamped ? 'Show more' : 'Show less';
            toggle.setAttribute('aria-expanded', String(!clamped));
            if (clamped) openOutputs.delete(key);
            else openOutputs.add(key);
          });
          return wrap;
        })()
      : null;

    rows.push(
      h(
        'div',
        { class: ['tl-step', `is-${waiting ? 'waiting' : attempt.status}`, reused && 'is-reused'] },
        h('span', { class: 'tl-icon' }, running && !waiting ? h('span', { class: 'spinner spinner-sm' }) : reused ? icon('check', 11) : icon(waiting ? 'hand' : STEP_ICON[attempt.status], 16)),
        h(
          'div',
          { class: 'tl-main' },
          h(
            'div',
            { class: 'tl-row' },
            // one-off people leave a few seconds after their run: then there is no chat to open
            agent
              ? h(
                  'button',
                  { type: 'button', class: 'tl-who', onclick: () => shell.openAgent(attempt.agentId), title: `Open chat with ${name}` },
                  avatar(name, vendor, 'xs'),
                  h('span', { class: 'tl-name' }, name),
                )
              : h('span', { class: 'tl-who is-gone', title: reused ? `${name} — kept from the earlier run` : `${name} has left` }, avatar(name, vendor, 'xs'), h('span', { class: 'tl-name' }, name)),
            h('span', { class: 'tl-model' }, agent?.modelLabel ?? modelLabel(model, s.models)),
            agent ? agentModelChip(agent, s.models, blockOpts(s.hello)) : null,
            reused ? h('span', { class: 'chip chip-kept', title: 'From the earlier run — not run again' }, 'kept') : null,
            changedChip(attempt.stepId),
            together.length ? h('span', { class: 'chip chip-par', title: `At the same time as ${listJoin(together)}` }, icon('columns', 11), 'same time') : null,
            attempt.verdict
              ? h('span', { class: ['chip', attempt.verdict === 'approve' ? 'chip-ok' : 'chip-warn'] }, attempt.verdict === 'approve' ? 'Approved' : 'Changes requested')
              : null,
            h(
              'span',
              {
                class: 'tl-dur num',
                title: waited >= 1000 && duration !== null ? `Worked ${fmtDuration(duration)}, waited ${fmtDuration(waited)} for you` : undefined,
                // live: the worked clock stops while the step waits for the user (workflow-tab ticks it)
                'data-since': running && attempt.startedAt ? String(attempt.startedAt) : undefined,
                'data-wait': running && attempt.waitedMs ? String(attempt.waitedMs) : undefined,
                'data-wait-from': running && attempt.waitingSince !== undefined ? String(attempt.waitingSince) : undefined,
                'data-fmt': 'clock',
              },
              duration !== null ? (running ? fmtClock(duration) : fmtDuration(duration)) : '',
            ),
          ),
          waited >= 1000 && !running ? h('p', { class: 'tl-waited' }, icon('hand', 11), `Waited ${fmtDuration(waited)} for you`) : null,
          running && agent
            ? h(
                'p',
                { class: ['tl-live', waiting && 'is-waiting'] },
                waiting
                  ? [
                      asks.length ? `Waiting for your approval${asks.length > 1 ? ` (${asks.length})` : ''}` : 'Waiting for your approval',
                      attempt.waitingSince !== undefined ? [' · ', h('span', { class: 'num', 'data-since': String(attempt.waitingSince), 'data-fmt': 'clock' }, fmtClock(now - attempt.waitingSince))] : null,
                    ]
                  : agentStatusText(agent),
              )
            : null,
          asks.length ? h('div', { class: 'tl-asks' }, asks.map((a) => approvalCard(shell, a, { showProject: false }))) : null,
          running && agent && noteTo.has(attempt.stepId) ? noteBtn(attempt.stepId, name) : null,
          outputEl,
          lastAttempt.get(attempt.stepId) === i ? againBtn(attempt.stepId) : null,
        ),
      ),
    );
  });

  // The kept steps were all there is so far (the run just started, or stopped before anyone worked again).
  if (cont && !dividerShown) {
    const d = divider();
    if (d) rows.push(d);
  }

  // People who haven't started yet in this pass (after the last loop back, the furthest one reached so far) — up
  // next while the run goes, never reached when it failed or was stopped (the first of them can run again from there).
  const ended = run.status === 'failed' || run.status === 'aborted';
  if (team.length && (active || ended)) {
    const from = reachedThrough(run, team) + 1;
    team.slice(from).forEach((def, k) => {
      const canEdit = active && from + k >= editFrom;
      rows.push(
        h(
          'div',
          { class: ['tl-step', active ? 'is-pending' : 'is-skipped'] },
          h('span', { class: 'tl-icon' }, icon(active ? 'circleDashed' : 'minus', 16)),
          h(
            'div',
            { class: 'tl-main' },
            h(
              'div',
              { class: 'tl-row' },
              h('span', { class: 'tl-who' }, avatar(def.name, vendorOfModel(def.model, s.models), 'xs'), h('span', { class: 'tl-name' }, def.name)),
              h('span', { class: 'tl-model' }, modelLabel(def.model, s.models)),
              changedChip(def.id),
              // a step that can still change shows Edit there instead (its dashed icon says it hasn't started)
              canEdit ? null : h('span', { class: 'tl-dur muted' }, active ? 'up next' : 'not reached'),
              canEdit
                ? h(
                    'button',
                    { type: 'button', class: 'btn btn-ghost btn-sm tl-edit', 'aria-haspopup': 'dialog', 'aria-label': `Edit ${def.name} for this run`, title: `Change ${def.name} for this run — it keeps going`, onclick: () => actions.onEditStep!(def.id) },
                    icon('pencil', 12),
                    h('span', { class: 'tl-edit-label' }, 'Edit'),
                  )
                : null,
            ),
            !active && k === 0 ? againBtn(def.id) : null,
          ),
        ),
      );
    });
  }

  if (active && actions.onAddStep && run.planAt) {
    rows.push(
      h(
        'div',
        { class: 'tl-add' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-haspopup': 'dialog', title: 'Add a person to this run — it keeps going', onclick: () => actions.onAddStep!() }, icon('plus', 13), 'Add a person'),
      ),
    );
  }

  const canRevert = !active && !!run.checkpoint;
  const adhoc = isAdhocRun(run);
  const lead = run.startedBy === 'lead'
    ? Object.values(s.agents).find((a) => a.roleId === 'assistant' && a.kind !== 'subagent' && a.projectId === run.projectId && (a.jobId ?? 'main') === (run.jobId ?? 'main'))?.name ??
      kindInfo(shell.store.job(run.projectId, run.jobId)?.kind).lead
    : null;
  const keepBtn = actions.onKeep
    ? h('button', { type: 'button', class: 'btn btn-soft btn-sm', title: 'Save this one-off team as a workflow to use again' }, icon('save', 13), 'Keep this team')
    : null;
  keepBtn?.addEventListener('click', () => actions.onKeep!(keepBtn));
  const later = continuedBy(s, run)[0];
  const contLine = [
    cont
      ? h(
          'span',
          null,
          'Continues ',
          showEarlier ? h('button', { type: 'button', class: 'link-btn', onclick: showEarlier }, `the run of ${timeOfDay(earlier!.startedAt)}`) : earlier ? `the run of ${timeOfDay(earlier.startedAt)}` : 'an earlier run',
          ` from ${groupName(cont.stepId)}.`,
        )
      : null,
    later
      ? h('span', null, 'Continued in a later run', actions.onShowRun ? [' — ', h('button', { type: 'button', class: 'link-btn', onclick: () => actions.onShowRun!(later.id) }, 'show it')] : null, '.')
      : null,
    run.revertedAt ? h('span', null, `Files reverted at ${timeOfDay(run.revertedAt)} — it can only run again from the start.`) : null,
    run.interrupted && !active ? h('span', null, 'Interrupted: CAST restarted while this ran. Pick it up with “Run again” on the step it reached.') : null,
  ].filter(Boolean);
  return h(
    'section',
    { class: ['run', `run-${run.status}`], 'aria-label': `Run: ${run.workflowName}` },
    h(
      'header',
      { class: 'run-head' },
      h('span', { class: ['run-pill', `is-${run.status}`] }, active && run.status === 'running' ? h('span', { class: 'pulse' }) : null, run.interrupted && !active ? 'Interrupted' : RUN_STATUS_TEXT[run.status]),
      h('span', { class: 'run-name' }, run.workflowName),
      adhoc ? h('span', { class: 'chip', title: 'A team made for this task only — its people leave after the run' }, 'one-off') : null,
      cont ? h('span', { class: 'chip chip-kept run-cont-chip', title: 'Continues an earlier run: the steps before it kept their results' }, icon('loop', 11), 'continued') : null,
      h(
        'span',
        { class: 'run-stats num' },
        run.loop ? h('span', { title: 'Review rounds' }, icon('loop', 12), String(run.loop)) : null,
        h(
          'span',
          {
            title: waitedFor(run, now) >= 1000 ? `Worked ${fmtDuration(runWorked(run, now))}, waited ${fmtDuration(waitedFor(run, now))} for you (${fmtDuration(runElapsed(run, now))} in all)` : 'Working time',
            'data-since': active ? String(run.startedAt) : undefined,
            'data-wait': active && run.waitedMs ? String(run.waitedMs) : undefined,
            'data-wait-from': active && run.waitingSince !== undefined ? String(run.waitingSince) : undefined,
            'data-fmt': 'dur',
          },
          fmtDuration(runWorked(run, now)),
        ),
        waitedFor(run, now) >= 1000 && !active ? h('span', { class: 'run-waited', title: 'Time the team waited for your approval' }, icon('hand', 11), fmtDuration(waitedFor(run, now))) : null,
        h('span', { title: `This run: ${fmtUsd(run.costUsd)}` }, fmtUsd(run.costUsd)),
      ),
    ),
    h('p', { class: 'run-task' }, h('span', { class: 'muted' }, `Started ${timeOfDay(run.startedAt)}${lead ? ` by the ${lead}` : ''} — `), run.task),
    contLine.length ? h('p', { class: 'run-cont' }, icon('loop', 12), h('span', null, contLine.flatMap((x, i) => (i ? [' ', x] : [x])))) : null,
    run.edits?.length
      ? h(
          'details',
          {
            class: 'run-edits',
            // a live run's card is rebuilt on every update: it stays open once opened (like a step's output)
            open: openOutputs.has(`${run.id}:edits`),
            ontoggle: (ev: Event) => ((ev.currentTarget as HTMLDetailsElement).open ? openOutputs.add(`${run.id}:edits`) : openOutputs.delete(`${run.id}:edits`)),
          },
          h('summary', null, icon('pencil', 12), h('span', null, `Changed during the run${run.edits.length > 1 ? ` (${run.edits.length})` : ''}`), h('span', { class: 'run-edits-last muted' }, ` — ${run.edits.at(-1)!.changes.join('; ')}`)),
          h('ul', null, run.edits.map((e) => h('li', null, editedLine(e)))),
        )
      : null,
    h('div', { class: 'tl' }, rows),
    h(
      'div',
      { class: 'run-actions' },
      active ? h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: actions.onAbort }, icon('stop', 13), 'Stop run') : null,
      h('button', { type: 'button', class: 'btn btn-soft btn-sm', onclick: () => shell.openDiff(run.projectId) }, icon('tv', 14), 'See changes'),
      keepBtn,
      canRevert
        ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-deny', onclick: actions.onRevert, title: 'Restore files to how they were before this run' }, icon('revert', 14), 'Revert files')
        : null,
    ),
  );
}
