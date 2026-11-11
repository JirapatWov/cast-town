// Rocketbox → RLT avatar GLBs (offline, reproducible). For every avatar in avatars.json:
//   FBX2glTF (geometry + Bip01 skin) → bones renamed to the UE-mannequin names the UAL clips use (so the runtime
//   retarget and every controller that asks for 'hand_r' / 'Head' work unchanged) → body + head merged into ONE
//   primitive on a 2048×1024 atlas (1 draw call) → Phong specular turned into roughness → hair/lash cards as a
//   separate MASK material with colour bled under the alpha (no dark fringes) → a ~50 % LOD1 for Low quality →
//   WebP textures + meshopt geometry → web/public/assets/characters/rocketbox/<id>.glb, plus the runtime catalog
//   (web/src/people/avatars.ts) and MANIFEST.json entries.
//
//   node tools/characters/build.mjs [--cache DIR] [--tools DIR] [--only f03,m08] [--no-manifest]
//   (defaults: $RLT_CHAR_CACHE or ./.cache/characters; $RLT_CHAR_TOOLS or <cache>/../tools — see README.md)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTga } from './tga.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const poc = path.resolve(here, '../..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const cache = path.resolve(arg('cache', process.env.RLT_CHAR_CACHE ?? '.cache/characters'));
const toolsDir = path.resolve(arg('tools', process.env.RLT_CHAR_TOOLS ?? path.join(cache, '..', 'tools')));
const only = arg('only', '')?.split(',').filter(Boolean) ?? [];
const outDir = path.join(poc, 'web/public/assets/characters/rocketbox');

const req = createRequire(path.join(toolsDir, 'package.json'));
const imp = async (m) => import(pathToFileURL(req.resolve(m)).href);
const { NodeIO } = await imp('@gltf-transform/core');
const { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } = await imp('@gltf-transform/extensions');
const { joinPrimitives, meshopt, prune, simplifyPrimitive, weldPrimitive, getBounds } = await imp('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptSimplifier } = await imp('meshoptimizer');
const sharp = (await imp('sharp')).default;
const FBX2GLTF = path.join(path.dirname(req.resolve('fbx2gltf/package.json')), 'bin', process.platform === 'darwin' ? 'Darwin' : 'Linux', 'FBX2glTF');

const { avatars } = JSON.parse(fs.readFileSync(path.join(here, 'avatars.json'), 'utf8'));

// ── bone map: 3ds Max Biped (Rocketbox) → UE mannequin (Quaternius UAL) ─────────────────────────
const BONES = {
  'Bip01 Pelvis': 'pelvis', 'Bip01 Spine': 'spine_01', 'Bip01 Spine1': 'spine_02', 'Bip01 Spine2': 'spine_03',
  'Bip01 Neck': 'neck_01', 'Bip01 Head': 'Head',
};
for (const [S, s] of [['L', 'l'], ['R', 'r']]) {
  Object.assign(BONES, {
    [`Bip01 ${S} Clavicle`]: `clavicle_${s}`, [`Bip01 ${S} UpperArm`]: `upperarm_${s}`, [`Bip01 ${S} Forearm`]: `lowerarm_${s}`,
    [`Bip01 ${S} Hand`]: `hand_${s}`, [`Bip01 ${S} Thigh`]: `thigh_${s}`, [`Bip01 ${S} Calf`]: `calf_${s}`,
    [`Bip01 ${S} Foot`]: `foot_${s}`, [`Bip01 ${S} Toe0`]: `ball_${s}`,
  });
  ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
    BONES[`Bip01 ${S} Finger${i}`] = `${f}_01_${s}`;
    BONES[`Bip01 ${S} Finger${i}1`] = `${f}_02_${s}`;
    BONES[`Bip01 ${S} Finger${i}2`] = `${f}_03_${s}`;
  });
}

// ── textures ────────────────────────────────────────────────────────────────────────────────────
const TEX = 1024; // per body / head tile; atlas = 2·TEX × TEX
const rawImg = (t) => sharp(t.data, { raw: { width: t.width, height: t.height, channels: t.channels } });

