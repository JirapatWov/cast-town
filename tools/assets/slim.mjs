// Asset diet for the first visit (finding #21): re-encodes what the browser downloads into smaller files that look
// the same at the sizes CAST shows them, and records every step in web/public/assets/MANIFEST.json.
//   node tools/assets/slim.mjs --tools DIR [--only textures,glb,hdr,clips] [--dry]
// DIR holds a node_modules with @gltf-transform/{core,extensions,functions} 4.x, meshoptimizer and sharp
// (`npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer sharp` in a scratch
// folder — they are build tools, not app dependencies). Each step is idempotent: a file already converted is skipped.
//
//   textures  photo PBR sets (1k JPG, quality ~95) → WebP at the same size (q80 colour/data, q86 normals), plus a
//             512 px copy of every PBR and interior texture in a `512/` folder beside it that phones load instead
//             of shrinking 1k art after downloading it (engine/assets.ts → sizedUrl)
//   glb       the city props, the car and the interior props: embedded textures → WebP, capped per model (a bin seen
//             from the street needs 512 px, not six 1k JPGs); geometry, names and materials are untouched
//   hdr       a 1k copy of each 2k sky (2×2 box filter, RGBE) that phones load instead of halving 2k in the browser
//   clips     the animation libraries keep only the clips the app plays (web/src/people/library.ts CLIPS); the full
//             packs stay in git history (see their MANIFEST entries)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const ASSETS = path.join(root, 'web/public/assets');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const DRY = process.argv.includes('--dry');
const only = new Set((arg('only', 'textures,glb,hdr,clips') ?? '').split(',').filter(Boolean));
const toolsDir = path.resolve(arg('tools', process.env.CAST_ASSET_TOOLS ?? '.cache/asset-tools'));
const req = createRequire(path.join(toolsDir, 'package.json'));
const imp = async (m) => import(pathToFileURL(req.resolve(m)).href);
const TODAY = new Date().toISOString().slice(0, 10);

// ── manifest ─────────────────────────────────────────────────────────────────────────────────────
const MANIFEST = path.join(ASSETS, 'MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
const entryOf = (abs) => manifest.assets.find((a) => a.path === rel(abs));
/** Record a re-encoded file: `from` (old path, may equal `to`) now lives at `to` after `step`. */
function record(from, to, step) {
  const e = entryOf(from);
  if (!e) throw new Error(`no MANIFEST entry for ${rel(from)}`);
  e.path = rel(to);
  e.size = fs.statSync(to).size;
  e.pipeline = `${e.pipeline} → ${step} (tools/assets/slim.mjs)`;
  e.date = TODAY;
}
/** Record a new file derived from `parent` (same source and licence). */
function derive(parent, to, step, note) {
  const p = entryOf(parent);
  if (!p) throw new Error(`no MANIFEST entry for ${rel(parent)}`);
  const existing = entryOf(to);
  const e = existing ?? { ...p };
  for (const k of ['triangles', 'skinned', 'joints', 'clips', 'extensions', 'bboxM']) delete e[k];
  Object.assign(e, { path: rel(to), size: fs.statSync(to).size, note, date: TODAY, pipeline: `${rel(parent)} → ${step} (tools/assets/slim.mjs)` });
  if (!existing) manifest.assets.push(e);
}
function saveManifest() {
  manifest.assets.sort((a, b) => a.path.localeCompare(b.path));
  manifest.fileCount = manifest.assets.length;
  manifest.totalBytes = manifest.assets.reduce((n, a) => n + (a.size ?? 0), 0);
  manifest.generated = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
let before = 0;
let after = 0;
const log = (file, a, b, what) => {
  before += a;
  after += b;
  console.log(`${what.padEnd(9)} ${kb(a).padStart(8)} → ${kb(b).padStart(8)}  ${rel(file)}`);
};

// ── textures ─────────────────────────────────────────────────────────────────────────────────────
const isNormal = (f) => /nor(mal)?(_gl|GL)?/i.test(path.basename(f));
const webpQuality = (f) => (isNormal(f) ? 86 : 80);
/** Texture folders whose files get a 512 px phone copy (trees are sprite atlases already sized for the job). */
const SIZED_DIRS = /^textures\/(?!trees\/)/;

async function textures() {
  const sharp = (await imp('sharp')).default;
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) {
        if (f.name !== '512') walk(p);
      } else files.push(p);
    }
  };
  walk(path.join(ASSETS, 'textures'));
  for (const f of files.filter((f) => /\.jpe?g$/i.test(f))) {
    const out = f.replace(/\.jpe?g$/i, '.webp');
    const a = fs.statSync(f).size;
    if (DRY) continue;
    await sharp(f).webp({ quality: webpQuality(f), effort: 6 }).toFile(out);
    fs.rmSync(f);
    record(f, out, `WebP q${webpQuality(f)}`);
    log(out, a, fs.statSync(out).size, 'webp');
  }
  // phone copies of every photo texture (re-walk: the conversion above renamed files)
  files.length = 0;
  walk(path.join(ASSETS, 'textures'));
  for (const f of files.filter((f) => /\.webp$/i.test(f) && SIZED_DIRS.test(path.relative(ASSETS, f).split(path.sep).join('/')))) {
    const out = path.join(path.dirname(f), '512', path.basename(f));
    if (fs.existsSync(out) || DRY) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const meta = await sharp(f).metadata();
    const scale = Math.min(1, 512 / Math.max(meta.width ?? 512, meta.height ?? 512));
    await sharp(f)
      .resize(Math.round((meta.width ?? 512) * scale), Math.round((meta.height ?? 512) * scale), { kernel: 'lanczos3' })
      .webp({ quality: webpQuality(f), effort: 6 })
      .toFile(out);
    derive(f, out, `512 px (lanczos3), WebP q${webpQuality(f)}`, 'phone copy (engine/assets.ts loads it when the texture cap is 512)');
    log(out, fs.statSync(f).size, fs.statSync(out).size, '512');
  }
}

