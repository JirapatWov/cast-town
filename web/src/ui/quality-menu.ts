// Graphics quality: a section in the top bar's quality menu (desktop) and in the phone's More menu.
import type { Quality } from '../core/types';
import type { MenuSection } from './menu';
import type { Shell } from './shell';

export const QUALITY_LABEL: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };
export const QUALITY_HINT: Record<Quality, string> = {
  low: 'Fastest, simple light',
  medium: 'Shadows + soft light',
  high: 'Ambient occlusion, bloom',
  ultra: 'Everything, full resolution',
};

export function qualityMenuSection(shell: Shell): MenuSection {
  return {
    title: 'Graphics quality',
    items: (Object.keys(QUALITY_LABEL) as Quality[]).map((q) => ({
      label: QUALITY_LABEL[q],
      hint: QUALITY_HINT[q],
      checked: shell.quality === q,
      onSelect: () => shell.setQuality(q),
    })),
  };
}