function findMap(dir, suffix) {
  const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(suffix));
  return f ? path.join(dir, f) : null;
}

async function tile(file, { flipGreen = false } = {}) {
  const t = readTga(file);
  if (flipGreen) for (let i = 1; i < t.data.length; i += t.channels) t.data[i] = 255 - t.data[i];
  return rawImg(t).removeAlpha().resize(TEX, TEX, { kernel: 'lanczos3' }).raw().toBuffer();
}

async function atlas(left, right, channels, size = TEX) {
  return sharp({ create: { width: size * 2, height: size, channels, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: left, raw: { width: size, height: size, channels }, left: 0, top: 0 },
      { input: right, raw: { width: size, height: size, channels }, left: size, top: 0 },
    ]);
}

/** Phong specular (grey) → glTF metallicRoughness (G = roughness, B = metal 0), half resolution. */
async function roughnessTile(file) {
  const t = readTga(file);
  const half = TEX / 2;
  const grey = await rawImg(t).removeAlpha().greyscale().resize(half, half).raw().toBuffer();
  const out = Buffer.alloc(half * half * 3);
  for (let i = 0; i < grey.length; i++) {
    const s = grey[i] / 255;
    // matte cloth ≈ 0.9, skin ≈ 0.55–0.65, eyes/lips/shiny leather ≈ 0.3
    const r = Math.min(0.92, Math.max(0.3, 0.92 - 0.95 * Math.sqrt(s)));
    out[i * 3] = 255;
    out[i * 3 + 1] = Math.round(r * 255);
    out[i * 3 + 2] = 0;
  }
  return out;
}

/** Hair / lash cards: RGBA at TEX². Colour under (semi-)transparent texels is replaced by the colour of the nearest
 *  solid strands (push-pull fill), so mipmaps, filtering and the soft-edge pass never pull in the light/black matte
 *  the source has there (halos around ponytails, dark fringes). `exact` keeps that colour through WebP. */
async function hairTexture(file) {
  const t = readTga(file);
  const img = await rawImg(t).resize(TEX, TEX, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
  const n = TEX * TEX;
  const c = new Float32Array(n * 3);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const solid = img[i * 4 + 3] > 153 ? 1 : 0; // only strands above 60 % alpha donate colour
    w[i] = solid;
    for (let k = 0; k < 3; k++) c[i * 3 + k] = img[i * 4 + k] * solid;
  }
  const fill = pushPull(c, w, TEX);
  for (let i = 0; i < n; i++) {
    const a = img[i * 4 + 3] / 255;
    if (a > 0.6) continue;
    const keep = (a / 0.6) ** 2; // fade from the strand's own colour into the fill toward transparency
    for (let k = 0; k < 3; k++) {
      img[i * 4 + k] = Math.max(0, Math.min(255, Math.round(img[i * 4 + k] * keep + fill[i * 3 + k] * (1 - keep))));
    }
  }
  return sharp(img, { raw: { width: TEX, height: TEX, channels: 4 } }).webp({ quality: 88, alphaQuality: 90, effort: 6, exact: true }).toBuffer();
}

/** Push-pull hole filling (Gortler et al.): premultiplied colour `c` (n×3) with weights `w` in [0,1] on a
 *  power-of-two square; returns un-premultiplied colour everywhere, holes taking the nearest weighted colour. */
