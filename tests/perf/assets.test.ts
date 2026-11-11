// #21: the first visit loads slimmed files — every URL the client can ask for exists, phones get their smaller copies,
// and MANIFEST.json still describes every shipped asset.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PbrSet } from '../../web/src/core/types';
import { pbrFiles, sizedUrl } from '../../web/src/engine/assets';
import { SKY_DEFS, skyUrl } from '../../web/src/engine/sky';

const ROOT = join(import.meta.dir, '../..');
const PUBLIC = join(ROOT, 'web/public');
const onDisk = (url: string) => existsSync(join(PUBLIC, url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const SETS: PbrSet[] = ['asphalt', 'concrete', 'paving', 'grass', 'brick', 'plaster', 'woodfloor', 'laminate', 'marble'];

describe('photo textures', () => {
  test('sizedUrl picks the 512 copy only on capped devices, never for tree sprites', () => {
    const u = '/assets/textures/interior/caban/caban_arm_1k.webp';
    expect(sizedUrl(u, Infinity)).toBe(u);
    expect(sizedUrl(u, 1024)).toBe(u);
    expect(sizedUrl(u, 512)).toBe('/assets/textures/interior/caban/512/caban_arm_1k.webp');
    expect(sizedUrl('/assets/textures/asphalt_02/asphalt_02_diff_1k.webp', 512)).toBe('/assets/textures/asphalt_02/512/asphalt_02_diff_1k.webp');
    expect(sizedUrl('/assets/textures/trees/leaves_oak.webp', 512)).toBe('/assets/textures/trees/leaves_oak.webp');
    expect(sizedUrl('/assets/textures/asphalt_02/512/asphalt_02_diff_1k.webp', 512)).toBe('/assets/textures/asphalt_02/512/asphalt_02_diff_1k.webp');
    expect(sizedUrl('/assets/characters/T_Superhero_Male_Ligh_1k.webp', 512)).toBe('/assets/characters/T_Superhero_Male_Ligh_1k.webp');
  });

  test('every PBR map exists at full size and as the phone copy', () => {
    for (const set of SETS) {
      for (const file of Object.values(pbrFiles(set))) {
        const url = `/assets/textures/${file}`;
        expect(onDisk(url)).toBe(true);
        expect(onDisk(sizedUrl(url, 512))).toBe(true);
      }
    }
  });

  test('every texture a phone may ask for has its 512 copy, and no photo JPG is left', () => {
    const files = walk(join(PUBLIC, 'assets/textures')).map((f) => `/${relative(PUBLIC, f).split('\\').join('/')}`);
    expect(files.filter((f) => /\.jpe?g$/i.test(f))).toEqual([]);
    for (const f of files.filter((f) => f.endsWith('.webp') && !f.includes('/512/'))) expect(onDisk(sizedUrl(f, 512))).toBe(true);
  });
});

describe('skies', () => {
  test('desktop loads the 2k sky, phones its 1k copy; both exist', () => {
    for (const def of Object.values(SKY_DEFS)) {
      expect(skyUrl(def, false)).toBe(def.hdr);
      expect(skyUrl(def, true)).toMatch(/_1k\.hdr$/);
      expect(onDisk(skyUrl(def, false))).toBe(true);
      expect(onDisk(skyUrl(def, true))).toBe(true);
    }
  });
});

describe('MANIFEST.json', () => {
  test('lists every shipped asset with its current size', () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC, 'assets/MANIFEST.json'), 'utf8')) as { assets: { path: string; size: number }[] };
    const listed = new Map(manifest.assets.map((a) => [a.path, a.size]));
    const files = walk(join(PUBLIC, 'assets'))
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .filter((f) => !f.endsWith('MANIFEST.json'));
    const missing = files.filter((f) => !listed.has(f));
    expect(missing).toEqual([]);
    const stale = files.filter((f) => listed.get(f) !== statSync(join(ROOT, f)).size);
    expect(stale).toEqual([]);
    const ghosts = [...listed.keys()].filter((p) => !existsSync(join(ROOT, p)));
    expect(ghosts).toEqual([]);
  });
});
