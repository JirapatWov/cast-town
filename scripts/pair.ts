// bun run pair [--data-dir <dir>] [--url <address>] [--no-qr]
//
// Prints this machine's CAST pairing link — the one way in for a new browser when no device is paired yet. The server
// never writes the token to its log (logs get pasted into issues); this command reads it from the token file when you
// ask, on the machine itself. With an address a phone can reach (--url, e.g. your `tailscale serve` https address, or a
// server listening beyond 127.0.0.1) it also draws a QR code to scan.
//
// Already have a paired device? Settings → Pair a phone makes a one-time link that expires instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEnvAliases, loadConfig, resolveDataDir } from '../server/config';
import { readListenInfo } from '../server/startup';
import { qrcodegen } from '../web/src/vendor/qrcodegen';

function usage(code: number): never {
  console.log(`Usage: bun run pair [--data-dir <dir>] [--url <address>] [--no-qr]

  --data-dir  CAST's data folder, when the server was started with CAST_DATA_DIR
  --url       the address your phone opens CAST with (e.g. https://my-pc.your-tailnet.ts.net:8443)
  --no-qr     print only the link`);
  process.exit(code);
}

/** A QR code drawn with half blocks: two modules per character cell, dark on a forced light background so it scans
 *  on dark and light terminals alike. */
export function terminalQr(text: string, border = 2): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.LOW);
  const size = qr.size;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && qr.getModule(x, y);
  const lines: string[] = [];
  for (let y = -border; y < size + border; y += 2) {
    let line = '';
    for (let x = -border; x < size + border; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      // ▀ paints the upper half in the foreground colour and the lower half in the background colour.
      line += `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}

function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch {
    return false;
  }
}

function main() {
  applyEnvAliases(process.env);
  const args = process.argv.slice(2);
  let base: string | undefined;
  let qr = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--no-qr') qr = false;
    else if (a === '--data-dir' && args[i + 1]) process.env.CAST_DATA_DIR = args[++i];
    else if (a === '--url' && args[i + 1]) base = args[++i];
    else usage(1);
  }

  const { dir } = resolveDataDir(process.env);
  const tokenFile = join(dir, 'token');
  if (!existsSync(tokenFile)) {
    console.error(`No pairing token in ${tokenFile}.\nStart CAST once (bun run start) — or, if it runs with CAST_DATA_DIR, pass the same folder: bun run pair --data-dir <dir>`);
    process.exit(1);
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!base) {
    base = readListenInfo(dir)?.url;
    if (!base) {
      try {
        const cfg = loadConfig(process.env);
        base = `http://${cfg.host}:${cfg.port}/`;
      } catch {
        base = 'http://127.0.0.1:4860/';
      }
    }
  }
  let link: string;
  try {
    const u = new URL(base);
    u.searchParams.set('token', token);
    link = u.toString();
  } catch {
    console.error(`Not an address: ${base}`);
    process.exit(1);
  }

  console.log(`\nCAST pairing link — treat it like a password: anyone who opens it can use CAST as you.\n\n  ${link}\n`);
  if (!qr || !process.stdout.isTTY) return; // piped: the link alone (no escape codes in a file)
  if (isLoopbackUrl(link)) {
    console.log(`That address only works on this computer, so there is no QR code for a phone.
To pair a phone: open CAST on this computer and use Settings → Pair a phone, or run
  bun run pair --url <the address your phone uses, e.g. your tailscale serve https address>\n`);
    return;
  }
  console.log(`${terminalQr(link)}\n\nScan it with the phone's camera. Don't send the link through chat apps (their previews open it).\n`);
}

if (import.meta.main) main();