function pushPull(c, w, size) {
  const levels = [{ c, w, s: size }];
  while (levels[levels.length - 1].s > 1) {
    const { c: fc, w: fw, s } = levels[levels.length - 1];
    const h = s >> 1;
    const c2 = new Float32Array(h * h * 3);
    const w2 = new Float32Array(h * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        let sw = 0;
        const sc = [0, 0, 0];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const j = (y * 2 + dy) * s + x * 2 + dx;
          sw += fw[j];
          for (let k = 0; k < 3; k++) sc[k] += fc[j * 3 + k];
        }
        const o = y * h + x;
        const nw = Math.min(1, sw);
        w2[o] = nw;
        for (let k = 0; k < 3; k++) c2[o * 3 + k] = sw > 0 ? (sc[k] / sw) * nw : 0;
      }
    }
    levels.push({ c: c2, w: w2, s: h });
  }
  // pull: F_L = c_L + (1 - w_L) · upsample(F_L+1), bilinear
  let F = new Float32Array(3);
  const top = levels[levels.length - 1];
  for (let k = 0; k < 3; k++) F[k] = top.w[0] > 0 ? top.c[k] / top.w[0] : 0;
  for (let L = levels.length - 2; L >= 0; L--) {
    const { c: lc, w: lw, s } = levels[L];
    const ps = s >> 1;
    const out = new Float32Array(s * s * 3);
    for (let y = 0; y < s; y++) {
      const fy = Math.max(0, Math.min(ps - 1, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(ps - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < s; x++) {
        const fx = Math.max(0, Math.min(ps - 1, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(ps - 1, x0 + 1), tx = fx - x0;
        const o = y * s + x;
        const rest = 1 - lw[o];
        for (let k = 0; k < 3; k++) {
          const up =
            (F[(y0 * ps + x0) * 3 + k] * (1 - tx) + F[(y0 * ps + x1) * 3 + k] * tx) * (1 - ty) +
            (F[(y1 * ps + x0) * 3 + k] * (1 - tx) + F[(y1 * ps + x1) * 3 + k] * tx) * ty;
          out[o * 3 + k] = lc[o * 3 + k] + rest * up;
        }
      }
    }
    F = out;
  }
  return F;
}

// ── geometry ────────────────────────────────────────────────────────────────────────────────────
function fbxToGltf(fbx, work) {
  fs.mkdirSync(path.join(work, 'tmp'), { recursive: true });
  execFileSync(FBX2GLTF, ['-i', fbx, '-o', path.join(work, 'fbx'), '--fbx-temp-dir', path.join(work, 'tmp')], { stdio: 'pipe' });
  const dir = path.join(work, 'fbx_out');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'fbx.gltf'), 'utf8'));
  // textures are rebuilt from the TGAs below: drop FBX2glTF's (unresolved) texture references
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.emissiveTexture;
    delete m.occlusionTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  const resources = {};
  for (const b of json.buffers) resources[b.uri] = fs.readFileSync(path.join(dir, b.uri));
  return { json, resources };
}

function remapU(prim, offset) {
  const uv = prim.getAttribute('TEXCOORD_0');
  const a = uv.getArray().slice();
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    min = Math.min(min, a[i]); max = Math.max(max, a[i]);
    a[i] = offset + Math.min(1, Math.max(0, a[i])) * 0.5;
  }
  // a new accessor: the original may be shared with another primitive
  const acc = uv.clone().setArray(a);
  prim.setAttribute('TEXCOORD_0', acc);
  return [min, max];
}

