// Download the selected Rocketbox avatars (FBX + the 6–7 TGA maps we use) into <cache>/raw/<name>/.
// Files are discovered through the GitHub contents API (texture prefixes don't follow the folder numbers),
// the listing is cached, and every file is size-checked and retried. Downloads are untrusted data: they are
// only parsed (FBX2glTF, TGA reader), never executed.
//   node tools/characters/fetch.mjs [cacheDir]      (default: $RLT_CHAR_CACHE or ./.cache/characters)
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const cache = path.resolve(process.argv[2] ?? process.env.RLT_CHAR_CACHE ?? '.cache/characters');
const { avatars } = JSON.parse(fs.readFileSync(path.join(here, 'avatars.json'), 'utf8'));
const API = 'https://api.github.com/repos/microsoft/Microsoft-Rocketbox/contents/Assets/Avatars/Adults';
const WANT = /_(body|head)_(color|normal|specular)\.tga$|_opacity_color\.tga$/;

async function listing(name, sub) {
  const file = path.join(cache, 'listings', `${name}_${sub}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${API}/${name}/${sub}`, { headers: { 'User-Agent': 'rlt-characters' } });
  if (!res.ok) throw new Error(`${name}/${sub}: GitHub API ${res.status} ${await res.text()}`);
  const json = await res.json();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

async function download(url, dest, size) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) return 'cached';
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'rlt-characters' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== size) throw new Error(`size ${buf.length} ≠ ${size}`);
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return 'ok';
    } catch (e) {
      if (attempt === 6) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const queue = [];
for (const a of avatars) {
  const dir = path.join(cache, 'raw', a.name);
  fs.mkdirSync(dir, { recursive: true });
  const exp = (await listing(a.name, 'Export')).filter((f) => f.name.endsWith('.fbx') && !/_facial\.fbx$/.test(f.name));
  const tex = (await listing(a.name, 'Textures')).filter((f) => WANT.test(f.name));
  // the opacity map (hair cards, lashes) is missing on a few short-haired avatars
  if (exp.length !== 1 || tex.length < 6) throw new Error(`${a.name}: expected 1 fbx + 6–7 maps, got ${exp.length} + ${tex.length}`);
  for (const f of [...exp, ...tex]) queue.push({ url: f.download_url, dest: path.join(dir, f.name), size: f.size });
}
let done = 0;
const worker = async () => {
  for (let job; (job = queue.shift()); ) {
    const r = await download(job.url, job.dest, job.size);
    done++;
    if (r !== 'cached') console.log(`[${done}] ${path.relative(cache, job.dest)}`);
  }
};
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`fetched ${avatars.length} avatars into ${path.join(cache, 'raw')}`);