// ── glb ──────────────────────────────────────────────────────────────────────────────────────────
/** model → longest texture side. Normal maps keep more quality than colour (blocky normals read as dents). */
const GLB = {
  'props-city/street_lamp_01_1k.glb': 1024,
  'props-city/painted_wooden_bench_1k.glb': 1024,
  'props-city/metal_trash_can_1k.glb': 512,
  'props-city/utility_box_01_1k.glb': 512,
  'vehicles/khronos/CarConcept_meshopt.glb': 1024,
  'props-interior/modern_arm_chair_01_1k.glb': 1024,
  'props-interior/potted_plant_04_1k.glb': 1024,
  'props-interior/dining_table_1k.glb': 1024,
  'props-interior/wall_clock_1k.glb': 512,
  'props-interior/modern_coffee_table_01_1k.glb': 1024,
  'props-interior/throw_pillows_01_1k.glb': 1024,
  'props-interior/modern_ceiling_lamp_01_1k.glb': 512,
  'props-interior/khronos/GlamVelvetSofa.glb': 1024,
};

async function glbs() {
  const { NodeIO } = await imp('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await imp('@gltf-transform/extensions');
  const { textureCompress } = await imp('@gltf-transform/functions');
  const { MeshoptDecoder, MeshoptEncoder } = await imp('meshoptimizer');
  const sharp = (await imp('sharp')).default;
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  for (const [file, cap] of Object.entries(GLB)) {
    const abs = path.join(ASSETS, file);
    const doc = await io.read(abs);
    const pending = doc.getRoot().listTextures().filter((t) => t.getMimeType() !== 'image/webp');
    if (!pending.length || DRY) continue;
    const a = fs.statSync(abs).size;
    const common = { encoder: sharp, targetFormat: 'webp', resize: [cap, cap], effort: 90 };
    await doc.transform(
      textureCompress({ ...common, slots: /^normalTexture$/, quality: 86 }),
      textureCompress({ ...common, slots: /^(?!normalTexture$).*/, quality: 80 }),
    );
    await io.write(abs, doc);
    record(abs, abs, `textures → WebP (≤${cap} px, q80 / normals q86)`);
    log(abs, a, fs.statSync(abs).size, 'glb');
  }
}

// ── hdr ──────────────────────────────────────────────────────────────────────────────────────────
const SKIES = ['kloofendal_48d_partly_cloudy_puresky_2k', 'kloppenheim_06_puresky_2k', 'qwantani_moonrise_puresky_2k'];

/** Radiance RGBE (.hdr) → { width, height, data: Float32Array RGB }. Handles flat and new-style RLE scanlines. */
function readHdr(buf) {
  let pos = 0;
  const line = () => {
    const s = pos;
    while (buf[pos] !== 0x0a) pos++;
    return buf.toString('latin1', s, pos++);
  };
  if (!line().startsWith('#?')) throw new Error('not a Radiance file');
  const header = [];
  for (let l = line(); l !== ''; l = line()) header.push(l);
  const res = /^-Y (\d+) \+X (\d+)$/.exec(line());
  if (!res) throw new Error('unsupported orientation');
  const height = +res[1];
  const width = +res[2];
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        for (let x = 0; x < width; ) {
          let n = buf[pos++];
          if (n > 128) {
            n -= 128;
            const v = buf[pos++];
            while (n--) scan[x++ * 4 + c] = v;
          } else while (n--) scan[x++ * 4 + c] = buf[pos++];
        }
      }
    } else {
      scan.set(buf.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    rgbe.set(scan, y * width * 4);
  }
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3];
    const f = e ? Math.pow(2, e - 136) : 0;
    data[i * 3] = rgbe[i * 4] * f;
    data[i * 3 + 1] = rgbe[i * 4 + 1] * f;
    data[i * 3 + 2] = rgbe[i * 4 + 2] * f;
  }
  return { width, height, data, header };
}

