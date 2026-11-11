// The built-in viewer's files. GET|HEAD FILES_PATH/<key>/<path…> serves one file of a person's folder (the house
// folder, or its job's own copy — the same rule as get_git); files_key / list_files / find_files (dispatch.ts) mint
// keys and list the folder.
//
// Why a key in the path, matched before auth: every file response is CSP-sandboxed (an opaque origin), so the browser
// treats the page's own relative CSS/JS/image loads as cross-site and never sends CAST's SameSite cookie. The key is
// HMAC-signed with a secret derived from the pairing token (a new token ends every key), names one folder and expires
// after FILES_KEY_TTL_MS; relative URLs carry it along by themselves.
//
// Why the sandbox (without allow-same-origin): AI-written HTML/SVG runs with an opaque origin even when opened as a
// top-level tab. It can't read CAST's cookie or storage, the Origin-checked /ws, /term and upload POST refuse it
// (Origin "null"), and a CAST it frames is opaque too (and refused anyway by frame-ancestors 'self', static.ts).
//
// Why the egress allowlist (FILES_SANDBOX_CSP): a page can read the other files of its house (its key is in its own
// URL), so it must not be able to send them anywhere. It may load only from CAST itself ('self' — which Chromium still
// matches inside the opaque origin) and the known CDNs / read-only image hosts below; fetch, XHR, WebSocket, beacons,
// EventSource, forms, frames, images, fonts and scripts to any other host are refused by the browser. No allow-popups
// (a popup could go anywhere): PAGE_SHIM asks CAST's viewer to open other sites, after the user says yes. A page could
// still navigate ITSELF to another site with the data in the URL (CSP has no rule for that), so PAGE_SHIM never lets a
// page run as the top document or right under CAST: it first turns itself into a frame shell whose own frame-src
// 'self' blocks every navigation of the page inside it. The allowlist is not airtight in Chromium: <link rel=prerender>
// (any URL, also added by script or in a child frame), the DNS lookup + connect Chrome starts for a navigation before
// frame-src refuses it, and WebRTC in a frame the page makes all reach any host — README.md, "Web pages in the viewer".
//
// What is never served or listed: dot segments (.env, .git, .ssh, …, also when reached through a symlink), anything
// whose realpath leaves the folder, CAST's own data dir (except the job's own copy, which lives there) and any other
// folder that looks like one (city.json + token: a backup), omp's agent dir, secret-looking names (token, *.pem,
// id_rsa, …), and anything that isn't a regular file or folder.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { FILES_KEY_TTL_MS, FILES_PATH, MAX_FIND_FILES, MAX_LIST_FILES, type FileEntry, type FilesKey } from '../shared/protocol';
import type { CityStore, JobStore } from './contracts';
import { exec } from './exec';
import { isInside, log, UserError } from './util';

/** Hosts a page may load scripts, styles, fonts, images, media and data (fetch) from: public CDNs and read-only data
 *  hosts whose request logs only their operators see. Extend with RLT_VIEWER_HOSTS (comma or space separated, e.g.
 *  "https://cdn.example.com *.example.org http://127.0.0.1:5702"). */
export const VIEWER_CDN_HOSTS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://fastly.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdn.skypack.dev',
  'https://ga.jspm.io',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
  'https://ajax.googleapis.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://fonts.bunny.net',
  'https://rsms.me',
  'https://use.fontawesome.com',
  'https://stackpath.bootstrapcdn.com',
  'https://maxcdn.bootstrapcdn.com',
  'https://cdn.plot.ly',
  'https://d3js.org',
  'https://code.highcharts.com',
  'https://cdn.datatables.net',
  'https://aframe.io',
  'https://raw.githubusercontent.com',
];

/** Read-only image hosts (img-src only): stock photos, placeholders, avatars, map tiles. */
export const VIEWER_IMAGE_HOSTS: readonly string[] = [
  'https://images.unsplash.com',
  'https://plus.unsplash.com',
  'https://source.unsplash.com',
  'https://picsum.photos',
  'https://fastly.picsum.photos',
  'https://placehold.co',
  'https://via.placeholder.com',
  'https://dummyimage.com',
  'https://i.pravatar.cc',
  'https://randomuser.me',
  'https://ui-avatars.com',
  'https://api.dicebear.com',
  'https://upload.wikimedia.org',
  'https://tile.openstreetmap.org',
  'https://*.tile.openstreetmap.org',
  'https://*.basemaps.cartocdn.com',
];

/** A CSP host-source and nothing else ("*" alone, quotes, ";" or "," would widen or break the policy). */
const HOST_SOURCE = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::(?:\d{1,5}|\*))?$/i;

/** RLT_VIEWER_HOSTS, the valid entries (the rest are logged and ignored). */
export function viewerHostsFromEnv(raw = process.env.RLT_VIEWER_HOSTS ?? ''): string[] {
  const out: string[] = [];
  for (const h of raw.split(/[\s,]+/).filter(Boolean)) {
    if (HOST_SOURCE.test(h)) out.push(h);
    else log('files', `RLT_VIEWER_HOSTS: ignored "${h.slice(0, 80)}" (not a host like https://cdn.example.com)`);
  }
  return out;
}

const PAGE_SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-downloads';

