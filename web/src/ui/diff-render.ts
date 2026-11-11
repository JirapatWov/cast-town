// diff2html, in its own chunk (finding #70): only the diff overlay needs it, and most visits never open it.
// Its stylesheet stays a static import in diff-overlay.ts so the app's .d2h overrides keep winning the cascade.
export { html, parse } from 'diff2html';
export { ColorSchemeType } from 'diff2html/lib-esm/types';
