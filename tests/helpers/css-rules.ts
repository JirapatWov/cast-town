// Reading the app's stylesheets in tests: the rules inside a given `@media (max-width: …)` block, for checks that a
// phone rule exists and wins over a generic one (no DOM, no browser).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CSS = resolve(import.meta.dir, '../../web/src/ui/css');

/** A stylesheet from web/src/ui/css without its comments. */
export const readCss = (file: string) => readFileSync(join(CSS, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The rules inside every `@media (max-width: <bp>)` block, as [selector, body] pairs. */
export function mediaRules(css: string, bp: string): [string, string][] {
  const out: [string, string][] = [];
  const re = new RegExp(`@media \\(max-width: ${bp.replace(/\./g, '\\.')}\\)\\s*\\{`, 'g');
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    for (const r of css.slice(start, i - 1).matchAll(/([^{}]+)\{([^}]*)\}/g)) out.push([r[1]!.trim(), r[2]!]);
  }
  return out;
}

/** Classes, attribute selectors and :not() of a selector: enough to compare two of the app's selectors. */
export const specificity = (sel: string) => (sel.match(/\.[\w-]+|:not\(|\[[^\]]+\]/g) ?? []).length;
