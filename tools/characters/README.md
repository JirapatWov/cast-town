# tools/characters: Rocketbox avatars for RLT

Offline pipeline that turns selected [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox)
avatars (MIT, see `LICENSE-Rocketbox.txt`) into the GLBs the people builder loads at runtime:

```
web/public/assets/characters/rocketbox/<id>.glb   one per avatar (≈0.7–1.3 MB)
web/public/assets/characters/rocketbox/catalog.json
web/public/assets/characters/rocketbox/LICENSE-Rocketbox.txt
web/src/people/avatars.ts                          GENERATED catalog (AVATARS) — do not edit by hand
web/public/assets/MANIFEST.json                    our entries (path contains /characters/rocketbox/) replaced
```

Nothing in here runs at app build time. The outputs are committed; rerun the pipeline only to change the
selection or the processing.

## Setup (once)

The tools live outside the repo, in any directory (the scripts load them with `createRequire`):

```sh
TOOLS=~/.cache/rlt-characters/tools
mkdir -p "$TOOLS" && cd "$TOOLS" && npm init -y >/dev/null
npm i fbx2gltf@0.9.7-p1 @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 \
      @gltf-transform/functions@4.5.1 meshoptimizer@1.3.0 sharp@0.35.5
```

## Run

```sh
CACHE=~/.cache/rlt-characters/cache
node tools/characters/fetch.mjs "$CACHE"                     # FBX + TGA maps of every avatar in avatars.json (≈1.3 GB of TGA)
node tools/characters/build.mjs --cache "$CACHE" --tools "$TOOLS"            # all avatars + catalog + MANIFEST
node tools/characters/build.mjs --cache "$CACHE" --tools "$TOOLS" --only f02,m08 --no-manifest   # iterate
```

`fetch.mjs` lists files through the GitHub contents API (the texture prefixes don't follow the folder numbers,
e.g. `Male_Adult_08` → `m014_*`), caches the listings in `<cache>/listings`, size-checks every download and
retries. Downloads are data only: parsed by FBX2glTF and `tga.mjs`, never executed.

## What `build.mjs` does per avatar

1. **FBX2glTF** → glTF with the 3ds Max Biped skin (`Bip01 …`). Textures from the FBX are dropped; the TGA maps
   are processed directly.
2. **Bones renamed to the UE mannequin names** the Universal Animation Library clips use (`pelvis`, `spine_01..03`,
   `neck_01`, `Head`, `clavicle_l`, `upperarm_l`, `hand_r`, `thigh_l`, `ball_r`, `index_01_l` …). `Bip01 Footsteps`
   is deleted. The runtime retargets UAL1/UAL2 clips onto this rig by name (`web/src/people/library.ts`).
3. **Body + head merged into one primitive** (`rb-skin`) on a 2048×1024 atlas: colour (WebP q88), normal
   (DirectX → GL green flip, WebP q92) and ORM at 1024×512 (roughness = clamp(0.92 − 0.95·√spec, 0.3, 0.92),
   metal 0). One draw call for the whole outfit.
4. **Hair / lash cards** (`rb-hair`, avatars that have an opacity map): MASK 0.5, double-sided, 1024² RGBA. The
   colour under transparent texels is filled by push-pull from the solid strands, and the WebP keeps it
   (`exact`), so mipmaps and the runtime's soft-edge pass never pick up the source's matte (pale halos).
5. **LOD1** (`body_lod1` node): the skin primitive simplified to ~50 % with meshoptimizer. The hair cards stay
   only in LOD0's mesh; the runtime keeps them for both LODs (a primitive shared by two skinned meshes is
   dequantized with the wrong skin after meshopt).
6. **Compression**: meshopt + quantization (position 14 bit, normal 10, UV 14), WebP textures.

Triangles: LOD0 6.7k–9.9k, LOD1 3.4k–5.8k (incl. hair). Heights from the bind pose: women 1.72–1.79 m, men
1.80–1.87 m (written into the catalog; the runtime keeps them).

## Changing the selection

Edit `avatars.json` (`id`, Rocketbox folder `name`, `gender`, `style` casual/smart, picker `label`), run
`fetch.mjs`, then `build.mjs`. `style` steers who gets which avatar (subagents prefer casual); ids are stable
keys stored in player prefs, so don't reuse an id for a different avatar.
