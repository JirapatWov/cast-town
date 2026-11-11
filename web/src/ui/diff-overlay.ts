// Full-screen diff viewer ("watching TV"): file list + diff2html, side-by-side or line-by-line (a phone: always line
// by line, long lines wrapped unless "Wrap" is turned off, one line-number gutter — mobile.css). Like the Changes tab
// it follows the current job: a job with its own copy of the files shows what it changed there since its base. A click
// on the 3D living-room TV opens what that TV shows: the house folder. An approval card opens it with the diff of the
// change it asks about (`patch`) — not git's.
import 'diff2html/bundles/css/diff2html.min.css';
import type { GitSummary, Job } from '../../../shared/protocol';
import { gitKey } from '../net/reducer';
import { gitTarget, statusBadge } from './changes-tab';
import { deviceStorage, h, setChildren } from './dom';
import { markFocus, restoreFocus, type FocusMark } from './focus';
import { singleKeysEnabled } from './shortcuts';
import { splitPath, timeAgo } from './format';
import { icon } from './icons';
import { focusFirst, trapFocus } from './layers';
import type { DiffPatch, Shell } from './shell';
import { NARROW_QUERY } from './touch';
import { emptyState, segmented } from './widgets';

type Layout = 'side-by-side' | 'line-by-line';
const LAYOUT_KEY = 'rlt.diff.layout';
const WRAP_KEY = 'rlt.diff.wrap';
/** Side by side needs two columns of code: a phone gets line by line whatever was picked on a wider screen. */
const narrow = () => matchMedia(NARROW_QUERY).matches;

type D2H = typeof import('./diff-render');
let d2h: D2H | null = null;
let d2hLoading: Promise<D2H> | null = null;
/** diff2html loads with the first diff on show (its own chunk); a failed load is retried on the next open. */
function loadD2h(): Promise<D2H> {
  d2hLoading ??= import('./diff-render').then(
    (m) => (d2h = m),
    (e) => {
      d2hLoading = null;
      throw e;
    },
  );
  return d2hLoading;
}

