// The web app manifest and the install metas: what makes CAST installable everywhere and keeps the identity of apps
// already installed (id "/" = Chrome's own recommended id for them).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUB = resolve(import.meta.dir, '../../web/public');
const m = JSON.parse(readFileSync(join(PUB, 'manifest.webmanifest'), 'utf8')) as {
  id: string; name: string; short_name: string; start_url: string; scope: string; display: string;
  icons: { src: string; sizes: string; purpose?: string }[];
  shortcuts?: { name: string; url: string; icons?: { src: string }[] }[];
  screenshots?: { src: string; sizes: string; form_factor?: string }[];
  launch_handler?: { client_mode: string };
};

/** width × height from a PNG's IHDR. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('manifest.webmanifest', () => {
  test('identity, scope and display', () => {
    expect(m.id).toBe('/');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.name).toBe('CAST');
    expect(m.short_name).toBe('CAST');
    expect(m.launch_handler?.client_mode).toBe('focus-existing');
  });

  test('icons 192 and 512 (any) and 512 maskable, with the sizes they claim; the apple-touch-icon is 180', () => {
    const want = [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']];
    for (const [sizes, purpose] of want) {
      const icon = m.icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any') === purpose);
      expect(icon).toBeDefined();
      const [w, h] = pngSize(join(PUB, icon!.src));
      expect(`${w}x${h}`).toBe(sizes);
    }
    expect(pngSize(join(PUB, 'apple-touch-icon.png'))).toEqual([180, 180]);
  });

  test('shortcuts are root-relative paths of this origin', () => {
    expect(m.shortcuts?.map((s) => s.url)).toEqual(['/?panel=inbox', '/?settings=notifications', '/?settings=pair']);
    for (const s of m.shortcuts ?? []) {
      expect(s.url.startsWith('/') && !s.url.startsWith('//')).toBe(true);
      for (const i of s.icons ?? []) expect(existsSync(join(PUB, i.src))).toBe(true);
    }
  });

  test('listed screenshots exist with their sizes', () => {
    for (const s of m.screenshots ?? []) {
      const [w, h] = pngSize(join(PUB, s.src));
      expect(`${w}x${h}`).toBe(s.sizes);
    }
  });
});

test('index.html: the installed-app metas', () => {
  const html = readFileSync(resolve(import.meta.dir, '../../web/index.html'), 'utf8');
  expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
  expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />');
  expect(html).toContain('viewport-fit=cover');
  expect(html).toContain('<meta name="description" content="A little town where your AI cast lives and works." />');
  expect(html).toContain('<meta name="format-detection" content="telephone=no" />');
  // launch images for iOS (tests/repo/launch-images.test.ts checks them)
  expect(html).toContain('<link rel="apple-touch-startup-image" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/launch-dark-1206x2622.png" />');
  expect(html).toMatch(/@media \(display-mode: standalone\)\s*\{\s*:root\[data-theme='light'\] body::after/);
});
