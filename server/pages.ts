// Small self-contained HTML pages the server renders itself: the friendly 403 and the "web app not built" placeholder.
// Styled in the product's "warm daylight glass" look so even the error states feel like CAST. These pages are shown
// before sign-in, so the mark and favicon are inline (most of web/public sits behind auth; only the install files —
// manifest, icons, iOS launch images, sw.js: server/pwa.ts — are public, so "Add to Home Screen" from the 403 page makes
// a real CAST app).
// The 403 page is also where CAST on a phone's Home Screen gets paired: that app has its own cookies and no address
// bar, so the page has a plain form (no JavaScript needed) to paste a pairing link or type a short code. No web fonts either: they
// sit behind auth too, and a page shown to strangers must not call a font CDN (it would leak every visitor's IP);
// Inter is used when installed, else the system UI font. A page only signed-in browsers see (the hub's "city is
// offline" page) asks for the app's own self-hosted fonts instead (`signedIn`).
import { APP_NAME, FAVICON_SVG, markSvg } from '../shared/brand';
import { LAUNCH_IMAGES, linkTags } from '../shared/launch-images';

/** On every HTML page CAST serves (the app shell, this file's pages): only CAST itself may frame it. Without them any
 *  site — and any AI-written page a person made — could frame a live, signed-in CAST (Tailscale's login header rides
 *  along on every tailnet request) and click through it. */
export const FRAME_GUARD_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};

/** Add FRAME_GUARD_HEADERS to a response when it is an HTML page (the auth deny page, the placeholder, the app). */
export function guardFraming(res: Response): Response {
  if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) return res;
  for (const [k, v] of Object.entries(FRAME_GUARD_HEADERS)) res.headers.set(k, v);
  return res;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const MARK_SVG = markSvg({ cls: 'mark' });

/** The light palette (#77): AA text on the light card, accents dark enough for 3:1. */
const LIGHT_VARS = `color-scheme: light;
    --text:#1F1B17; --muted:#4D463F; --lead:#2E2924; --faint:#5E564F; --code:#6E3D0C;
    --glass:rgba(251,250,248,.9); --line:rgba(45,35,25,.12); --fill:rgba(45,35,25,.05);
    --amber:#A35F00; --on-amber:#FFFFFF; --ok:#1B7D51; --ink:#1B1A18; --lamp:#E0932A;
    --btn:#1F1B17; --btn-text:#FBF9F6; --btn-line:rgba(45,35,25,.2); --shadow:rgba(60,45,30,.22);
    --bg:
      radial-gradient(900px 520px at 18% 8%, rgba(229,140,96,.22), transparent 62%),
      radial-gradient(800px 600px at 88% 100%, rgba(77,107,254,.12), transparent 60%),
      linear-gradient(180deg, #f7f3ed 0%, #efe9e0 100%);`;
/** Light when the OS asks (and CAST's Settings did not say Dark), or when CAST's Settings said Light. */
const LIGHT_RULE = `@media (prefers-color-scheme: light) { :root:not([data-theme='dark']) { ${LIGHT_VARS} } }
  :root[data-theme='light'] { ${LIGHT_VARS} }`;
/** A browser that picked Dark or Light in CAST's Settings (web/src/ui/theme.ts, same storage key) sees that here too. */
const THEME_SCRIPT = `<script>try{var t=localStorage.getItem('rlt.theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>`;

interface PageOpts {
  title: string;
  heading: string;
  lead: string; // HTML
  body?: string; // HTML
  footer?: string; // HTML
  refreshSeconds?: number;
  /** Shown only to signed-in browsers: load the app's self-hosted fonts (web/public/fonts, behind sign-in). */
  signedIn?: boolean;
  /** The page CAST on a Home Screen opens on (the 403): the app's identity for Add to Home Screen, the status bar
   *  under the page, and room for the notch and the home indicator. */
  app?: boolean;
  /** Extra CSS rules. */
  style?: string;
  /** HTML at the very end of <body> (a small inline script). */
  tail?: string;
}

/** Add to Home Screen from this page: the app's name, icon, manifest and iOS launch images (public files,
 *  server/pwa.ts; iOS reads the launch images when the app is added, so they must be here, not only in the app), the
 *  status bar over the page (iOS), the same bar colour as the app. */
