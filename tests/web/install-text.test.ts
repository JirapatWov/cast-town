// How to install CAST on the device looking at Settings → Pair a phone (web/src/pwa/install.ts, pure): which
// platform it is, the steps and the button it gets; and the short pairing code as people read it.
import { describe, expect, test } from 'bun:test';
import { formatShortCode, installHelp, platformOf } from '../../web/src/pwa/install';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

describe('platformOf', () => {
  test('user agent + standalone → platform', () => {
    expect(platformOf(UA.iphone, { standalone: false })).toBe('ios-safari');
    expect(platformOf(UA.iphoneChrome, { standalone: false })).toBe('ios-safari'); // iOS 16.4+: Share → Add to Home Screen too
    expect(platformOf(UA.ipadDesktop, { standalone: false, touchPoints: 5 })).toBe('ios-safari');
    expect(platformOf(UA.iphone, { standalone: true })).toBe('ios-standalone');
    expect(platformOf(UA.android, { standalone: false })).toBe('android-chrome');
    expect(platformOf(UA.macChrome, { standalone: false })).toBe('desktop-chrome');
    expect(platformOf(UA.winEdge, { standalone: false })).toBe('desktop-chrome');
    expect(platformOf(UA.macSafari, { standalone: false, touchPoints: 0 })).toBe('desktop-safari');
    expect(platformOf(UA.macChrome, { standalone: true })).toBe('installed');
    expect(platformOf(UA.firefox, { standalone: false })).toBe('other');
  });
});

describe('installHelp', () => {
  test('iPhone in Safari: Share → Add to Home Screen, then paste a link for the app', () => {
    const h = installHelp('ios-safari', false);
    expect(h.steps.join(' ')).toContain('Add to Home Screen');
    expect(h.steps.join(' ')).toContain('Open as Web App');
    expect(h.steps.join(' ')).toContain('Paste');
    expect(h.button).toBe('copy-app-link');
  });
  test('Chrome with an install prompt: an Install button, no pairing needed', () => {
    expect(installHelp('desktop-chrome', true).button).toBe('install');
    expect(installHelp('android-chrome', true).button).toBe('install');
    expect(installHelp('desktop-chrome', false).button).toBeUndefined();
    expect(installHelp('desktop-chrome', false).steps.join(' ')).toContain('Install');
  });
  test('Mac Safari: Add to Dock keeps this sign-in; installed: says so', () => {
    expect(installHelp('desktop-safari', false).steps.join(' ')).toContain('Add to Dock');
    expect(installHelp('ios-standalone', false).done).toBe(true);
    expect(installHelp('installed', false).done).toBe(true);
  });
});

test('short codes read XXXX-XXXX-XXXX', () => {
  expect(formatShortCode('K7QF3MXA9PZD')).toBe('K7QF-3MXA-9PZD');
  expect(formatShortCode('k7qf-3mxa 9pzd')).toBe('K7QF-3MXA-9PZD');
  expect(formatShortCode('ABC')).toBe('ABC');
});