function triCount(prim) {
  const idx = prim.getIndices();
  return (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
}

async function buildAvatar(a, io) {
  const raw = path.join(cache, 'raw', a.name);
  const work = path.join(cache, 'work', a.id);
  fs.rmSync(work, { recursive: true, force: true });
  const fbx = fs.readdirSync(raw).find((f) => f.endsWith('.fbx'));
  const { json, resources } = fbxToGltf(path.join(raw, fbx), work);
  const doc = await io.readJSON({ json, resources });
  const root = doc.getRoot();
  doc.createExtension(EXTTextureWebP).setRequired(true);

  // bones
  for (const n of root.listNodes()) {
    const name = n.getName();
    if (name === 'Bip01 Footsteps') { n.dispose(); continue; }
    if (BONES[name]) n.setName(BONES[name]);
  }
  for (const want of ['pelvis', 'Head', 'hand_r', 'foot_l', 'ball_l', 'middle_01_r']) {
    if (!root.listNodes().some((n) => n.getName() === want)) throw new Error(`${a.id}: bone ${want} missing after rename`);
  }

  // primitives by material
  const meshNode = root.listNodes().find((n) => n.getMesh() && n.getSkin());
  const mesh = meshNode.getMesh();
  const prims = mesh.listPrimitives();
  const byMat = (re) => prims.filter((p) => re.test(p.getMaterial()?.getName() ?? ''));
  const body = byMat(/_body$/), head = byMat(/_head$/), hair = byMat(/_opacity$/);
  if (body.length !== 1 || head.length !== 1 || body.length + head.length + hair.length !== prims.length) {
    throw new Error(`${a.id}: unexpected materials ${prims.map((p) => p.getMaterial()?.getName()).join(', ')}`);
  }
  for (const p of prims) {
    for (const sem of p.listSemantics()) if (sem === 'COLOR_0' || sem === 'TEXCOORD_1') p.setAttribute(sem, null);
  }

  // textures
  const mapsDir = raw;
  const flipGreen = true; // Rocketbox normals are 3ds Max / DirectX (Y−); glTF wants Y+
  const colorAtlas = await (await atlas(await tile(findMap(mapsDir, '_body_color.tga')), await tile(findMap(mapsDir, '_head_color.tga')), 3))
    .webp({ quality: 88, effort: 6 }).toBuffer();
  const normalAtlas = await (await atlas(
    await tile(findMap(mapsDir, '_body_normal.tga'), { flipGreen }), await tile(findMap(mapsDir, '_head_normal.tga'), { flipGreen }), 3,
  )).webp({ quality: 92, smartSubsample: true, effort: 6 }).toBuffer();
  const ormAtlas = await (await atlas(
    await roughnessTile(findMap(mapsDir, '_body_specular.tga')), await roughnessTile(findMap(mapsDir, '_head_specular.tga')), 3, TEX / 2,
  )).webp({ quality: 90, effort: 6 }).toBuffer();
  const tex = (name, buf) => doc.createTexture(name).setImage(buf).setMimeType('image/webp').setURI(`${name}.webp`);

  const skin = doc.createMaterial('rb-skin')
    .setBaseColorTexture(tex(`${a.id}_color`, colorAtlas))
    .setNormalTexture(tex(`${a.id}_normal`, normalAtlas))
    .setMetallicRoughnessTexture(tex(`${a.id}_orm`, ormAtlas))
    .setMetallicFactor(1).setRoughnessFactor(1);
  const uvBody = remapU(body[0], 0);
  const uvHead = remapU(head[0], 0.5);
  body[0].setMaterial(skin);
  head[0].setMaterial(skin);
  const joined = joinPrimitives([body[0], head[0]]);
  mesh.removePrimitive(body[0]);
  mesh.removePrimitive(head[0]);
  mesh.addPrimitive(joined);

  let hairMat = null;
  const opacityFile = findMap(mapsDir, '_opacity_color.tga');
  if (hair.length && opacityFile) {
    hairMat = doc.createMaterial('rb-hair')
      .setBaseColorTexture(tex(`${a.id}_hair`, await hairTexture(opacityFile)))
      .setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true)
      .setMetallicFactor(0).setRoughnessFactor(0.55);
    for (const p of hair) p.setMaterial(hairMat);
  } else {
    for (const p of hair) { mesh.removePrimitive(p); p.dispose(); }
  }
  meshNode.setName('body');
  mesh.setName(`${a.id}-lod0`);

  // LOD1: the skin primitive simplified to ~50 %. Hair cards stay only in LOD0's mesh (the runtime keeps them for
  // both LODs): a primitive shared by two skinned meshes gets dequantized with the wrong skin after meshopt.
  const lod = joined.clone();
  for (const sem of lod.listSemantics()) lod.setAttribute(sem, lod.getAttribute(sem).clone());
  lod.setIndices(lod.getIndices().clone());
  weldPrimitive(lod);
  simplifyPrimitive(lod, { simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.004, lockBorder: false });
  const lodMesh = doc.createMesh(`${a.id}-lod1`).addPrimitive(lod);
  const lodNode = doc.createNode('body_lod1').setMesh(lodMesh).setSkin(meshNode.getSkin())
    .setRotation(meshNode.getRotation()).setTranslation(meshNode.getTranslation()).setScale(meshNode.getScale());
  meshNode.getParentNode()?.addChild(lodNode) ?? root.listScenes()[0].addChild(lodNode);

  for (const m of root.listMaterials()) if (m !== skin && m !== hairMat) m.dispose();
  await doc.transform(prune());

  const bounds = getBounds(root.listScenes()[0]);
  const height = +(bounds.max[1] - bounds.min[1]).toFixed(3);
  const hairTris = hair.length && hairMat ? hair.reduce((s, p) => s + triCount(p), 0) : 0;
  const tris = [mesh.listPrimitives().reduce((s, p) => s + triCount(p), 0), triCount(lod) + hairTris];

  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14 }));
  const glb = await io.writeBinary(doc);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${a.id}.glb`);
  fs.writeFileSync(file, glb);
  const info = { ...a, file: `/assets/characters/rocketbox/${a.id}.glb`, height, tris, bytes: glb.length, hair: !!hairMat };
  console.log(`${a.id} ${a.name}: ${tris[0]} / ${tris[1]} tris, h ${height} m, ${(glb.length / 1048576).toFixed(2)} MB` +
    `, uv body [${uvBody.map((v) => v.toFixed(3))}] head [${uvHead.map((v) => v.toFixed(3))}]`);
  return info;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization]).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
});
const catalogFile = path.join(outDir, 'catalog.json');
const previous = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : [];
const built = new Map(previous.map((x) => [x.id, x]));
for (const a of avatars) {
  if (only.length && !only.includes(a.id)) continue;
  built.set(a.id, await buildAvatar(a, io));
}
const catalog = avatars.map((a) => built.get(a.id)).filter(Boolean);
fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 1) + '\n');
fs.copyFileSync(path.join(here, 'LICENSE-Rocketbox.txt'), path.join(outDir, 'LICENSE-Rocketbox.txt'));

// runtime catalog (people/appearance.ts picks from it deterministically)
const ts = `// GENERATED by tools/characters/build.mjs — do not edit. Microsoft Rocketbox avatars (MIT), see
// web/public/assets/characters/rocketbox/LICENSE-Rocketbox.txt.
export interface AvatarInfo {
  id: string;
  gender: 'm' | 'f';
  style: 'casual' | 'smart';
  label: string;
  file: string;
  /** Standing height (m) of the bind pose. */
  height: number;
  /** Triangles at LOD0 / LOD1. */
  tris: [number, number];
  hair: boolean;
}