const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="application-name" content="${APP_NAME}">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0e0d0c">
${linkTags(LAUNCH_IMAGES, '')}`;

/** The status bar's white text over the light page (black-translucent): a soft dark strip behind it. Zero high where
 *  iOS keeps the bar opaque (no top inset). */
const SCRIM = "content: ''; position: fixed; inset: 0 0 auto 0; height: env(safe-area-inset-top); background: linear-gradient(rgba(20,16,12,.55), rgba(20,16,12,0)); pointer-events: none; z-index: 10;";
const APP_STYLE = `body {
    padding: max(1.5rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right)) max(1.5rem, env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left));
  }
  @media (max-width: 480px) {
    body { padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
  }
  @media (display-mode: standalone) { :root[data-theme='light'] body::after { ${SCRIM} } }
  @media (display-mode: standalone) and (prefers-color-scheme: light) { :root:not([data-theme='dark']) body::after { ${SCRIM} } }`;

/** The app's own @font-face rules, served by this server from web/public/fonts. */
export const SELF_HOSTED_FONTS = '<link rel="preload" href="/fonts/inter-latin-var.woff2" as="font" type="font/woff2" crossorigin>\n<link rel="stylesheet" href="/fonts/fonts.css">';

export function renderPage(o: PageOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1${o.app ? ', viewport-fit=cover' : ''}">
<meta name="color-scheme" content="dark light">
${o.app ? APP_HEAD : ''}
${o.refreshSeconds ? `<meta http-equiv="refresh" content="${o.refreshSeconds}">` : ''}
<title>${escapeHtml(o.title)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
${o.signedIn ? SELF_HOSTED_FONTS : ''}
${THEME_SCRIPT}
<style>
  /* Dark by default; light when the device asks for it (prefers-color-scheme) or this browser chose Light in CAST's
     Settings (THEME_SCRIPT sets data-theme). Text sizes in rem so the browser's font-size setting applies (#55). */
  :root {
    color-scheme: dark;
    --text:#F4F1EC; --muted:#A8A29E; --lead:#D6D1CB; --faint:#918A85; --code:#F4E3D2;
    --glass:rgba(20,20,24,.72); --line:rgba(255,255,255,.08); --fill:rgba(255,255,255,.06);
    --amber:#F5A524; --on-amber:#1a1512; --ok:#3FB37F; --ink:#F4F1EC; --lamp:#F5C26B;
    --btn:#F4F1EC; --btn-text:#1B1A18; --btn-line:rgba(255,255,255,.14); --shadow:rgba(0,0,0,.6);
    --bg:
      radial-gradient(900px 520px at 18% 8%, rgba(229,140,96,.30), transparent 62%),
      radial-gradient(800px 600px at 88% 100%, rgba(77,107,254,.20), transparent 60%),
      radial-gradient(600px 400px at 70% 30%, rgba(245,165,36,.10), transparent 70%),
      linear-gradient(180deg, #23201f 0%, #16161a 55%, #121216 100%);
  }
  ${LIGHT_RULE}
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  html { height: 100%; }
  body { min-height: 100%; }
  body {
    font: 0.875rem/1.6 Inter, 'IBM Plex Sans Thai', system-ui, sans-serif; color: var(--text);
    background: var(--bg);
    display: grid; place-items: center; padding: 1.5rem;
  }
  .card {
    width: min(30rem, 100%); min-width: 0; padding: 2rem 2rem 1.5rem; border-radius: 0.875rem;
    background: var(--glass); border: 1px solid var(--line);
    backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%);
    box-shadow: 0 30px 80px -20px var(--shadow), 0 2px 0 rgba(255,255,255,.03) inset;
    animation: rise .22s ease-out both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (max-width: 480px) { body { padding: 1rem; } .card { padding: 1.5rem 1.25rem 1.125rem; } }
  .mark { width: 3.5rem; height: 3.5rem; display: block; margin-bottom: 1rem; }
  .mark path { stroke: var(--ink); }
  .mark circle { fill: var(--lamp); }
  h1 { font-size: 1.375rem; line-height: 1.3; font-weight: 600; margin: 0 0 0.5rem; letter-spacing: -.01em; }
  p { margin: 0 0 0.75rem; color: var(--muted); }
  p.lead { color: var(--lead); }
  b, strong { color: var(--text); font-weight: 500; }
  code { overflow-wrap: anywhere; }
  code, .code {
    font: 0.78125rem/1.5 'JetBrains Mono', ui-monospace, monospace; color: var(--code);
    background: var(--fill); border: 1px solid var(--line); border-radius: 0.375rem; padding: 1px 0.375rem;
  }
  .code { display: block; padding: 0.625rem 0.75rem; margin: 0.25rem 0 0.875rem; white-space: pre-wrap; word-break: break-all; }
  .steps { margin: 1rem 0 0.25rem; padding: 0; list-style: none; counter-reset: s; }
  .steps li { counter-increment: s; position: relative; padding-left: 1.875rem; margin-bottom: 0.625rem; color: var(--muted); }
  .steps li::before {
    content: counter(s); position: absolute; left: 0; top: 1px; width: 1.25rem; height: 1.25rem; border-radius: 50%;
    display: grid; place-items: center; font-size: 0.6875rem; font-weight: 600; color: var(--on-amber); background: var(--amber);
  }
  footer { margin-top: 1.25rem; padding-top: 0.875rem; border-top: 1px solid var(--line); font-size: 0.75rem; color: var(--faint); display: flex; gap: 0.5rem; align-items: center; }
  .dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  .dot.warn { background: var(--amber); box-shadow: 0 0 10px var(--amber); }
  ${o.app ? APP_STYLE : ''}
  ${o.style ?? ''}
</style>
</head>
<body>
  <main class="card">
    ${MARK_SVG}
    <h1>${escapeHtml(o.heading)}</h1>
    <p class="lead">${o.lead}</p>
    ${o.body ?? ''}
    ${o.footer ? `<footer>${o.footer}</footer>` : ''}
  </main>
${o.tail ?? ''}
</body>
</html>`;
}

