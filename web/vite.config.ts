import { build, defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import { inlineFontsHtml } from './inline-fonts.ts';

// `bun run dev` serves the app on :5173 and forwards the server's endpoints to the CAST server on this machine — the
// port it listens on (CAST_PORT, or the older RLT_PORT; default 4860). See CONTRIBUTING.md → "Dev mode".
const serverPort = process.env.CAST_PORT || process.env.RLT_PORT || '4860';

const PUBLIC = resolve(import.meta.dirname, 'public');
const DIST = resolve(import.meta.dirname, 'dist');

/** This build's id: the page and its service worker each know it, so an open page learns it is out of date
 *  (web/src/pwa/register.ts). CAST_BUILD_ID pins it (a reproducible Mac kit). */
const BUILD_ID = process.env.CAST_BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const DEFINE = { __CAST_BUILD__: JSON.stringify(BUILD_ID) };

/** web/dist/sw.js (web/sw/sw.ts): built on its own after the app, as one classic script — an IIFE with nothing to
 *  import. A chunk of the app's own build could import the shared runtime chunk, and `import` breaks a classic
 *  worker. The build fails if sw.js has an import or export, or lacks this build's id. Not in dev: the worker is only
 *  registered by a built app. */
function serviceWorker(): Plugin {
  return {
    name: 'cast-sw',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        define: DEFINE,
        build: {
          outDir: DIST,
          emptyOutDir: false,
          copyPublicDir: false,
          minify: true,
          target: 'es2020',
          lib: { entry: resolve(import.meta.dirname, 'sw/sw.ts'), formats: ['iife'], name: 'castSw', fileName: () => 'sw.js' },
        },
      });
      const js = readFileSync(resolve(DIST, 'sw.js'), 'utf8');
      try {
        new Script(js, { filename: 'sw.js' }); // parses as a classic script: no import or export statement
      } catch (err) {
        throw new Error(`web/dist/sw.js must be a classic script: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (/\bimport\s*\(/.test(js)) throw new Error('web/dist/sw.js must not import() anything');
      if (!js.includes(BUILD_ID)) throw new Error('web/dist/sw.js lacks this build’s id');
    },
  };
}

/** index.html links /fonts/fonts.css (works as is in dev); the page itself gets the rules inlined so the boot screen's
 *  first paint never waits on a second request. The woff2 files stay separate, cached, fetched on use. 'post': after
 *  Vite's own rewrite for base './' (inline-fonts.ts). */
function inlineFonts(): Plugin {
  return {
    name: 'cast-inline-fonts',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => inlineFontsHtml(html, readFileSync(resolve(PUBLIC, 'fonts/fonts.css'), 'utf8')),
    },
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  // Relative: the built index.html loads ./assets/index-<hash>.js, so the same build works at / (the hub's own city)
  // and at /city/<id>/ (another machine's CAST seen through a hub, which then runs its own server's bundle).
  // Release files from web/public (/assets/hdri/…, models, textures, /fonts) stay root-relative in the code: whichever
  // server owns the origin serves them, and they are identical across cities of one version (one shared browser cache).
  base: './',
  publicDir: PUBLIC,
  plugins: [inlineFonts(), serviceWorker()],
  define: DEFINE,
  build: {
    outDir: DIST,
    emptyOutDir: true,
    // three's core alone is ~720 KB minified (it does not tree-shake much); anything bigger than that is a mistake
    chunkSizeWarningLimit: 800,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Libraries in chunks of their own: they change far less often than CAST, so an update re-downloads only the
        // app chunk, and the browser fetches them in parallel (index.html preloads every static chunk). Only libraries
        // the first screen needs go here; lazily loaded ones (xterm, highlight.js, diff2html, the interior's loaders)
        // stay in their own dynamic chunks.
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/, priority: 2 },
            { name: 'postfx', test: /node_modules[\\/](postprocessing|n8ao)[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/term': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/api': `http://127.0.0.1:${serverPort}`,
      '/city': { target: `http://127.0.0.1:${serverPort}`, ws: true }, // other machines' CAST, through the hub (built apps)
    },
  },
});