export const AVATARS: AvatarInfo[] = [
${catalog.map((c) => `  { id: '${c.id}', gender: '${c.gender}', style: '${c.style}', label: ${JSON.stringify(c.label)}, file: '${c.file}', height: ${c.height}, tris: [${c.tris.join(', ')}], hair: ${c.hair} },`).join('\n')}
];
`;
fs.writeFileSync(path.join(poc, 'web/src/people/avatars.ts'), ts);

if (!process.argv.includes('--no-manifest')) {
  // additive: replace only our own entries (other builders write theirs into the same file)
  const mf = path.join(poc, 'web/public/assets/MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.assets = manifest.assets.filter((x) => !String(x.path).includes('/characters/rocketbox/'));
  const today = new Date().toISOString().slice(0, 10);
  for (const c of catalog) {
    manifest.assets.push({
      path: `web/public/assets/characters/rocketbox/${c.id}.glb`,
      size: c.bytes,
      source: `https://github.com/microsoft/Microsoft-Rocketbox/tree/master/Assets/Avatars/Adults/${c.name} (Export/*.fbx + Textures/*.tga)`,
      license: 'MIT — Microsoft Rocketbox (LICENSE-Rocketbox.txt next to the GLBs)',
      date: today,
      pipeline: 'tools/characters (FBX2glTF 0.9.7 → bones renamed to UE names → body+head atlas, spec→roughness, hair MASK → LOD1 50 % → WebP + meshopt)',
      note: `${c.label}; ${c.gender === 'f' ? 'female' : 'male'}, ${c.style}`,
      triangles: c.tris[0],
      trianglesLod1: c.tris[1],
      skinned: true,
      extensions: ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'],
    });
  }
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1) + '\n');
}
console.log(`wrote ${catalog.length} avatars to ${outDir}`);