export type DenyReason = 'not-allowed' | 'no-token' | 'bad-token' | 'signed-out' | 'rate-limited';

/** How someone gets a pairing link on this install: the token file (shown with ~ for the home folder) and the command
 *  that prints the link. Rendered from the real config — never a guessed path. */
export interface PairingHint {
  tokenFile: string;
  command: string;
  /** The CAST menu-bar app runs this server (the Mac app): its menu makes the links, there is no folder to run a
   *  command in. */
  menuBar?: boolean;
}

const DEFAULT_HINT: PairingHint = { tokenFile: 'token (in CAST’s data folder)', command: 'bun run pair' };

function pairingSteps(hint: PairingHint): string {
  const bunPair = hint.command.startsWith('bun ');
  const first = hint.menuBar
    ? `<li>On the Mac running ${APP_NAME}, click the ${APP_NAME} icon in the menu bar and choose <b>Open ${APP_NAME}</b> to sign in a browser on that Mac, or <b>Pair a phone…</b> for another device.</li>`
    : `<li>On the computer running ${APP_NAME}, open a terminal${bunPair ? ` in the ${APP_NAME} folder` : ''} and run:<span class="code">${escapeHtml(hint.command)}</span>${bunPair ? 'It prints a pairing link (and a QR code for a phone when CAST is reachable from one).' : 'It prints a pairing link for a browser on that computer.'} The secret itself is kept in <code>${escapeHtml(hint.tokenFile)}</code>.</li>`;
  return `<ol class="steps">
      ${first}
      <li>Or, on a device that is already paired: <b>Settings → Pair a phone</b> shows a one-time link, a QR code and a short code.</li>
      <li>Open the link on this device once, or paste it — or type the short code — in the field above. It stays paired until you sign it out.</li>
    </ol>
    <p>Treat a pairing link like a password: anyone who opens it can use ${APP_NAME} as you.</p>`;
}

/** The pairing form's look: a field and a button, big enough to tap, in the page's own colours. */
const FORM_STYLE = `.pair-form { margin: 1.125rem 0 0.5rem; padding: 0.875rem; border-radius: 0.625rem; background: var(--fill); border: 1px solid var(--line); }
  .pair-label { display: block; font-weight: 500; color: var(--text); margin-bottom: 0.5rem; }
  .pair-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .pair-row input {
    flex: 1 1 12rem; min-width: 0; height: 2.75rem; padding: 0 0.75rem; border-radius: 0.5rem; border: 1px solid var(--btn-line);
    background: var(--glass); color: var(--text); font: 1rem/1.2 'JetBrains Mono', ui-monospace, monospace;
  }
  .pair-row input::placeholder { color: var(--faint); font-family: Inter, system-ui, sans-serif; font-size: 0.875rem; }
  .pair-row button {
    flex: 0 0 auto; height: 2.75rem; padding: 0 1rem; border-radius: 0.5rem; border: 0; cursor: pointer;
    background: var(--btn); color: var(--btn-text); font: 600 0.9375rem/1 Inter, system-ui, sans-serif;
  }
  .pair-row input:focus-visible, .pair-row button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
  .pair-standalone { display: none; margin: 0 0 0.625rem; color: var(--lead); }
  @media (display-mode: standalone) { .pair-standalone { display: block; } }
  .is-app .pair-standalone { display: block; }`;

