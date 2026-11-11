// The private page (403) is the first thing CAST on a phone's Home Screen shows: it must carry the app's identity
// (manifest, icon, status-bar metas) so "Add to Home Screen" from it makes a real CAST app, and a form that pairs this
// app (its own cookies, no address bar) with a pasted link or a typed code — working with JavaScript off too.
import { describe, expect, test } from 'bun:test';
import { forbiddenPage, type DenyReason } from '../../server/pages';

const REASONS: DenyReason[] = ['no-token', 'bad-token', 'signed-out', 'rate-limited', 'not-allowed'];

describe('forbiddenPage', () => {
  for (const reason of REASONS) {
    test(`${reason}: the pairing form, install metas and the Home Screen note`, () => {
      const html = forbiddenPage(reason, { login: 'x@example.com', next: '/#/house/a"b<c' });
      expect(html).toContain('<form class="pair-form" method="post" action="/api/pair"');
      const input = /<input id="pair-code"[^>]*>/.exec(html)?.[0] ?? '';
      expect(input).toContain('name="token"');
      for (const attr of ['autocapitalize="off"', 'autocorrect="off"', 'spellcheck="false"', 'autocomplete="off"', 'required', 'maxlength="2048"']) expect(input).toContain(attr);
      expect(html).toContain('<label for="pair-code"');
      expect(html).toContain('<button type="submit"');
      // where pairing lands, escaped
      expect(html).toContain('name="next" value="/#/house/a&quot;b&lt;c"');
      expect(html).toContain('<input type="hidden" name="app" id="pair-app" value="">');
      // app identity for Add to Home Screen from this page
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">');
      expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
      expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
      expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
      expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">');
      expect(html).toContain('<meta name="apple-mobile-web-app-title" content="CAST">');
      expect(html).toContain('viewport-fit=cover');
      expect(html).toContain('env(safe-area-inset-top)');
      // the standalone note: CSS only, shown in the Home Screen app
      expect(html).toContain('class="pair-standalone"');
      expect(html).toMatch(/@media \(display-mode: standalone\)[^}]*\.pair-standalone[^}]*display: block/);
      expect(html).toContain('own sign-in');
      // nothing from another host
      expect((html.match(/https?:\/\/[^\s"'<)]+/g) ?? []).filter((u) => !u.startsWith('http://www.w3.org/'))).toEqual([]);
    });
  }

  test('the form comes before the steps, and the steps mention the typed code', () => {
    const html = forbiddenPage('no-token');
    expect(html.indexOf('pair-form')).toBeLessThan(html.indexOf('class="steps"'));
    expect(html).toContain('short code');
  });

  test('a failed try says so without echoing anything; next defaults to /', () => {
    const html = forbiddenPage('bad-token');
    expect(html).toContain('That link or code didn’t work');
    expect(html).toContain('older than 10 minutes');
    expect(html).toContain('name="next" value="/"');
  });

  test('works without JavaScript: the form is static markup, the script only marks the Home Screen app', () => {
    const html = forbiddenPage('no-token');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const js of scripts) expect(js).not.toContain('submit');
    expect(scripts.some((js) => js.includes('pair-app'))).toBe(true);
  });
});