/** { width, height, data RGB float } → Radiance file with new-style RLE scanlines. */
function writeHdr({ width, height, data }) {
  const out = [Buffer.from(`#?RADIANCE\n# 2x2 box-filtered by CAST tools/assets/slim.mjs\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1')];
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const m = Math.max(data[i], data[i + 1], data[i + 2]);
      if (m < 1e-32) {
        scan.fill(0, x * 4, x * 4 + 4);
        continue;
      }
      const e = Math.ceil(Math.log2(m) + 1e-9);
      const f = 256 / Math.pow(2, e);
      scan[x * 4] = Math.min(255, Math.floor(data[i] * f));
      scan[x * 4 + 1] = Math.min(255, Math.floor(data[i + 1] * f));
      scan[x * 4 + 2] = Math.min(255, Math.floor(data[i + 2] * f));
      scan[x * 4 + 3] = e + 128;
    }
    const rle = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 127 && scan[(x + run) * 4 + c] === scan[x * 4 + c]) run++;
        if (run >= 3) {
          rle.push(128 + run, scan[x * 4 + c]);
          x += run;
          continue;
        }
        let n = 0;
        const start = x;
        while (x < width && n < 128) {
          let r = 1;
          while (x + r < width && r < 3 && scan[(x + r) * 4 + c] === scan[x * 4 + c]) r++;
          if (r >= 3) break;
          x++;
          n++;
        }
        rle.push(n);
        for (let k = start; k < start + n; k++) rle.push(scan[k * 4 + c]);
      }
    }
    out.push(Buffer.from(rle));
  }
  return Buffer.concat(out);
}

function halve(img) {
  const { width: W, height: H, data: src } = img;
  const w = W >> 1;
  const h = H >> 1;
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (2 * y * W + 2 * x) * 3;
      const b = a + W * 3;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = (src[a + c] + src[a + 3 + c] + src[b + c] + src[b + 3 + c]) * 0.25;
    }
  }
  return { width: w, height: h, data };
}

async function hdrs() {
  for (const name of SKIES) {
    const src = path.join(ASSETS, 'hdri', `${name}.hdr`);
    const out = path.join(ASSETS, 'hdri', `${name.replace(/_2k$/, '_1k')}.hdr`);
    if (fs.existsSync(out) || DRY) continue;
    const img = readHdr(fs.readFileSync(src));
    fs.writeFileSync(out, writeHdr(halve(img)));
    derive(src, out, '2×2 box filter to 1k (RGBE)', 'phone copy of the 2k sky (engine/sky.ts)');
    log(out, fs.statSync(src).size, fs.statSync(out).size, 'hdr 1k');
  }
}

// ── clips ────────────────────────────────────────────────────────────────────────────────────────
async function clips() {
  const lib = fs.readFileSync(path.join(root, 'web/src/people/library.ts'), 'utf8');
  const block = /export const CLIPS = \[([\s\S]*?)\] as const/.exec(lib)?.[1];
  if (!block) throw new Error('CLIPS not found in web/src/people/library.ts');
  const keep = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const { NodeIO } = await imp('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await imp('@gltf-transform/extensions');
  const { prune } = await imp('@gltf-transform/functions');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  for (const file of ['animations/UAL1_resampled.glb', 'animations/UAL2_resampled.glb']) {
    const abs = path.join(ASSETS, file);
    const doc = await io.read(abs);
    const drop = doc.getRoot().listAnimations().filter((a) => !keep.has(a.getName()));
    if (!drop.length || DRY) continue;
    const a = fs.statSync(abs).size;
    const kept = doc.getRoot().listAnimations().filter((x) => keep.has(x.getName())).map((x) => x.getName());
    for (const anim of drop) {
      // samplers hold the keyframe accessors: dispose them too, or prune sees the accessors as still in use
      for (const c of anim.listChannels()) c.dispose();
      for (const s of anim.listSamplers()) s.dispose();
      anim.dispose();
    }
    // the dropped clips' samplers and keyframe accessors go; every node stays (the mannequin's rig is the
    // retarget source, and keepLeaves keeps bones and sockets that nothing else references)
    await doc.transform(prune({ keepLeaves: true, keepAttributes: true, keepIndices: true, keepSolidTextures: true }));
    await io.write(abs, doc);
    record(abs, abs, `kept only the clips the app plays (${kept.length}: CLIPS in web/src/people/library.ts); full pack in git history`);
    const e = entryOf(abs);
    if (e?.clips) e.clips = e.clips.filter((c) => keep.has(c.replace(/\(.*$/, '')));
    log(abs, a, fs.statSync(abs).size, 'clips');
  }
}

if (only.has('textures')) await textures();
if (only.has('glb')) await glbs();
if (only.has('hdr')) await hdrs();
if (only.has('clips')) await clips();
if (!DRY) saveManifest();
console.log(`total ${kb(before)} → ${kb(after)}`);
