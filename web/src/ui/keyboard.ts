// Global keyboard shortcuts. Uses event.code so shortcuts work with any keyboard layout (e.g. Thai).
// The list of shortcuts (for help and Settings) is shortcuts.ts; bare-key shortcuts only run while the single-key
// setting is on (WCAG 2.1.4: dictation, voice control and screen readers type letters).
import { isTypingTarget } from './dom';
import { focusOutOf } from './focus';
import type { Shell } from './shell';
import { singleKeysEnabled } from './shortcuts';

export interface KeyboardDeps {
  togglePalette(): void;
  /** The Help dialog (the ? key). */
  openHelp(): void;
  toggleTerminal(): void;
  /** Answer the approval whose card holds the focus (A / D there). False when it can't be answered that way. */
  answerApproval(approvalId: string, kind: 'approve' | 'deny'): boolean;
  panelOpen(): boolean;
  closePanel(): void;
  focusChat(): void;
  /** Open the job switcher of the current house; false when there is nothing to switch. */
  openJobs(): boolean;
  /** Move focus into the side panel's open tab (after a shortcut opened it, so focus follows). */
  focusPanelPane(): void;
}

export function installKeyboard(shell: Shell, deps: KeyboardDeps): () => void {
  const { bus } = shell;

  const onKey = (ev: KeyboardEvent) => {
    if (ev.isComposing || ev.keyCode === 229) return;

    // Ctrl+` shows/hides the terminal (as in VS Code), from anywhere — including from inside it.
    if (ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.code === 'Backquote') {
      ev.preventDefault();
      if (!ev.repeat) deps.toggleTerminal();
      return;
    }
    // Inside the terminal every other key belongs to the shell (Esc for vim, Ctrl+K for readline, …).
    if (ev.target instanceof Element && ev.target.closest('.term-dock')) return;

    // Cmd/Ctrl+K works everywhere, even while typing.
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.code === 'KeyK') {
      ev.preventDefault();
      deps.togglePalette();
      return;
    }

    if (ev.key === 'Escape') {
      if (ev.repeat) return;
      if (shell.layers.closeTop()) {
        ev.preventDefault();
        return;
      }
      if (isTypingTarget(ev.target)) {
        // Out of the box, onto the region around it (never <body>: the next Tab would start over at the top).
        focusOutOf(ev.target as HTMLElement);
        return;
      }
      if (deps.panelOpen()) {
        deps.closePanel();
        return;
      }
      if (shell.view.view !== 'city') bus.emit('nav:city', {});
      return;
    }

    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
    if (isTypingTarget(ev.target)) return;
    if (!singleKeysEnabled()) return;

    // A / D answer an approval only while its card has the focus: a deliberate act, never a stray letter typed
    // after focus fell to the page.
    const card = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-approval-id]') : null;
    if (card && (ev.code === 'KeyA' || ev.code === 'KeyD')) {
      if (deps.answerApproval(card.dataset.approvalId!, ev.code === 'KeyA' ? 'approve' : 'deny')) ev.preventDefault();
      return;
    }

    if (shell.layers.hasModal) return;
    const view = shell.view.view;
    if (view === 'drive') return; // the car owns the keyboard

    // ? opens Help. By the character, not the key code: it is Shift+/ on a US keyboard but elsewhere on others.
    if (ev.key === '?') {
      ev.preventDefault();
      deps.openHelp();
      return;
    }

    const pid = shell.contextProjectId();
    let handled = true;
    switch (ev.code) {
      case 'Slash':
        if (ev.shiftKey) handled = false; // '?' on most layouts: left to the help
        else deps.focusChat();
        break;
      case 'Backquote':
        shell.setFocusMode(!shell.focusMode);
        break;
      case 'KeyD':
        if (view === 'city' && !shell.focusMode) bus.emit('nav:drive', {});
        else handled = false;
        break;
      case 'KeyT':
        if (pid) shell.openDiff(pid);
        else handled = false;
        break;
      case 'KeyW':
        if (pid) {
          shell.openWorkflow(pid);
          requestAnimationFrame(() => deps.focusPanelPane());
        } else handled = false;
        break;
      case 'KeyJ':
        handled = deps.openJobs();
        break;
      default: {
        const m = /^Digit([1-9])$/.exec(ev.code);
        if (m && !ev.shiftKey) {
          const project = shell.store.state.city.projects[Number(m[1]) - 1];
          if (project) shell.enterProject(project.id);
          else handled = false;
        } else handled = false;
      }
    }
    if (handled) ev.preventDefault();
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