/** The CSP of a file response: `sandbox` (opaque origin; scripts only for web pages) plus the egress allowlist. */
export function filesCsp(scripts: boolean, extraHosts: readonly string[] = []): string {
  const cdn = [...VIEWER_CDN_HOSTS, ...extraHosts].join(' ');
  return [
    scripts ? PAGE_SANDBOX : 'sandbox',
    "default-src 'none'",
    scripts ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${cdn}` : "script-src 'none'",
    `style-src 'self' 'unsafe-inline' ${cdn}`,
    `font-src 'self' data: ${cdn}`,
    `img-src 'self' data: blob: ${cdn} ${VIEWER_IMAGE_HOSTS.join(' ')}`,
    `media-src 'self' data: blob: ${cdn}`,
    `connect-src 'self' data: blob: ${cdn}`,
    "frame-src 'self' blob: data:", // also what keeps the page inside PAGE_SHIM's frame shell
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

const EXTRA_HOSTS = viewerHostsFromEnv();

/** Every file response, errors included (SVG: FILES_SVG_CSP). No allow-same-origin, allow-top-navigation*, allow-popups
 *  or allow-popups-to-escape-sandbox: the page stays an opaque origin, and stays put. */
export const FILES_SANDBOX_CSP = filesCsp(true, EXTRA_HOSTS);
/** SVG never runs scripts (in the viewer it is an <img> anyway; opened in a tab it would get no PAGE_SHIM). */
export const FILES_SVG_CSP = filesCsp(false, EXTRA_HOSTS);

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': FILES_SANDBOX_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', // the key must not leak to a CDN the page loads from
  'access-control-allow-origin': '*', // the page's own fetch('data.json') comes from an opaque origin; the key is the secret
  // camera & co., and the APIs whose requests the browser makes itself, outside CSP's reach (ads, attribution,
  // identity and passkey providers)
  'permissions-policy': [
    'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'display-capture=()', 'attribution-reporting=()',
    'browsing-topics=()', 'join-ad-interest-group=()', 'run-ad-auction=()', 'private-aggregation=()', 'shared-storage=()',
    'identity-credentials-get=()', 'publickey-credentials-get=()', 'publickey-credentials-create=()',
  ].join(', '),
  'x-dns-prefetch-control': 'off', // a looked-up host name is a message too
};

/** Served with their own type. Everything else is text/plain (TEXT_EXTS, or UTF-8 by sniffing) or a download. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/** Always text/plain, never their "real" type: markdown/CSV are rendered by the viewer itself, and XML must never be
 *  served as XML (an XHTML document in it would run scripts). */
const TEXT_EXTS = new Set([
  '.txt', '.text', '.md', '.markdown', '.mdx', '.csv', '.tsv', '.xml', '.xsl', '.xsd', '.rss', '.atom', '.plist',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.log', '.diff', '.patch', '.sql', '.graphql', '.gql',
  '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.lua', '.r', '.dart', '.scala', '.ex',
  '.exs', '.erl', '.hs', '.ml', '.clj', '.el', '.vim', '.tex', '.bib', '.rst', '.adoc', '.org', '.srt', '.vtt',
  '.lock', '.gitignore', '.dockerfile', '.makefile', '.scss', '.sass', '.less', '.styl', '.jsonl', '.ndjson', '.proto',
]);
const TEXT_PLAIN = 'text/plain; charset=utf-8';
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);

/** Names never listed or served, wherever they are (a CAST data folder or a backup of one holds `token`). */
const SECRET_NAME = /^(token|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|p12|pfx))$/i;

const SNIFF_BYTES = 8192;
const SHIM_HEAD_BYTES = 64 * 1024; // where the doctype is looked for; a larger page streams the rest after it
const WALK_MAX_DIRS = 20_000;
const WALK_MAX_MS = 4000;
const WALK_SLICE_MS = 20;
const GIT_TIMEOUT_MS = 10_000;

/** window.name of the frame PAGE_SHIM runs a page in (see PAGE_SHIM). */
export const PAGE_FRAME_NAME = 'cast-viewer-page';
/** The `cast` field of the messages a page's shell sends the viewer: { cast, t: 'open', url } (the page asks to open
 *  a link: another site, or a house page in a new tab) and { cast, t: 'blocked', host, directive } (CSP refused it). */
export const PAGE_MESSAGE_TAG = 'cast-viewer';

// PAGE_SHIM, readable. The first script of every HTML page served without Range (right after its doctype), so it runs
// before anything of the page. Two roles, by window.name:
//  • Not yet in its frame (top-level tab, or the viewer's iframe): turn the rest of the page into inert text (a
//    <plaintext> element: nothing of it runs here), become a full-size frame shell and load the same URL inside, named
//    PAGE_FRAME_NAME (window.stop() would do too, but Chromium then never paints the shell). This document
//    has the page's CSP, so its frame-src 'self' blocks every navigation the page makes (location=…, meta refresh,
//    links, form posts) to anywhere but CAST. The shell relays the page's messages to the viewer, or — when it is the
//    top document (Open in new tab) — asks itself (a bar like the viewer's, never confirm(): its OK button takes the
//    Enter or the click meant for the page) and logs blocked loads to the console.
//  • Inside the frame: the page. In-memory localStorage / sessionStorage / document.cookie (the opaque origin throws on
//    the real ones, which crashes most AI-made games and apps), WebRTC off (a STUN/TURN host is not covered by CSP),
//    links to other sites and window.open become an "open <url>?" message to the shell, CSP violations become
//    "blocked <host>" messages. Best effort past the shell: a frame the page makes (srcdoc, blob:, data:) runs its own
//    scripts without this shim, so WebRTC works there. Nothing here stops <link rel=prerender>: Chromium sends its
//    request the moment the element is in the document, before any observer could remove it.
const SHIM_JS = String.raw`(function () {
  'use strict';
  var W = window, D = document, NAME = '${PAGE_FRAME_NAME}', TAG = '${PAGE_MESSAGE_TAG}';
  var here = new URL(location.href);
  var m0 = /^(?:\/city\/[a-z0-9-]{1,32})?${FILES_PATH.replace(/\//g, '\\/')}\/[^/]+\//.exec(here.pathname); // a city through a hub: /city/<id>/api/files/…
  var HOUSE = m0 ? here.origin + m0[0] : null;
  var TOP = W.parent === W;
  var inHouse = function (u) { return !!HOUSE && u.indexOf(HOUSE) === 0; };
  var outward = function (u) { return /^(https?|mailto|tel):$/.test(u.protocol); };
  var hostOf = function (s) { try { var u = new URL(s); return u.host || u.protocol.slice(0, -1); } catch (_) { return ''; } };
  var post = function (m) { if (TOP) return false; m.cast = TAG; try { W.parent.postMessage(m, '*'); } catch (_) {} return true; };
  var seen = {}, sent = 0;
  var onViolation = function (send) {
    return function (e) {
      var host = hostOf(e.blockedURI || ''), dir = String(e.effectiveDirective || e.violatedDirective || '');
      if (!host || seen[host + dir] || ++sent > 40) return;
      seen[host + dir] = 1;
      send({ t: 'blocked', host: host, directive: dir });
    };
  };

  if (W.name !== NAME) {
    D.write('<plaintext hidden>'); // the rest of the page is plain text from here on: nothing of it runs in the shell
    var rest = D.getElementsByTagName('plaintext')[0];
    if (!rest) W.stop();
    var head = D.head || D.documentElement.appendChild(D.createElement('head'));
    var body = D.body || D.documentElement.appendChild(D.createElement('body'));
    D.addEventListener('DOMContentLoaded', function () { if (rest && rest.parentNode) rest.parentNode.removeChild(rest); });
    var vp = head.appendChild(D.createElement('meta'));
    vp.name = 'viewport';
    vp.content = 'width=device-width, initial-scale=1';
    head.appendChild(D.createElement('style')).textContent = 'html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
    try { D.title = decodeURIComponent(here.pathname.split('/').pop() || '') || 'Page'; } catch (_) {}
    var f = D.createElement('iframe');
    f.name = NAME;
    f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write; gamepad');
    f.src = location.href;
    body.insertBefore(f, body.firstChild);
    var relayed = 0;
    var relay = function (m) {
      if (m.t === 'blocked' && ++relayed > 60) return; // the page can post any number of these
      if (TOP) { if (m.t === 'blocked') console.warn('CAST blocked ' + m.host + ' (' + m.directive + '): pages may only load from known CDNs'); return; }
      m.cast = TAG;
      W.parent.postMessage(m, here.origin);
    };
    // Open in new tab: "Open <host>?" over the page, Open waking up ARM ms after it shows and after every press on the
    // bar before then (a burst of clicks meant for the page never lands on it). Text only: host and URL are the page's.
    var asking = null, ARM = 500;
    var ask = function (u) {
      if (asking) return;
      var armedAt = 0;
      var bar = D.createElement('div');
      bar.setAttribute('role', 'alertdialog');
      bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;box-sizing:border-box;width:min(560px,calc(100% - 24px));padding:12px 14px;border:1px solid #3a3640;border-radius:10px;background:rgba(22,20,24,.96);color:#c9c4cf;font:12.5px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px -12px rgba(0,0,0,.7)';
      var add = function (tag, css, text) { var e = bar.appendChild(D.createElement(tag)); e.style.cssText = css; if (text) e.textContent = text; return e; };
      add('strong', 'display:block;font-size:14px;color:#f2eff5;overflow-wrap:anywhere', 'Open ' + (u.host || u.protocol.slice(0, -1)) + '?');
      add('div', '', 'This page wants to take you to another site, with only what is in this link:');
      add('code', 'display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#8f8a96;font:11.5px/1.5 ui-monospace,monospace', u.href.slice(0, 2000)).title = u.href.slice(0, 2000);
      var row = add('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px');
      var btn = function (label, css) { var b = row.appendChild(D.createElement('button')); b.type = 'button'; b.textContent = label; b.style.cssText = 'height:30px;padding:0 12px;border-radius:8px;font:inherit;cursor:pointer;' + css; return b; };
      var no = btn('Cancel', 'border:1px solid #3a3640;background:transparent;color:#c9c4cf');
      var go = btn('Open', 'border:1px solid #e8b24a;background:#e8b24a;color:#1a1408;font-weight:600');
      var close = function () { if (bar.parentNode) bar.parentNode.removeChild(bar); asking = null; };
      var show = function () { var wait = armedAt - Date.now(); go.style.opacity = wait > 0 ? '.42' : ''; if (wait > 0) setTimeout(show, wait + 15); };
      var arm = function () { armedAt = Date.now() + ARM; show(); };
      bar.addEventListener('pointerdown', function () { if (Date.now() < armedAt) arm(); }, true);
      no.onclick = close;
      go.onclick = function () { if (Date.now() < armedAt) return arm(); close(); location.assign(u.href); };
      arm();
      asking = body.appendChild(bar);
    };
    D.addEventListener('securitypolicyviolation', onViolation(relay), true);
    if (TOP) f.addEventListener('load', function () { try { f.contentWindow.focus(); } catch (_) {} });
    W.addEventListener('message', function (e) {
      var m = e.data;
      if (e.source !== f.contentWindow || !m || typeof m !== 'object' || m.cast !== TAG) return;
      if (m.t === 'blocked' && typeof m.host === 'string') relay({ t: 'blocked', host: m.host.slice(0, 255), directive: String(m.directive || '').slice(0, 64) });
      else if (m.t === 'title' && TOP) D.title = String(m.title || '').slice(0, 300) || D.title;
      else if (m.t === 'open' && typeof m.url === 'string') {
        // Only right after a click or key press in the page itself: this shell is activated by those alone (a click
        // in CAST around it doesn't count), so a page can't pop a question or a tab on its own.
        var ua = navigator.userActivation;
        if (ua && !ua.isActive) return console.warn('CAST: this page tried to open ' + m.url.slice(0, 200) + ' without a click');
        if (!TOP) return relay({ t: 'open', url: m.url.slice(0, 4096) });
        var u;
        try { u = new URL(m.url); } catch (_) { return; }
        if (!outward(u)) return;
        if (inHouse(u.href)) return location.assign(u.href);
        ask(u);
      }
    });
    return;
  }

  var mk = function () {
    var m = new Map(), api = {
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
      key: function (i) { var a = Array.from(m.keys()); return i >= 0 && i < a.length ? a[i] : null; }
    };
    return new Proxy(api, {
      get: function (t, p) { if (p === 'length') return m.size; if (typeof p !== 'string' || p in t) return t[p]; return m.has(p) ? m.get(p) : undefined; },
      set: function (t, p, v) { if (typeof p === 'string' && !(p in t)) m.set(p, String(v)); return true; },
      deleteProperty: function (t, p) { m.delete(String(p)); return true; },
      has: function (t, p) { return p in t || m.has(String(p)); },
      ownKeys: function () { return Array.from(m.keys()); },
      getOwnPropertyDescriptor: function (t, p) { return m.has(String(p)) ? { value: m.get(String(p)), enumerable: true, configurable: true, writable: true } : undefined; }
    });
  };
  ['localStorage', 'sessionStorage'].forEach(function (n) { try { W[n].length; } catch (e) { try { Object.defineProperty(W, n, { value: mk(), configurable: true }); } catch (_) {} } });
  try { D.cookie; } catch (e) {
    var jar = {};
    try {
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        get: function () { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); },
        set: function (v) { var kv = String(v).split(';')[0], i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
      });
    } catch (_) {}
  }

  // (a frame the page makes is a cross-origin window to it: there is no fresh constructor to borrow from there)
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection'].forEach(function (k) {
    try { if (k in W) Object.defineProperty(W, k, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  });

  var onClick = function (e) {
    if (e.defaultPrevented || e.button !== (e.type === 'auxclick' ? 1 : 0)) return; // a primary click, or a middle one
    var path = e.composedPath ? e.composedPath() : [e.target], a = null, raw;
    for (var i = 0; i < path.length && !a; i++) {
      var n = path[i];
      if (n && (n.localName === 'a' || n.localName === 'area') && n.getAttribute && (n.hasAttribute('href') || n.hasAttribute('xlink:href'))) a = n;
    }
    if (!a) return;
    raw = typeof a.href === 'string' ? a.href : (a.href && a.href.baseVal) || a.getAttribute('xlink:href');
    var u;
    try { u = new URL(raw, a.baseURI); } catch (_) { return; }
    var target = (a.getAttribute('target') || '').toLowerCase();
    var newTab = e.type === 'auxclick' || e.ctrlKey || e.metaKey || e.shiftKey || (target !== '' && target !== '_self');
    if (inHouse(u.href)) {
      if (!newTab) return;
      e.preventDefault();
      if (target === '_top' || target === '_parent') location.assign(u.href);
      else post({ t: 'open', url: u.href });
    } else if (outward(u)) {
      e.preventDefault();
      post({ t: 'open', url: u.href });
    }
  };
  W.addEventListener('click', onClick);
  W.addEventListener('auxclick', onClick);
  W.open = function (url, target) {
    var u, t = String(target || '').toLowerCase();
    try { u = new URL(url === undefined || url === null || url === '' ? 'about:blank' : String(url), D.baseURI); } catch (_) { return null; }
    if (inHouse(u.href) && (t === '_self' || t === '_top' || t === '_parent')) location.assign(u.href);
    else if (outward(u)) post({ t: 'open', url: u.href });
    return null;
  };

  D.addEventListener('securitypolicyviolation', onViolation(post), true);
  var title = function () { post({ t: 'title', title: D.title }); };
  D.addEventListener('DOMContentLoaded', title);
  W.addEventListener('load', title);
})();`;

/** Prepended (after the doctype) to every HTML page served without Range. See SHIM_JS above. */
export const PAGE_SHIM = `<script>/* CAST viewer: this page runs isolated, in a frame. It may load only from known CDNs; storage lives in memory until reload. */${SHIM_JS}</script>`;
/** The old name: the shim began as the storage stand-ins only. */
export const STORAGE_SHIM = PAGE_SHIM;

export interface FileViewerOptions {
  dataDir: string;
  city: Pick<CityStore, 'project'>;
  jobs: Pick<JobStore, 'get'>;
  /** The pairing token: keys are signed with a secret derived from it. A function reads the current one, so a new
   *  token (Settings → New pairing token) ends every key at once, without a restart. */
  token: string | (() => string);
  /** omp's agent dir (sign-ins): never served even when a house contains it. Default: $PI_CODING_AGENT_DIR or ~/.omp/agent. */
  ompAgentDir?: string;
  now?: () => number;
}

export interface FilesListing {
  dir: string;
  entries: FileEntry[];
  truncated?: boolean;
}

export interface FilesFound {
  paths: string[];
  truncated?: boolean;
}

export interface FileViewer {
  /** FILES_PATH and everything under it. index.ts routes these here BEFORE auth: the key is the auth. */
  matches(url: URL): boolean;
  handle(req: Request, url: URL): Promise<Response>;
  /** files_key: a key for the folder a person of this job works in. Throws UserError for an unknown house or job. */
  mintKey(projectId: string, jobId?: string): FilesKey;
  /** list_files: one folder (dir '' = the root), folders first. Throws UserError. */
  list(projectId: string, jobId: string | undefined, dir: string): FilesListing;
  /** find_files: every visible file's path (git: tracked + untracked not ignored; else a capped walk). */
  find(projectId: string, jobId: string | undefined, query?: string): Promise<FilesFound>;
}

/** A person's folder, resolved. */
interface Folder {
  root: string; // as CAST stores it (Project.path / JobWorktree.path)
  real: string; // its realpath
  ownCopy: boolean; // a job's own copy (lives inside the data dir, which is otherwise off limits)
}

type Scope = 'h' | `j:${string}`;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function statOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Characters of `q` appear in `path` in order (case-insensitive; whitespace ignored). */
export function holdsInOrder(path: string, q: string): boolean {
  const p = path.toLowerCase();
  let at = 0;
  for (const ch of q.toLowerCase().replace(/\s+/g, '')) {
    const i = p.indexOf(ch, at);
    if (i < 0) return false;
    at = i + ch.length;
  }
  return true;
}

/** A relative path that never names a dot entry or a secret-looking file. */
function visiblePath(rel: string): boolean {
  const segs = rel.split('/');
  return segs.every((s) => s !== '' && !s.startsWith('.')) && !SECRET_NAME.test(segs.at(-1)!);
}

/** Valid UTF-8 text without NUL bytes (judged by its first bytes). */
function looksLikeText(file: string, size: number): boolean {
  if (size === 0) return true;
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    if (head.includes(0)) return false;
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: n < size }); // a cut multi-byte char at the end is fine
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// What may stand before the shim: a BOM, HTML whitespace, comments and the doctype \u2014 nothing that runs. A comment ends
// where the HTML tokenizer ends it (the first --> or --!>, or <!--> / <!--->): a looser match would let a script
// hidden between two comments run before the shim.
const BEFORE_SHIM = /^\uFEFF?[\t\n\f\r ]*(?:<!--(?:>|->|(?!-?>)(?:(?!--!?>)[\s\S])*--!?>)[\t\n\f\r ]*)*<!doctype[^>]*>/i;
const BEFORE_SHIM_LATIN1 = /^(?:\xEF\xBB\xBF)?[\t\n\f\r ]*(?:<!--(?:>|->|(?!-?>)(?:(?!--!?>)[\s\S])*--!?>)[\t\n\f\r ]*)*<!doctype[^>]*>/i;
const PAGE_SHIM_BYTES = new TextEncoder().encode(PAGE_SHIM);
/** In the ETag of a shimmed page: a new shim (or CSP) never revalidates to a page cached with the old one. */
const SHIM_TAG = createHash('sha256').update(PAGE_SHIM).update(FILES_SANDBOX_CSP).digest('base64url').slice(0, 8);

/** The HTML with PAGE_SHIM inserted right after its doctype (before it, the page would be in quirks mode). */
export function withStorageShim(html: string): string {
  const m = BEFORE_SHIM.exec(html);
  return m ? m[0] + PAGE_SHIM + html.slice(m[0].length) : PAGE_SHIM + html;
}

/** A page with PAGE_SHIM after its doctype: its own bytes untouched, the part after the first SHIM_HEAD_BYTES
 *  streamed (any size gets the shim). UTF-16 (a BOM beats the header's charset=utf-8 in browsers, and would turn the
 *  inserted ASCII into garbage \u2014 the page would run without it) is re-encoded as UTF-8 first. */
function shimmedPage(real: string, size: number, withBody: boolean): { length?: number; body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null } {
  const fd = openSync(real, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(Math.min(SHIM_HEAD_BYTES, size));
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
    const text = new TextDecoder(head[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(readFileSync(real)); // drops the BOM
    const body = new TextEncoder().encode(withStorageShim(text));
    return { length: body.byteLength, body: withBody ? body : null };
  }
  const m = BEFORE_SHIM_LATIN1.exec(head.toString('latin1'));
  const at = m ? m[0].length : 0;
  const first = new Uint8Array(head.length + PAGE_SHIM_BYTES.byteLength);
  first.set(head.subarray(0, at));
  first.set(PAGE_SHIM_BYTES, at);
  first.set(head.subarray(at), at + PAGE_SHIM_BYTES.byteLength);
  if (head.length >= size) return { length: first.byteLength, body: withBody ? first : null };
  if (!withBody) return { length: size + PAGE_SHIM_BYTES.byteLength, body: null };
  const rest = Bun.file(real).slice(head.length).stream().getReader();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first);
    },
    async pull(c) {
      const r = await rest.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      void rest.cancel(reason);
    },
  });
  return { body }; // streamed: no content-length (the file may still be growing)
}

function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createFileViewer(o: FileViewerOptions): FileViewer {
  const now = o.now ?? Date.now;
  const currentToken = typeof o.token === 'function' ? o.token : () => o.token as string;
  let signedWith = '';
  let secretKey = Buffer.alloc(0);
  /** The signing secret of the current pairing token (derived again only when the token changed). */
  const secret = (): Buffer => {
    const t = currentToken();
    if (t !== signedWith || !secretKey.length) {
      secretKey = createHmac('sha256', t).update('cast-files-v1').digest();
      signedWith = t;
    }
    return secretKey;
  };
  const realData = realpathOrNull(o.dataDir);
  const agentDir = o.ompAgentDir || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent');
  const realAgent = realpathOrNull(agentDir);

  const sign = (body: string) => createHmac('sha256', secret()).update(`files:${body}`).digest('base64url').slice(0, 22);

  // ───────── folders ─────────

  function scopeFor(projectId: string, jobId: string | undefined): { scope: Scope; root: string } {
    const project = o.city.project(projectId);
    if (!project) throw new UserError('That house no longer exists');
    if (jobId) {
      const job = o.jobs.get(projectId, jobId);
      if (!job) throw new UserError('That job no longer exists');
      if (job.worktree) return { scope: `j:${jobId}`, root: job.worktree.path };
    }
    return { scope: 'h', root: project.path };
  }

  /** The folder a key's scope names now; null when the house, job or its copy is gone (→ 404). */
  function folderOfScope(projectId: string, scope: string): Folder | null {
    const project = o.city.project(projectId);
    if (!project) return null;
    let root = project.path;
    let ownCopy = false;
    if (scope !== 'h') {
      if (!scope.startsWith('j:')) return null;
      const wt = o.jobs.get(projectId, scope.slice(2))?.worktree;
      if (!wt) return null;
      root = wt.path;
      ownCopy = true;
    }
    const real = realpathOrNull(root);
    return real ? { root, real, ownCopy } : null;
  }

  function folderFor(projectId: string, jobId: string | undefined): Folder {
    const { scope, root } = scopeFor(projectId, jobId);
    const real = realpathOrNull(root);
    if (!real) throw new UserError(`The folder ${root} is gone`);
    if (!statOrNull(real)?.isDirectory()) throw new UserError(`${root} is not a folder`);
    return { root, real, ownCopy: scope !== 'h' };
  }

  /** A realpath the viewer may show: inside the folder, no dot segment on the way (a symlink can't lead into .git),
   *  not CAST's data dir (unless this is the job's own copy, which lives there) and not omp's agent dir. */
  function allowed(f: Folder, real: string): boolean {
    if (!isInside(f.real, real)) return false;
    const rel = relative(f.real, real);
    if (rel && rel.split(sep).some((s) => s.startsWith('.'))) return false;
    if (realData && !f.ownCopy && isInside(realData, real)) return false;
    if (realAgent && isInside(realAgent, real)) return false;
    // another CAST data folder on the way (a backup of one, another server's): chats, sessions, its server.log
    for (let dir = real; ; dir = dirname(dir)) {
      if (isDataFolder(dir)) return false;
      if (dir === f.real || dir.length <= f.real.length) break;
    }
    return true;
  }

  // A folder holding city.json + token is a CAST data dir. Cached (a request, a listing and a find look at the same
  // few folders again and again); forgotten every minute.
  const dataFolders = new Map<string, boolean>();
  let dataFoldersAt = 0;
  function isDataFolder(dir: string): boolean {
    const t = now();
    if (t - dataFoldersAt > 60_000 || dataFolders.size > 20_000) {
      dataFolders.clear();
      dataFoldersAt = t;
    }
    let v = dataFolders.get(dir);
    if (v === undefined) {
      v = existsSync(join(dir, 'city.json')) && existsSync(join(dir, 'token'));
      dataFolders.set(dir, v);
    }
    return v;
  }

  // ───────── keys ─────────

  function mintKey(projectId: string, jobId?: string): FilesKey {
    const { scope, root } = scopeFor(projectId, jobId);
    const exp = Math.floor((now() + FILES_KEY_TTL_MS) / 1000);
    const body = b64url(JSON.stringify([projectId, scope, exp]));
    const key = `${body}.${sign(body)}`;
    return { key, base: `${FILES_PATH}/${key}/`, root, expiresAt: exp * 1000 };
  }

  /** The key's [projectId, scope] when it is ours and not expired. */
  function checkKey(key: string): { projectId: string; scope: string } | null {
    const dot = key.indexOf('.');
    if (dot <= 0 || key.length > 2048) return null;
    const body = key.slice(0, dot);
    const sig = Buffer.from(key.slice(dot + 1));
    const want = Buffer.from(sign(body));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
      if (!Array.isArray(v) || v.length !== 3) return null;
      const [projectId, scope, exp] = v as [unknown, unknown, unknown];
      if (typeof projectId !== 'string' || typeof scope !== 'string' || typeof exp !== 'number') return null;
      if (exp * 1000 <= now()) return null;
      return { projectId, scope };
    } catch {
      return null;
    }
  }

  // ───────── GET|HEAD FILES_PATH/<key>/<path…> ─────────

  function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
    return new Response(`${text}\n`, {
      status,
      headers: { ...SECURITY_HEADERS, 'content-type': TEXT_PLAIN, 'cache-control': 'no-store', ...extra },
    });
  }

  type Parsed = { segs: string[]; dirSlash: boolean } | { status: 400 | 403; error: string };

  /** The request path after the key, as decoded segments. URL parsing already folded `..` and `%2e%2e` (which makes
   *  the key segment wrong → 404); what is left must be plain names. */
  function parsePath(raw: string): Parsed {
    const segs: string[] = [];
    for (const part of raw.split('/')) {
      if (part === '') continue;
      let s: string;
      try {
        s = decodeURIComponent(part);
      } catch {
        return { status: 400, error: 'Bad path' };
      }
      if (s.includes('\0') || s.includes('/') || s.includes('\\') || s === '.' || s === '..') return { status: 400, error: 'Bad path' };
      if (s.startsWith('.')) return { status: 403, error: 'Hidden files are not shown' };
      segs.push(s);
    }
    return { segs, dirSlash: raw === '' || raw.endsWith('/') };
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    if (req.method === 'OPTIONS') {
      // A page's fetch with its own headers (Content-Type: application/json on a GET, X-Requested-With…) is preflighted
      // from its opaque origin. Any header is fine: this route reads nothing but the path, Range and If-None-Match.
      const asked = (req.headers.get('access-control-request-headers') ?? '').replace(/[^A-Za-z0-9_, -]/g, '').slice(0, 512).trim();
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': asked || 'Range', 'access-control-max-age': '600' },
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
    const rest = url.pathname.slice(FILES_PATH.length + 1);
    const slash = rest.indexOf('/');
    if (!url.pathname.startsWith(`${FILES_PATH}/`) || slash <= 0) return plain(404, 'Not found');
    const cap = checkKey(rest.slice(0, slash));
    if (!cap) return plain(404, 'Not found'); // a forged, expired or old-token key looks like nothing at all
    const folder = folderOfScope(cap.projectId, cap.scope);
    if (!folder) return plain(404, 'Not found');
    const parsed = parsePath(rest.slice(slash + 1));
    if ('status' in parsed) return plain(parsed.status, parsed.error);
    const { segs, dirSlash } = parsed;

    let real = realpathOrNull(join(folder.root, ...segs));
    if (!real) return plain(404, 'Not found');
    if (!allowed(folder, real)) return plain(403, 'Not shown here');
    let st = statOrNull(real);
    let name = segs.at(-1) ?? '';
    if (st?.isDirectory()) {
      // A folder: its index.html, like a static host — at the URL with the slash, so the page's relative links work.
      if (!dirSlash) return plain(308, 'Moved', { location: `${encodeURIComponent(name)}/` });
      real = realpathOrNull(join(real, 'index.html'));
      if (!real || !allowed(folder, real)) return plain(404, 'Not found');
      st = statOrNull(real);
      name = 'index.html';
    }
    if (!st?.isFile()) return plain(404, 'Not found');
    if (SECRET_NAME.test(name) || SECRET_NAME.test(real.split(sep).at(-1)!)) return plain(403, 'Not shown here');
    return sendFile(req, real, name, st);
  }

  function sendFile(req: Request, real: string, name: string, st: Stats): Response {
    const ext = extname(name).toLowerCase();
    let type = TYPES[ext];
    let disposition: string | undefined;
    if (!type) {
      if (TEXT_EXTS.has(ext) || looksLikeText(real, st.size)) type = TEXT_PLAIN;
      else {
        type = 'application/octet-stream';
        disposition = contentDisposition('attachment', name);
      }
    }
    // Range never comes with a navigation: a page always runs with its shim.
    const shim = HTML_EXTS.has(ext) && !req.headers.has('range');
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${shim ? `-${SHIM_TAG}-s` : ''}"`;
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      ...(ext === '.svg' ? { 'content-security-policy': FILES_SVG_CSP } : {}),
      'content-type': type,
      'cache-control': 'private, no-cache', // AI rewrites files all the time; a 304 is cheap
      etag,
      'last-modified': new Date(st.mtimeMs).toUTCString(),
      // the file's own size: a shimmed HTML page's content-length counts the injected storage shim too
      'x-file-size': String(st.size),
      ...(disposition ? { 'content-disposition': disposition } : {}),
    };
    const inm = req.headers.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
    const head = req.method === 'HEAD';
    if (shim) {
      let page: ReturnType<typeof shimmedPage>;
      try {
        page = shimmedPage(real, st.size, !head);
      } catch (err) {
        log('files', `could not read ${real}:`, err);
        return plain(404, 'Not found');
      }
      if (page.length !== undefined) headers['content-length'] = String(page.length);
      return new Response(page.body, { headers });
    }
    if (head) return new Response(null, { headers: { ...headers, 'content-length': String(st.size), 'accept-ranges': 'bytes' } });
    // Bun answers Range (206 / 416) for a Bun.file body by itself: video, audio and PDF seeking.
    return new Response(Bun.file(real), { headers: { ...headers, 'accept-ranges': 'bytes' } });
  }

  // ───────── list_files / find_files ─────────

  function toEntry(f: Folder, dirReal: string, d: Dirent): FileEntry | null {
    if (d.name.startsWith('.')) return null;
    const full = join(dirReal, d.name);
    let target = full;
    if (d.isSymbolicLink()) {
      const t = realpathOrNull(full);
      if (!t) return null;
      target = t;
    } else if (!d.isFile() && !d.isDirectory()) {
      return null; // sockets, fifos, devices
    }
    if (!allowed(f, target)) return null;
    const st = statOrNull(target);
    if (!st || (!st.isFile() && !st.isDirectory())) return null;
    if (st.isDirectory()) return { name: d.name, isDir: true, mtime: Math.floor(st.mtimeMs) };
    if (SECRET_NAME.test(d.name) || SECRET_NAME.test(target.split(sep).at(-1)!)) return null;
    return { name: d.name, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
  }

  function list(projectId: string, jobId: string | undefined, dir: string): FilesListing {
    const f = folderFor(projectId, jobId);
    const segs = dir.split('/').filter((s) => s !== '');
    if (segs.some((s) => s === '.' || s === '..' || s.includes('\0') || s.includes('\\'))) throw new UserError('That is not a folder of this house');
    if (segs.some((s) => s.startsWith('.'))) throw new UserError('Hidden folders are not shown');
    const real = realpathOrNull(join(f.root, ...segs));
    if (!real) throw new UserError('Folder not found');
    if (!allowed(f, real)) throw new UserError('That folder is not shown here');
    if (!statOrNull(real)?.isDirectory()) throw new UserError('Not a folder');
    let dirents: Dirent[];
    try {
      dirents = readdirSync(real, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new UserError(code === 'EACCES' || code === 'EPERM' ? 'Permission denied' : 'Could not read the folder');
    }
    const entries = dirents
      .map((d) => toEntry(f, real, d))
      .filter((e): e is FileEntry => e !== null)
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
    const out: FilesListing = { dir: segs.join('/'), entries: entries.slice(0, MAX_LIST_FILES) };
    if (entries.length > MAX_LIST_FILES) out.truncated = true;
    return out;
  }

  /** Relative prefixes inside the folder that are off limits (the data dir when a house contains it, omp's agent dir). */
  function hiddenPrefixes(f: Folder): string[] {
    const out: string[] = [];
    for (const d of [f.ownCopy ? null : realData, realAgent]) {
      if (!d) continue;
      if (d !== f.real && isInside(f.real, d)) out.push(relative(f.real, d).split(sep).join('/') + '/');
      else if (isInside(d, f.real)) out.push(''); // the whole folder
    }
    return out;
  }

  async function gitFiles(f: Folder): Promise<string[] | null> {
    try {
      const r = await exec(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: f.real, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 32 * 1024 * 1024 });
      if (r.code !== 0 || r.timedOut) return null;
      const paths = r.stdout.split('\0').filter((p) => p !== '');
      return paths.length ? paths : null; // nothing listed (the folder is git-ignored by an outer repo?): walk it instead
    } catch {
      return null;
    }
  }

  /** A symlinked file the route would serve: its target is allowed, a regular file, and not secret-looking. */
  function linkOk(f: Folder, full: string): boolean {
    const t = realpathOrNull(full);
    return !!t && allowed(f, t) && !!statOrNull(t)?.isFile() && !SECRET_NAME.test(t.split(sep).at(-1)!);
  }

  /** Every file under the folder, skipping dot folders and node_modules; bounded in folders read and time. Reads are
   *  synchronous, so it gives the event loop a turn every WALK_SLICE_MS (a big folder would freeze the whole town —
   *  every chat, approval and terminal — for the length of the walk). */
  async function walk(f: Folder, keep: (rel: string) => boolean, max: number): Promise<{ paths: string[]; truncated: boolean }> {
    const paths: string[] = [];
    const stack = [''];
    const deadline = now() + WALK_MAX_MS;
    let dirs = 0;
    let truncated = false;
    let slice = performance.now();
    while (stack.length) {
      if (++dirs > WALK_MAX_DIRS || now() > deadline) {
        truncated = true;
        break;
      }
      if (performance.now() - slice > WALK_SLICE_MS) {
        await new Promise<void>((r) => setTimeout(r, 0));
        slice = performance.now();
      }
      const rel = stack.pop()!;
      let dirents: Dirent[];
      try {
        dirents = readdirSync(join(f.real, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)); // popped in name order
      for (const d of dirents) {
        if (d.name.startsWith('.') || d.name === 'node_modules') continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const full = join(f.real, childRel);
        if (d.isDirectory()) {
          if (allowed(f, full)) stack.push(childRel);
        } else if (d.isFile() || d.isSymbolicLink()) {
          if (d.isSymbolicLink() ? !linkOk(f, full) : !allowed(f, full)) continue;
          if (!keep(childRel)) continue;
          paths.push(childRel);
          if (paths.length > max) {
            truncated = true;
            stack.length = 0;
            break;
          }
        }
      }
    }
    return { paths, truncated };
  }

  async function find(projectId: string, jobId: string | undefined, query?: string): Promise<FilesFound> {
    const f = folderFor(projectId, jobId);
    const hidden = hiddenPrefixes(f);
    if (hidden.includes('')) return { paths: [] };
    const q = query?.trim() ?? '';
    const keep = (rel: string) => visiblePath(rel) && !hidden.some((h) => rel.startsWith(h)) && (!q || holdsInOrder(rel, q));
    const fromGit = await gitFiles(f);
    let paths: string[];
    let truncated = false;
    if (fromGit) {
      // git lists symlinks as files: keep one only where the route would serve it.
      paths = [];
      for (const rel of fromGit) {
        if (!keep(rel)) continue;
        const full = join(f.real, rel);
        if (!allowed(f, full)) continue;
        let link: boolean;
        try {
          link = lstatSync(full).isSymbolicLink();
        } catch {
          continue; // deleted but still tracked
        }
        if (link && !linkOk(f, full)) continue;
        paths.push(rel);
        if (paths.length > MAX_FIND_FILES) break; // → truncated below
      }
    } else {
      const w = await walk(f, keep, MAX_FIND_FILES);
      paths = w.paths;
      truncated = w.truncated;
    }
    paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (paths.length > MAX_FIND_FILES) {
      paths = paths.slice(0, MAX_FIND_FILES);
      truncated = true;
    }
    return truncated ? { paths, truncated } : { paths };
  }

  return {
    matches: (url) => url.pathname === FILES_PATH || url.pathname.startsWith(`${FILES_PATH}/`),
    handle,
    mintKey,
    list,
    find,
  };
}