/** Marks the form as sent from CAST on a Home Screen (Settings → Devices then lists it apart from the phone's
 *  browser). The form works without it. */
const APP_SCRIPT = `<script>try{if((window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone){document.getElementById('pair-app').value='1';document.documentElement.classList.add('is-app')}}catch(e){}</script>`;

function pairForm(next: string): string {
  return `<form class="pair-form" method="post" action="/api/pair">
      <label for="pair-code" class="pair-label">Paste a pairing link or code</label>
      <p class="pair-standalone">This Home Screen app has its own sign-in, separate from Safari. In Safari open ${APP_NAME} → <b>Settings → Pair a phone</b> → <b>Copy a link for the app</b>, then paste it here — or type the code shown on your computer.</p>
      <div class="pair-row">
        <input id="pair-code" name="token" type="text" required maxlength="2048" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="A link, or a code like K7QF-3MXA-9PZD">
        <button type="submit">Pair this device</button>
      </div>
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <input type="hidden" name="app" id="pair-app" value="">
    </form>`;
}

export function forbiddenPage(reason: DenyReason, o: { login?: string; pairing?: PairingHint; next?: string } = {}): string {
  const footer = `<span class="dot warn"></span> ${APP_NAME} · private town`;
  const hint = o.pairing ?? DEFAULT_HINT;
  const form = pairForm(o.next ?? '/');
  const page = (heading: string, lead: string, body: string) =>
    renderPage({ title: `${APP_NAME} · Private`, heading, lead, body: form + body, footer, app: true, style: FORM_STYLE, tail: APP_SCRIPT });
  switch (reason) {
    case 'not-allowed':
      return page(
        'You’re not on the guest list',
        `You’re signed in to the tailnet as <b>${escapeHtml(o.login ?? 'unknown')}</b>, but this town only lets in the logins its owner listed.`,
        `<p>${APP_NAME} can run commands on this machine, so access is limited. If you should be here, ask the owner to add your login to <code>CAST_ALLOWED_USERS</code> — or pair this device:</p>${pairingSteps(hint)}`,
      );
    case 'bad-token':
      return page(
        'That link or code didn’t work',
        'It may be mistyped, already used, older than 10 minutes, or from before the pairing token was changed. Get a new one and try again.',
        pairingSteps(hint),
      );
    case 'signed-out':
      return page(
        'This device is signed out',
        `It was signed out of ${APP_NAME} (in Settings → Devices), or the server’s pairing was reset. Pair it again to come back in.`,
        pairingSteps(hint),
      );
    case 'rate-limited':
      return page(
        'Too many wrong pairing links',
        'This server saw too many wrong pairing links or codes from this device, so it turns wrong ones away for a while. A correct pairing link still works; typed codes work again in about 10 minutes.',
        `<p>Paste a current pairing link, or wait about 10 minutes before you type a code again.</p>${pairingSteps(hint)}`,
      );
    default:
      return page('This town is private', `${APP_NAME} can run commands on this machine, so it only opens for devices its owner paired. Pair this device to come in.`, pairingSteps(hint));
  }
}

export function placeholderPage(info: { version: string; port: number; compiled?: boolean; distDir?: string }): string {
  if (info.compiled) {
    // The single-file server (the Mac app's) has no checkout to build in: its web app ships next to it.
    return renderPage({
      title: APP_NAME,
      heading: 'The web app is missing',
      lead: `The ${APP_NAME} server is running, but the web app it serves isn’t where it looked.`,
      body: `<p>It looked in <code>${escapeHtml(info.distDir ?? 'web/dist')}</code>. Reinstall ${APP_NAME}, or point <code>CAST_WEB_DIST</code> at the folder that holds the web app’s <code>index.html</code>.</p>`,
      footer: `<span class="dot"></span> Server v${escapeHtml(info.version)} · port ${info.port}`,
      refreshSeconds: 15,
    });
  }
  return renderPage({
    title: APP_NAME,
    heading: 'The town is still being built',
    lead: 'The server is up and listening, but the web app hasn’t been built yet.',
    body: `<p>Build it once in the ${APP_NAME} folder and this page will turn into the town:</p>
      <span class="code">bun run build</span>
      <p>Working on the UI? Run the dev server instead — it proxies to this one:</p>
      <span class="code">bun run dev</span>`,
    footer: `<span class="dot"></span> Server v${escapeHtml(info.version)} · port ${info.port} · WebSocket ready at <code>/ws</code>`,
    refreshSeconds: 15,
  });
}
