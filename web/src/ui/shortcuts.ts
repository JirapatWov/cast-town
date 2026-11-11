// Keyboard shortcuts: the one list every part of CAST reads (contract C5) — the global key handler (keyboard.ts),
// the in-app help and Settings list them from here, and hints follow the single-key setting.
//
// Single-key shortcuts (a bare letter, digit or `) are convenient, but they fire whenever focus is not in a text box:
// voice control and dictation type letters, screen readers send them in browse mode, and a focus that falls to the
// page turns a typed sentence into commands (WCAG 2.1.4). So they can be switched off, and are off by default on
// touch devices, where they are hardly reachable anyway. Shortcuts with Ctrl/⌘/Alt are always on.
import { deviceStorage } from './dom';

export type ShortcutScope =
  /** Anywhere in CAST (outside the terminal). */
  | 'global'
  /** In the town (3D or Board), not inside a house. */
  | 'city'
  /** Inside a house. */
  | 'house'
  /** In the chat's message box. */
  | 'composer'
  /** While an approval card (or a button in it) has focus. */
  | 'approval'
  /** In the terminal dock. */
  | 'terminal'
  /** While driving the car. */
  | 'drive'
  /** In menus, lists and option groups. */
  | 'lists';

export interface Shortcut {
  id: string;
  /** One key combination, as shown: modifiers first. 'Mod' is ⌘ on a Mac and Ctrl elsewhere. */
  keys: string[];
  label: string;
  scope: ShortcutScope;
  /** A bare key (no Ctrl/⌘/Alt): off while single-key shortcuts are switched off. */
  single?: boolean;
}

export const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: 'Anywhere',
  city: 'In the town',
  house: 'In a house',
  composer: 'In the message box',
  approval: 'On an approval card',
  terminal: 'In the terminal',
  drive: 'While driving',
  lists: 'Menus, lists and options',
};

export const SHORTCUTS: Shortcut[] = [
  { id: 'palette', keys: ['Mod', 'K'], label: 'Search and commands', scope: 'global' },
  // by the character, not the key: Shift+/ on a US keyboard, elsewhere on others (keyboard.ts)
  { id: 'help', keys: ['?'], label: 'Help and keyboard shortcuts', scope: 'global', single: true },
  { id: 'terminal', keys: ['Ctrl', '`'], label: 'Show or hide the terminal', scope: 'global' },
  { id: 'escape', keys: ['Esc'], label: 'Close the top menu or dialog; then leave the box, close the panel, back to the town', scope: 'global' },
  { id: 'chat', keys: ['/'], label: 'Type to the person in the chat', scope: 'global', single: true },
  { id: 'view', keys: ['`'], label: 'Switch between Board and 3D town', scope: 'global', single: true },
  { id: 'enter-house', keys: ['1–9'], label: 'Enter house 1 to 9', scope: 'global', single: true },
  { id: 'workflow', keys: ['W'], label: 'Workflow tab of the house', scope: 'global', single: true },
  { id: 'changes', keys: ['T'], label: 'Watch TV — what changed', scope: 'global', single: true },
  { id: 'jobs', keys: ['J'], label: 'Switch job', scope: 'house', single: true },
  { id: 'drive', keys: ['D'], label: 'Drive the car', scope: 'city', single: true },
  { id: 'approve', keys: ['A'], label: 'Approve', scope: 'approval', single: true },
  { id: 'deny', keys: ['D'], label: 'Deny', scope: 'approval', single: true },
  { id: 'send', keys: ['Enter'], label: 'Send (queues while they work)', scope: 'composer' },
  { id: 'newline', keys: ['Shift', 'Enter'], label: 'New line', scope: 'composer' },
  { id: 'send-now', keys: ['Mod', 'Enter'], label: 'Send now (read at their next step)', scope: 'composer' },
  { id: 'mode', keys: ['Alt', 'M'], label: 'Switch permission mode: Ask first → Accept edits → Auto', scope: 'composer' },
  { id: 'model', keys: ['Alt', 'P'], label: 'Pick the model', scope: 'composer' },
  { id: 'effort', keys: ['Alt', 'T'], label: 'Pick the effort', scope: 'composer' },
  { id: 'leave-box', keys: ['Esc'], label: 'Leave the message box', scope: 'composer' },
  { id: 'run', keys: ['Mod', 'Enter'], label: 'Run the workflow (in the Workflow tab’s task box)', scope: 'composer' },
  { id: 'term-interrupt', keys: ['Ctrl', 'C'], label: 'Interrupt the running command', scope: 'terminal' },
  { id: 'term-copy', keys: ['Ctrl', 'Shift', 'C'], label: 'Copy the selection', scope: 'terminal' },
  { id: 'term-paste', keys: ['Ctrl', 'Shift', 'V'], label: 'Paste', scope: 'terminal' },
  { id: 'term-leave', keys: ['Ctrl', '`'], label: 'Leave the terminal (shells keep running)', scope: 'terminal' },
  { id: 'steer', keys: ['W', 'A', 'S', 'D'], label: 'Steer', scope: 'drive' },
  { id: 'brake', keys: ['Space'], label: 'Brake', scope: 'drive' },
  { id: 'car-enter', keys: ['E'], label: 'Enter the house in front', scope: 'drive' },
  { id: 'car-leave', keys: ['Esc'], label: 'Leave the car', scope: 'drive' },
  { id: 'floor', keys: ['PageUp'], label: 'Floor up (PageDown: down)', scope: 'house' },
  { id: 'walk', keys: ['↑', '↓', '←', '→'], label: 'Walk your avatar while the 3D view has focus', scope: 'house' },
  { id: 'diff-next', keys: ['J'], label: 'Next file in the changes viewer (K: previous)', scope: 'lists', single: true },
  { id: 'list-move', keys: ['↑', '↓'], label: 'Move in a menu or list', scope: 'lists' },
  { id: 'option-move', keys: ['←', '→'], label: 'Pick the next option in a group (tabs, choices)', scope: 'lists' },
];

export function shortcut(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Keys for display: 'Mod' becomes ⌘ on a Mac and Ctrl elsewhere. */
export function displayKeys(keys: string[], mac: boolean): string[] {
  return keys.map((k) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : k));
}

/** A shown key hint that names one bare key (W, T, 1, `, /, ?): it hides while single-key shortcuts are off. */
export function isSingleKeyHint(keys: string[]): boolean {
  return keys.length === 1 && /^([A-Za-z0-9`/?]|1–9)$/.test(keys[0]);
}

// ───────── the single-key setting ─────────

export const SINGLE_KEYS_KEY = 'rlt.shortcuts.single';

/** The setting as stored ('1' on, '0' off, nothing → the device default). */
export function singleKeysFrom(stored: string | null, touch: boolean): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return !touch;
}

function touchDevice(): boolean {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

const listeners = new Set<(on: boolean) => void>();

export function singleKeysEnabled(): boolean {
  return singleKeysFrom(deviceStorage.get(SINGLE_KEYS_KEY), touchDevice());
}

export function setSingleKeys(on: boolean): void {
  deviceStorage.set(SINGLE_KEYS_KEY, on ? '1' : '0');
  for (const fn of listeners) fn(on);
}

/** Called after every change of the setting. Returns unsubscribe. */
export function onSingleKeysChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
