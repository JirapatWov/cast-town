// The top bar's "More" button on phones and touch screens. A phone's top bar has no room for the graphics menu, the
// focus-mode (Town board) toggle or the command palette button, and a phone has no Ctrl+K or ` key: everything those
// give a desktop is here, plus the terminal (a phone has no Ctrl+`; left out when the owner turned it off), help,
// settings, the Return-key choice and the welcome tour.
import { agentsState } from './agents-health';
import { providersStatus } from './model-state';
import { deviceStorage, h } from './dom';
import { icon } from './icons';
import { openMenu, type MenuItem, type MenuSection } from './menu';
import { playerMenuSection } from './player-menu';
import { qualityMenuSection } from './quality-menu';
import { isStandalone } from '../pwa/install';
import { openSettings } from './settings';
import type { Shell } from './shell';
import { terminalOffered } from './terminal-gate';
import { timeOfDayMenuSection } from './time-menu';
import { ENTER_SENDS_KEY, enterSends, isPhoneBoard, isTouchUI } from './touch';

/** `extra`: items for top-bar buttons that are out of sight right now (asked each time the menu opens). */
export function createMoreButton(shell: Shell, extra: () => (MenuItem | null)[] = () => []): HTMLButtonElement {
  const btn = h(
    'button',
    { type: 'button', class: 'tb-btn tb-icon tb-more', 'aria-haspopup': 'menu', 'aria-label': 'More: Town board, search, terminal, models, graphics', title: 'More' },
    icon('dots', 18),
  );
  let close: (() => void) | null = null;
  btn.addEventListener('click', () => {
    // a second tap on the button closes the menu (the popover's outside-click ignores its own anchor)
    if (close && btn.getAttribute('aria-expanded') === 'true') return void close();
    const returnSends = enterSends({ touch: isTouchUI(), pref: deviceStorage.get(ENTER_SENDS_KEY) });
    // inside a house: New job (a phone's jobs bar waits behind the panel's chevron, so this was palette-only)
    const house = shell.view.view === 'house' ? shell.store.project(shell.view.projectId) : undefined;
    // Board on a phone: the tour sits with Help (after the Chat section it read as a chat setting) and the Return-key
    // choice gets an icon like every other line, so the labels line up
    const board = isPhoneBoard(shell.focusMode);
    const tour: MenuItem = { label: 'Welcome tour', icon: 'sparkle', onSelect: () => shell.openOnboarding() };
    const sections: (MenuSection | null)[] = [
      {
        items: ([
          shell.focusMode ? null : { label: 'Town board', hint: '2D · saves battery', icon: 'focus', onSelect: () => shell.setFocusMode(true) },
          house ? { label: 'New job…', hint: `in ${house.name}`, icon: 'plus', onSelect: () => shell.openNewJob(house.id) } : null,
          { label: 'Search and commands', icon: 'search', onSelect: () => shell.openPalette() },
          terminalOffered() ? { label: 'Terminal', icon: 'terminal', onSelect: () => shell.openTerminal() } : null,
          // the top bar's providers button is the first thing a phone's top bar drops: its state comes along here
          { label: 'Models and providers', hint: providersStatus(agentsState(shell.store.state.hello).kind, shell.store.state).hint, icon: 'key', onSelect: () => shell.openProviders() },
          { label: 'Settings', hint: 'Devices, pairing, your data', icon: 'gear', onSelect: () => openSettings(shell) },
          { label: 'Help', icon: 'help', onSelect: () => shell.openHelp() },
          board ? tour : null,
          // the installed app has no address bar and no pull-to-refresh
          isStandalone() ? { label: 'Reload CAST', icon: 'refresh', onSelect: () => location.reload() } : null,
          ...extra(),
          // in the Board the way back to 3D closes the navigation items, with a label that says where it goes
          shell.focusMode ? { label: 'Switch to the 3D town', icon: 'focus', onSelect: () => shell.setFocusMode(false) } : null,
        ] as (MenuItem | null)[]).filter((i): i is MenuItem => i !== null),
      },
      // the 3D settings mean nothing while the town is paused, but stay reachable (they apply when it comes back);
      // in the Board the graphics section is left out: it only matters in 3D
      shell.focusMode ? null : qualityMenuSection(shell),
      timeOfDayMenuSection(shell),
      playerMenuSection(shell, btn),
      {
        title: 'Chat',
        items: [
          {
            label: 'Return key sends',
            icon: board ? 'send' : undefined,
            hint: returnSends ? undefined : 'Off: Return adds a line',
            checked: returnSends,
            onSelect: () => deviceStorage.set(ENTER_SENDS_KEY, returnSends ? '0' : '1'),
          },
        ],
      },
      board ? null : { items: [tour] },
    ];
    close = openMenu(shell.root, shell.layers, btn, sections.filter((s): s is MenuSection => s !== null), {
      id: 'more-menu',
      align: 'end',
      minWidth: 250,
      className: 'more-menu',
      focusFirst: true,
    });
  });
  return btn;
}