export function createDiffOverlay(shell: Shell) {
  const { store } = shell;
  let projectId: string | null = null;
  let gitKeyShown = ''; // state.git key on show (gitTarget at open)
  let job: Job | undefined; // the job whose own copy is on show
  let layout: Layout = (deviceStorage.get(LAYOUT_KEY) as Layout) || (window.innerWidth < 900 ? 'line-by-line' : 'side-by-side');
  let rendered = ''; // diff text + layout currently on screen
  let removeLayer: (() => void) | null = null;
  let untrap: (() => void) | null = null;
  let activeFile = 0;
  let previousFocus: FocusMark | null = null; // the opener (or its re-rendered copy) gets focus back
  let patch: DiffPatch | null = null; // on show instead of git's changes

  const title = h('h2', { class: 'diff-title', id: 'diff-title' });
  const meta = h('div', { class: 'diff-meta' });
  const files = h('nav', { class: 'diff-files', 'aria-label': 'Changed files' });
  const body = h('div', { class: 'diff-body', tabindex: '0' });
  const layoutToggle = segmented<Layout>(
    [
      { value: 'side-by-side', label: 'Side by side', icon: 'columns' },
      { value: 'line-by-line', label: 'Line by line', icon: 'rows' },
    ],
    layout,
    (v) => {
      layout = v;
      deviceStorage.set(LAYOUT_KEY, v);
      render(true);
    },
    'Diff layout',
  );
  // phones only (mobile.css): wrap long lines instead of scrolling every one sideways
  let wrap = deviceStorage.get(WRAP_KEY) !== '0';
  const wrapBtn = h('button', { type: 'button', class: 'btn btn-soft btn-sm diff-wrap', 'aria-pressed': String(wrap), title: 'Wrap long lines' }, icon('rows', 14), 'Wrap');
  wrapBtn.addEventListener('click', () => {
    wrap = !wrap;
    deviceStorage.set(WRAP_KEY, wrap ? '1' : '0');
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    body.classList.toggle('is-wrap', wrap);
  });
  body.classList.toggle('is-wrap', wrap);
  const panel = h(
    'div',
    { class: 'diff-panel glass-strong', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'diff-title' },
    h(
      'header',
      { class: 'diff-head' },
      h('span', { class: 'diff-tv' }, icon('tv', 18)),
      h('div', { class: 'diff-titles' }, title, meta),
      layoutToggle,
      wrapBtn,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close diff', title: 'Close (Esc)', onclick: () => api.close() }, icon('x', 18)),
    ),
    h('div', { class: 'diff-main' }, files, body),
  );
  const el = h('div', { class: 'diff-overlay', hidden: true }, panel);
  el.addEventListener('pointerdown', (ev) => {
    if (ev.target === el) api.close();
  });

  function wrappers(): HTMLElement[] {
    return [...body.querySelectorAll<HTMLElement>('.d2h-file-wrapper')];
  }

  function jumpTo(i: number) {
    const w = wrappers();
    if (!w.length) return;
    activeFile = (i + w.length) % w.length;
    w[activeFile].scrollIntoView({ block: 'start', behavior: 'smooth' });
    markActive();
  }

  function markActive() {
    files.querySelectorAll('.diff-file').forEach((b, i) => b.classList.toggle('is-on', i === activeFile));
  }

  /** The layout on screen: a phone gets line by line whatever was picked on a wider screen. */
  const shownLayout = (): Layout => (narrow() ? 'line-by-line' : layout);

  /** diff2html isn't loaded yet (its own chunk): show that, and render again once it is here. True → wait. */
  function needD2h(): boolean {
    if (d2h) return false;
    rendered = ''; // render again once diff2html is here
    setChildren(files);
    setChildren(body, h('div', { class: 'loading-row', role: 'status' }, h('span', { class: 'spinner' }), 'Loading diff…'));
    loadD2h().then(
      () => {
        if (!el.hidden) render(true);
      },
      (e: Error) => setChildren(body, emptyState('alert', 'Could not load the diff viewer', `${e.message}. Close and open it again to retry.`)),
    );
    return true;
  }

  /** diff2html of `diff` into the body, and the file list beside it (after needD2h said it is loaded). */
  function paint(diff: string, statusOf: (name: string) => string | undefined) {
    const m = d2h!;
    const scrollTop = body.scrollTop;
    const parsed = m.parse(diff, { matching: 'lines' });
    body.innerHTML = m.html(parsed, {
      outputFormat: shownLayout(),
      drawFileList: false,
      matching: 'lines',
      diffStyle: 'word',
      colorScheme: m.ColorSchemeType.DARK,
      renderNothingWhenEmpty: false,
    });
    body.scrollTop = scrollTop;

    setChildren(files,
      ...parsed.map((f, i) => {
        const name = f.newName === '/dev/null' ? f.oldName : f.newName;
        const { dir, file } = splitPath(name);
        const status = statusOf(name) ?? (f.isNew ? 'A' : f.isDeleted ? 'D' : f.isRename ? 'R' : 'M');
        return h(
          'button',
          { type: 'button', class: ['diff-file', i === activeFile && 'is-on'], title: name, onclick: () => jumpTo(i) },
          statusBadge(status),
          h('span', { class: 'diff-file-name' }, h('span', { class: 'file-name' }, file), dir ? h('span', { class: 'file-dir' }, dir) : null),
          h('span', { class: 'file-stat num' }, f.addedLines ? h('span', { class: 'add' }, `+${f.addedLines}`) : null, f.deletedLines ? h('span', { class: 'del' }, `−${f.deletedLines}`) : null),
        );
      }),
    );
  }

  function renderPatch(p: DiffPatch, force: boolean) {
    title.textContent = p.title;
    if (needD2h()) {
      setChildren(meta, h('span', { class: 'muted' }, 'not made yet — waiting for your approval'));
      return;
    }
    const parsed = d2h!.parse(p.diff);
    const adds = parsed.reduce((t, f) => t + f.addedLines, 0);
    const dels = parsed.reduce((t, f) => t + f.deletedLines, 0);
    setChildren(meta,
      h('span', { class: 'num' }, h('span', { class: 'add' }, `+${adds}`), ' ', h('span', { class: 'del' }, `−${dels}`)),
      h('span', { class: 'muted' }, `${parsed.length} ${parsed.length === 1 ? 'file' : 'files'} · not made yet — waiting for your approval`),
      p.note ? h('span', { class: 'muted' }, p.note) : null,
    );
    const key = `${shownLayout()}\npatch\n${p.diff}`;
    if (!force && key === rendered) return;
    rendered = key;
    paint(p.diff, () => undefined);
  }

  function render(force = false) {
    if (patch) return renderPatch(patch, force);
    const project = store.project(projectId);
    if (job) job = store.job(job.projectId, job.id) ?? job; // renamed meanwhile
    const summary: GitSummary | undefined = projectId ? store.state.git[gitKeyShown] : undefined;
    title.textContent = job ? `Changes in “${job.name}” (own copy)` : project ? `Changes in ${project.name}` : 'Changes';
    if (!summary) {
      setChildren(meta, h('span', null, 'Reading git status…'));
      setChildren(files);
      setChildren(body, h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), 'Loading diff…'));
      rendered = '';
      return;
    }
    const adds = summary.files.reduce((t, f) => t + f.additions, 0);
    const dels = summary.files.reduce((t, f) => t + f.deletions, 0);
    setChildren(meta,
      job?.worktree
        ? h('span', { class: 'branch-chip is-copy', title: job.worktree.path }, icon('copy', 13), h('span', { class: 'branch-chip-text' }, job.worktree.branch))
        : h('span', { class: 'branch-chip' }, icon('branch', 13), summary.branch ?? 'detached'),
      h('span', { class: 'num' }, h('span', { class: 'add' }, `+${adds}`), ' ', h('span', { class: 'del' }, `−${dels}`)),
      h('span', { class: 'muted' }, `${summary.files.length} ${summary.files.length === 1 ? 'file' : 'files'} · ${job ? 'not in the house yet' : 'vs last commit'} · updated ${timeAgo(summary.ts)}`),
    );

    const key = `${shownLayout()}\n${summary.diff}`;
    if (!force && key === rendered) return;
    rendered = key;

    if (!summary.diff.trim()) {
      setChildren(files);
      setChildren(body, job
        ? emptyState('checkCircle', 'Nothing new in its copy', `Everything “${job.name}” changed is in the house already. Give it a task and watch this fill up.`)
        : emptyState('checkCircle', 'Nothing changed', 'The working tree matches the last commit. Give someone a task and watch this fill up.'));
      return;
    }
    if (needD2h()) return;
    paint(summary.diff, (name) => summary.files.find((x) => x.path === name)?.status);
  }

  // A tablet turned (or a window resized) across the phone width: the layout it may show changes.
  matchMedia(NARROW_QUERY).addEventListener('change', () => {
    if (!el.hidden) render(true);
  });

  // Keep the sidebar highlight in sync with scrolling.
  body.addEventListener(
    'scroll',
    () => {
      const top = body.getBoundingClientRect().top + 24;
      const w = wrappers();
      let idx = 0;
      for (let i = 0; i < w.length; i++) if (w[i].getBoundingClientRect().top <= top) idx = i;
      if (idx !== activeFile) {
        activeFile = idx;
        markActive();
      }
    },
    { passive: true },
  );

  panel.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement || ev.ctrlKey || ev.metaKey || ev.altKey || !singleKeysEnabled()) return;
    if (ev.key === 'j' || ev.key === 'J') jumpTo(activeFile + 1);
    else if (ev.key === 'k' || ev.key === 'K') jumpTo(activeFile - 1);
  });

  const api = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    get projectId() {
      return projectId;
    },
    open(pid: string, file?: string, opts?: { house?: boolean; patch?: DiffPatch }) {
      projectId = pid;
      patch = opts?.patch ?? null;
      ({ key: gitKeyShown, job } = opts?.house || patch ? { key: gitKey(pid), job: undefined } : gitTarget(shell, pid));
      activeFile = 0;
      if (!patch) store.send(job ? { t: 'get_git', projectId: pid, jobId: job.id } : { t: 'get_git', projectId: pid });
      if (el.hidden) {
        previousFocus = markFocus();
        el.hidden = false;
        requestAnimationFrame(() => el.classList.add('is-open'));
        removeLayer = shell.layers.push({ id: 'diff', close: () => api.close(), modal: true });
        untrap = trapFocus(panel);
        requestAnimationFrame(() => focusFirst(panel));
      }
      render(true);
      if (file)
        void loadD2h().then((m) => {
          const idx = m.parse((patch ? patch.diff : store.state.git[gitKeyShown]?.diff) ?? '').findIndex((f) => f.newName === file || f.oldName === file);
          if (idx >= 0) requestAnimationFrame(() => jumpTo(idx));
        }, () => {});
    },
    close() {
      if (el.hidden) return;
      removeLayer?.();
      untrap?.();
      removeLayer = untrap = null;
      el.classList.remove('is-open');
      setTimeout(() => {
        if (!el.classList.contains('is-open')) el.hidden = true;
      }, 180);
      restoreFocus(previousFocus);
    },
    onState() {
      if (!el.hidden) render();
    },
  };
  return api;
}
