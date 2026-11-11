// The UI-internal context every panel receives: app context + cross-panel actions.
import type { RoomRef } from '../../../shared/protocol';
import type { Bus, Engine, Quality, Store, ViewName } from '../core/types';
import type { ConfirmOptions } from './confirm';
import type { HelpSection } from './help';
import type { JobChoice } from './jobs';
import type { LayerStack } from './layers';
import type { SettingsSection } from './settings';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

/** A button in a toast beside its text (e.g. "Bring back" after Undo changes); the toast closes when it is used. */
export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastEntry {
  id: number;
  level: ToastLevel;
  text: string;
  ts: number;
  projectId?: string;
  agentId?: string;
}

export type PanelTab = 'chat' | 'workflow' | 'changes' | 'inbox';

/** A diff to show on the TV overlay that isn't the project's git changes (an approval's proposed edit). */
export interface DiffPatch {
  title: string;
  diff: string;
  note?: string;
}

export interface Shell {
  readonly store: Store;
  readonly bus: Bus;
  readonly engine: Engine;
  readonly root: HTMLElement; // the .rlt-ui overlay
  readonly layers: LayerStack;

  /** Where the camera currently is (from view:changed / store). */
  readonly view: { view: ViewName; projectId: string | null };
  /** The Town board (2D) is showing; the 3D town is paused, or not loaded at all (view-mode.ts). */
  readonly focusMode: boolean;
  readonly quality: Quality;
  /** Board (true) or 3D town (false): remembered per device. 3D that isn't loaded yet loads first (the board stays
   *  until it is ready); without WebGL the board stays and says why. */
  setFocusMode(on: boolean): void;
  /** quiet: no "Graphics set to …" toast (the caller says something better, e.g. auto step-down). */
  setQuality(q: Quality, opts?: { quiet?: boolean }): void;

  /** Say something to screen readers without moving focus (assertive: errors and other urgent news only). */
  announce(text: string, level?: 'polite' | 'assertive'): void;
  /** onClick: the toast's text becomes a button (e.g. open that person's chat); action: a button beside the text. */
  toast(level: ToastLevel, text: string, opts?: { projectId?: string; agentId?: string; onClick?: () => void; action?: ToastAction; ttl?: number }): void;
  readonly notifications: ToastEntry[];
  /** The person whose chat the side panel shows right now (panel open on the Chat tab), else null. */
  readonly chatAgentId: string | null;
  confirm(opts: ConfirmOptions): Promise<boolean>;

  /** draft: a starter sentence for the chat box, only when it is empty (never replaces what the user typed). */
  openAgent(agentId: string, opts?: { focusComposer?: boolean; draft?: string }): void;
  openPanel(tab: PanelTab, projectId?: string | null): void;
  closePanel(): void;
  /** runId: show that run (a plan card's "Open run"); without it the tab shows the job's latest run. */
  openWorkflow(projectId: string, runId?: string): void;
  /** Follows the current job (its own copy of the files when it has one); house: the house folder, as the 3D TV shows. */
  /** `patch`: show this diff (an approval's proposed change) instead of the project's git changes. */
  openDiff(projectId: string, file?: string, opts?: { house?: boolean; patch?: DiffPatch }): void;
  openPlacement(lotId?: string): void;
  openProviders(): void;
  openPalette(): void;
  /** Plain shell on the server (not an omp session). No target: the last one used, else this house / the town. */
  openTerminal(target?: string): void;
  toggleTerminal(): void;
  openOnboarding(): void;
  /** Help: town words, shortcuts, omp status, docs and bug links, diagnostics; optionally at one section. */
  openHelp(section?: HelpSection): void;
  /** Settings: view, keyboard shortcuts, accessibility, devices and pairing, the terminal, your data; optionally
   *  scrolled to one section. */
  openSettings(section?: SettingsSection): void;
  /** focusPanel: then move focus into the side panel (a keyboard user entering from a list: the next step is there). */
  enterProject(projectId: string, opts?: { focusPanel?: boolean }): void;
  /** Best project to act on: current house, else the side panel's project, else the first project. */
  contextProjectId(): string | null;

  /** The job the panels act on, per house (see jobs.ts). */
  readonly jobs: JobChoice;
  /** Pick a job: the chat roster and Workflow tab follow it; focus also frames its room in the house. */
  selectJob(projectId: string, jobId: string, opts?: { focus?: boolean; openPanel?: boolean }): void;
  /** "+ New job" dialog, optionally with a room preselected (e.g. an empty room clicked in 3D). */
  openNewJob(projectId: string, room?: RoomRef): void;
  /** Edit an existing job: 'edit' (name, kind, lead, team, brief), 'move' (room picker) or 'rename' (quick popover at anchor). */
  editJob(projectId: string, jobId: string, mode: 'edit' | 'move' | 'rename', anchor?: HTMLElement): void;
  deleteJob(projectId: string, jobId: string): Promise<void>;
  /** Grow the house by one floor; resolves with the new floor index, or null when it failed. */
  addFloor(projectId: string): Promise<number | null>;
}
