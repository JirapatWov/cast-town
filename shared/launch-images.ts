// iOS launch images: the screens, the images and their <link> tags (tools/splash/launch-images.ts draws the PNGs into
// web/public/splash and writes the tags into web/index.html). LAUNCH_IMAGES is the committed set: what index.html
// links, and what the server serves before sign-in and links from the 403 page (server/pwa.ts, server/pages.ts), so a
// Home Screen app added from the 403 page — the documented way in on a phone — gets the launch screen too.

/** Where the PNGs are served (web/public/splash → /splash; Vite makes it relative in the build, like the icons). */
export const URL_DIR = '/splash';

export type Scheme = 'dark' | 'light';
export type Orientation = 'portrait' | 'landscape';

/** A screen in CSS px (portrait: width < height, as iOS reports device-width / device-height in both orientations). */
export interface Screen {
  w: number;
  h: number;
  dpr: number;
  ipad: boolean;
  models: string;
}

export const SCREENS: readonly Screen[] = [
  { w: 440, h: 956, dpr: 3, ipad: false, models: 'iPhone 17 Pro Max, 16 Pro Max' },
  { w: 420, h: 912, dpr: 3, ipad: false, models: 'iPhone Air' },
  { w: 402, h: 874, dpr: 3, ipad: false, models: 'iPhone 17, 17 Pro, 16 Pro' },
  { w: 430, h: 932, dpr: 3, ipad: false, models: 'iPhone 16 Plus, 15 Plus, 15 Pro Max, 14 Pro Max' },
  { w: 393, h: 852, dpr: 3, ipad: false, models: 'iPhone 16, 15, 15 Pro, 14 Pro' },
  { w: 428, h: 926, dpr: 3, ipad: false, models: 'iPhone 14 Plus, 13 Pro Max, 12 Pro Max' },
  { w: 390, h: 844, dpr: 3, ipad: false, models: 'iPhone 17e, 16e, 14, 13, 13 Pro, 12, 12 Pro' },
  { w: 375, h: 812, dpr: 3, ipad: false, models: 'iPhone 13 mini, 12 mini, 11 Pro, XS, X' },
  { w: 414, h: 896, dpr: 3, ipad: false, models: 'iPhone 11 Pro Max, XS Max' },
  { w: 414, h: 896, dpr: 2, ipad: false, models: 'iPhone 11, XR' },
  { w: 375, h: 667, dpr: 2, ipad: false, models: 'iPhone SE (2nd and 3rd generation), 8' },
  { w: 1032, h: 1376, dpr: 2, ipad: true, models: 'iPad Pro 13-inch (M4, M5)' },
  { w: 834, h: 1210, dpr: 2, ipad: true, models: 'iPad Pro 11-inch (M4, M5)' },
  { w: 1024, h: 1366, dpr: 2, ipad: true, models: 'iPad Air 13-inch (M2 and later), iPad Pro 12.9-inch' },
  { w: 820, h: 1180, dpr: 2, ipad: true, models: 'iPad Air 11-inch (M2 and later), iPad Air (4th, 5th gen), iPad (10th gen, A16)' },
  { w: 834, h: 1194, dpr: 2, ipad: true, models: 'iPad Pro 11-inch (1st to 4th generation)' },
  { w: 744, h: 1133, dpr: 2, ipad: true, models: 'iPad mini (6th generation, A17 Pro)' },
  { w: 810, h: 1080, dpr: 2, ipad: true, models: 'iPad (7th to 9th generation)' },
  { w: 834, h: 1112, dpr: 2, ipad: true, models: 'iPad Air (3rd generation), iPad Pro 10.5-inch' },
  { w: 768, h: 1024, dpr: 2, ipad: true, models: 'iPad mini (5th generation), iPad (6th generation), iPad Pro 9.7-inch' },
];

/** One launch image: a screen in one orientation and scheme. */
export interface LaunchImage {
  screen: Screen;
  orientation: Orientation;
  scheme: Scheme;
  /** pixels */
  width: number;
  height: number;
  file: string;
  media: string;
}

/** `darkOnly`: one dark image per screen and orientation, for every appearance (no prefers-color-scheme term). */
export function launchImages(screens: readonly Screen[] = SCREENS, { darkOnly = false }: { darkOnly?: boolean } = {}): LaunchImage[] {
  const out: LaunchImage[] = [];
  for (const screen of screens) {
    for (const orientation of screen.ipad ? (['portrait', 'landscape'] as const) : (['portrait'] as const)) {
      for (const scheme of darkOnly ? (['dark'] as const) : (['dark', 'light'] as const)) {
        const [cw, ch] = orientation === 'portrait' ? [screen.w, screen.h] : [screen.h, screen.w];
        const width = cw * screen.dpr;
        const height = ch * screen.dpr;
        out.push({
          screen,
          orientation,
          scheme,
          width,
          height,
          file: `launch-${scheme}-${width}x${height}.png`,
          media:
            `(device-width: ${screen.w}px) and (device-height: ${screen.h}px) and (-webkit-device-pixel-ratio: ${screen.dpr}) ` +
            `and (orientation: ${orientation})${darkOnly ? '' : ` and (prefers-color-scheme: ${scheme})`}`,
        });
      }
    }
  }
  return out;
}

/** The committed set (`bun tools/splash/launch-images.ts --dark-only`): one dark image per screen for every appearance,
 *  as the installed app's splash starts at night for everyone. */
export const LAUNCH_IMAGES: readonly LaunchImage[] = launchImages(SCREENS, { darkOnly: true });

/** Each image's path on the server (web/public/splash → /splash). */
export const launchImagePaths = (images: readonly LaunchImage[] = LAUNCH_IMAGES): string[] => images.map((im) => `${URL_DIR}/${im.file}`);

export function linkTags(images: readonly LaunchImage[], indent = '    '): string {
  return images.map((im) => `${indent}<link rel="apple-touch-startup-image" media="${im.media}" href="${URL_DIR}/${im.file}" />`).join('\n');
}
