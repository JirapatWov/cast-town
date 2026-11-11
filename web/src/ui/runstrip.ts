// Live workflow "relay" in the top bar: one chip per role, the baton glows on the active one.
import { h, memo, setChildren } from './dom';
import { fmtClock, fmtUsd, vendorColor } from './format';
import { icon } from './icons';
import { RUN_STATUS_TEXT, isRunActive, runElapsed, runForStrip, stepChips, type ChipStatus } from './runs';
import type { Shell } from './shell';

const STATUS_ICON: Partial<Record<ChipStatus, string>> = { done: 'check', failed: 'x', waiting: 'hand' };

export function createRunStrip(shell: Shell) {
  const el = h('button', { type: 'button', class: 'runstrip glass', hidden: true });
  let runId: string | null = null;
  let timerEl: HTMLElement | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let linger: ReturnType<typeof setTimeout> | null = null;
  const changed = memo();

  el.addEventListener('click', () => {
    const run = runId ? shell.store.state.runs[runId] : undefined;
    if (!run) return;
    if (run.jobId && shell.store.job(run.projectId, run.jobId)) shell.jobs.select(run.projectId, run.jobId);
    shell.openWorkflow(run.projectId);
  });

  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };

  // The strip shares the top bar with both islands. When its relay doesn't fit (a finished run adds its status word, a
  // long team, a narrow window, large text) it steps down instead of cutting a chip mid-name next to the status: first
  // the cost and a finished run's clock and round count go and the names get shorter (is-snug), then only the people's
  // dots stay, as on a phone (is-compact). Each name stays in its chip's tooltip; the Workflow tab has the whole run.
  const overflows = (box: Element | null) => !!box && box.scrollWidth > box.clientWidth + 1;
  // a name squeezed below its own width (or below the step's cap): the chips are shrinking, not overflowing
  const squeezed = (name: HTMLElement) => {
    const cap = parseFloat(getComputedStyle(name).maxWidth);
    return name.clientWidth + 1 < Math.min(name.scrollWidth, Number.isFinite(cap) ? cap : Infinity);
  };
  function fit() {
    if (el.hidden || !el.isConnected) return;
    el.classList.remove('is-snug', 'is-compact', 'is-gone');
    const tight = () =>
      overflows(el) || overflows(el.querySelector('.rs-chips')) || [...el.querySelectorAll<HTMLElement>('.rs-name')].some((n) => n.offsetParent && squeezed(n));
    if (!tight()) return;
    el.classList.add('is-snug');
    if (tight()) el.classList.add('is-compact');
    // even the dots and the status word don't fit (a window about half a screen wide): a sliver of the strip said
    // nothing ("C"), so it gives way until there is room; the Workflow tab and the house's card show the run
    if (el.classList.contains('is-compact') && overflows(el)) el.classList.add('is-gone');
  }
  // the room changes with the window, the panel and the islands' contents (their widths never depend on the strip)
  let watching = false;
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => requestAnimationFrame(fit)) : null;
  function watchRoom() {
    const bar = el.parentElement;
    if (watching || !bar || !resized) return;
    watching = true;
    resized.observe(bar);
    for (const island of bar.children) if (island !== el) resized.observe(island);
  }

  function render() {
    const s = shell.store.state;
    const scope = shell.view.view === 'house' ? shell.view.projectId : null;
    const run = runForStrip(s, scope);
    if (!run) {
      el.hidden = true;
      runId = null;
      stopTick();
      changed(null);
      return;
    }
    const chips = stepChips(s, run);
    if (!changed([run.id, run.status, run.loop, run.costUsd, run.endedAt, scope, chips])) return;
    runId = run.id;
    el.hidden = false;
    const project = shell.store.project(run.projectId);
    const active = isRunActive(run);
    el.className = ['runstrip', 'glass', `run-${run.status}`].join(' ');
    el.setAttribute('aria-label', `${run.workflowName}: ${RUN_STATUS_TEXT[run.status]}. Open workflow`);

    timerEl = h('span', { class: 'rs-time num' }, fmtClock(runElapsed(run)));
    setChildren(el,
      scope ? null : h('span', { class: 'rs-project' }, project?.name ?? 'Run'),
      h(
        'span',
        { class: 'rs-chips' },
        chips.map((c, i) => [
          // people of a parallel group are joined by a "+" instead of the relay line
          i > 0
            ? c.parallel
              ? h('span', { class: 'rs-link is-par', title: 'At the same time' }, '+')
              : h('span', { class: ['rs-link', c.status !== 'pending' && 'is-lit'], style: { '--vc': vendorColor(chips[i - 1].vendor) } })
            : null,
          h(
            'span',
            { class: ['rs-chip', `is-${c.status}`], style: { '--vc': vendorColor(c.vendor) }, title: `${c.name} · ${c.modelLabel}` },
            h('span', { class: 'rs-dot' }, STATUS_ICON[c.status] ? icon(STATUS_ICON[c.status]!, 10) : null),
            h('span', { class: 'rs-name' }, c.name),
            c.attempts > 1 ? h('span', { class: 'rs-attempt num' }, `×${c.attempts}`) : null,
          ),
        ]),
      ),
      run.loop > 0 ? h('span', { class: 'rs-loop', title: `${run.loop} review round${run.loop > 1 ? 's' : ''}` }, icon('loop', 12), String(run.loop)) : null,
      active ? null : h('span', { class: 'rs-status' }, RUN_STATUS_TEXT[run.status]),
      timerEl,
      h('span', { class: 'rs-cost num', title: `This run: ${fmtUsd(run.costUsd)}` }, fmtUsd(run.costUsd)),
    );
    watchRoom();
    fit();

    if (active && !tick) {
      tick = setInterval(() => {
        const r = runId ? shell.store.state.runs[runId] : undefined;
        if (r && timerEl) timerEl.textContent = fmtClock(runElapsed(r));
      }, 1000);
    } else if (!active) {
      stopTick();
      // Finished runs linger for a moment; re-check so the strip hides on its own.
      if (linger) clearTimeout(linger);
      linger = setTimeout(render, 5000);
    }
  }

  return { el, render };
}
