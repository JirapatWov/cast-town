// #49: the house's files are one visible click away everywhere a house is shown — the 3D action bar (Files) and,
// since the Town board is a first-class view, each board card too (not only the ⋯ menu or the Changes tab).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, '../../web/src/ui');
const src = (f: string) => readFileSync(join(UI, f), 'utf8');

describe('Files entry points (#49)', () => {
  test('the 3D action bar has Files', () => {
    expect(src('actionbar.ts')).toMatch(/action\('Files', 'folder', \(\) => openFolder\(shell, viewerFolder\(shell, project\.id\)\)\)/);
  });
  test('every Town board card has a Files button that opens the house folder', () => {
    const fv = src('focus-view.ts');
    expect(fv).toMatch(/onclick: \(\) => openFolder\(shell, viewerFolder\(shell, p\.id\)\) \}, icon\('folder', 14\), 'Files'\)/);
    expect(fv).toContain("'aria-label': `Files in ${p.name}`");
  });
});
