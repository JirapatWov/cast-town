// Time of day: a section in the graphics menu (and palette commands). Auto follows this computer's clock.
import type { TimeOfDayMode, TimeOfDayPhase } from '../core/types';
import type { MenuSection } from './menu';
import type { Shell } from './shell';

export const TIME_OF_DAY_LABEL: Record<TimeOfDayMode, string> = { auto: 'Auto', day: 'Day', golden: 'Golden hour', night: 'Night' };
const PHASE_SWATCH: Record<TimeOfDayPhase, string> = { day: '#F3D27A', golden: '#EE9A52', night: '#5B6FB4' };
const MODES: TimeOfDayMode[] = ['auto', 'day', 'golden', 'night'];

/** The menu section (null when the engine has no time of day, e.g. without WebGL). */
export function timeOfDayMenuSection(shell: Shell): MenuSection | null {
  const engine = shell.engine;
  const tod = engine.timeOfDay;
  if (!tod || !engine.setTimeOfDay) return null;
  return {
    title: 'Time of day',
    items: MODES.map((m) => ({
      label: TIME_OF_DAY_LABEL[m],
      hint: m === 'auto' ? `Clock · ${TIME_OF_DAY_LABEL[tod.phase]}` : undefined,
      swatch: m === 'auto' ? undefined : PHASE_SWATCH[m],
      icon: m === 'auto' ? 'clock' : undefined,
      checked: tod.mode === m,
      onSelect: () => engine.setTimeOfDay?.(m),
    })),
  };
}

/** Palette commands: "Time of day: Night" … */
export function timeOfDayCommands(shell: Shell): { mode: TimeOfDayMode; title: string; current: boolean; run(): void }[] {
  const engine = shell.engine;
  const tod = engine.timeOfDay;
  if (!tod || !engine.setTimeOfDay) return [];
  return MODES.map((m) => ({
    mode: m,
    title: `Time of day: ${TIME_OF_DAY_LABEL[m]}`,
    current: tod.mode === m,
    run: () => engine.setTimeOfDay?.(m),
  }));
}
