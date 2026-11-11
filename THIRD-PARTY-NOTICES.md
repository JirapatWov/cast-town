# Third-party notices

CAST's own code is MIT-licensed (see `LICENSE`). This repository also ships, or builds in, work by others under their
own licences. The list below names each one. Licence texts that must travel with the files sit next to them under
`web/public/assets/`. Every bundled asset file has an entry in `web/public/assets/MANIFEST.json`, with its exact
source URL, licence, download date and the processing applied.

Adding something? Add it here (and to `MANIFEST.json` for files under `web/public/assets/`) in the same pull request.
Only add assets under CC0, CC BY, MIT or a similarly permissive licence that allows redistribution in an open-source
repository, and keep any licence file the author ships.

## 3D models, animations, textures and skies (`web/public/assets/`)

### Attribution required (CC BY 4.0)

| Files | Work | Licence |
|---|---|---|
| `vehicles/khronos/CarConcept_meshopt.glb` | **"Car Concept"** by Eric Chadwick / Darmstadt Graphics Group GmbH (2024), from the [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets). Meshopt-compressed. The Khronos logo meshes are hidden in the app; Khronos logos are trademarks of The Khronos Group Inc. | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`LICENSE_CarConcept.md`) |
| `props-interior/khronos/GlamVelvetSofa.glb` | **"Glam Velvet Sofa"** by Eric Chadwick / Wayfair, LLC (2021), Khronos glTF Sample Assets | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`LICENSE_GlamVelvetSofa.md`) |

### MIT

| Files | Work | Licence |
|---|---|---|
| `characters/rocketbox/*.glb`, `catalog.json` | 16 avatars from [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox), converted by `tools/characters/` (bones renamed, textures re-encoded, LODs) | MIT, Copyright (c) 2020 Microsoft (`characters/rocketbox/LICENSE-Rocketbox.txt`) |
| `textures/trees/leaves_*.webp`, `far_atlas.webp`, `hedge_*.webp` | Leaf sprites from [EZ-Tree](https://github.com/dgreenheck/ez-tree) 1.1.0 by Daniel Greenheck, processed by `tools/city/build-tree-textures.mjs` | MIT, Copyright (c) 2024 Daniel Greenheck (`textures/trees/LICENSE-ez-tree.txt`) |

### Public domain (CC0 1.0)

No attribution is required. We credit the authors anyway.

| Files | Work |
|---|---|
| `characters/Superhero_*`, `characters/T_Superhero_*`, `characters/UBC_Hairstyles.glb` | **Universal Base Characters** by [Quaternius](https://quaternius.com) (the fallback body when an avatar fails to load); `characters/License_Standard.txt` |
| `animations/UAL1_resampled.glb`, `animations/UAL2_resampled.glb` | **Universal Animation Library 1 & 2** by [Quaternius](https://quaternius.com), resampled; `animations/License_UAL1.txt` |
| `hdri/*.hdr` | Skies from [Poly Haven](https://polyhaven.com): kloofendal_48d_partly_cloudy_puresky (day), kloppenheim_06_puresky (golden hour), qwantani_moonrise_puresky (night; Greg Zaal, Jarod Guest), lebombo (interior light) |
| `props-city/*.glb` | [Poly Haven](https://polyhaven.com) models: metal trash can, painted wooden bench, street lamp 01, utility box 01 |
| `props-interior/*.glb` (top level) | [Poly Haven](https://polyhaven.com) models: Television 01, classic laptop, desk lamp arm 01, dining chair 02, dining table, drawer cabinet, electric stove, metal office desk, modern arm chair 01, modern ceiling lamp 01, modern coffee table 01, modern wooden cabinet, potted plants 02 and 04, sofa 02, steel frame shelves 01, throw pillows 01, wall clock, wooden bookshelf worn |
| `props-interior/opt/*.glb` | Decimated, WebP-textured copies of some of the Poly Haven models above, plus ceramic vase 02 (James Ray Cock) and wicker basket 02 (Kuutti Siitonen) from Poly Haven, and "Sheen Chair" |
| `props-interior/khronos/SheenChair.glb` | **"Sheen Chair"** by Eric Chadwick / Wayfair, LLC (2020), Khronos glTF Sample Assets; `LICENSE_SheenChair.md` |
| `props-interior/kenney-furniture-kit/` | **Furniture Kit** by [Kenney](https://kenney.nl); `License.txt` |
| `vehicles/kenney-car-kit/` | **Car Kit** by [Kenney](https://kenney.nl) (parked cars); `License.txt` |
| `textures/asphalt_02`, `concrete_pavement`, `laminate_floor_02`, `marble_01`, `painted_plaster_wall`, `red_brick_03`, `textures/interior/*` | PBR textures from [Poly Haven](https://polyhaven.com) |
| `textures/acg_Grass004`, `acg_PavingStones150`, `acg_WoodFloor051` | PBR textures from [ambientCG](https://ambientcg.com) |
| `textures/trees/bark_*.webp` | Bark from [Poly Haven](https://polyhaven.com) (oak) and [TextureCan](https://www.texturecan.com) (birch, pine), as packaged with EZ-Tree |

The app icons and the CAST mark (`web/public/*.png`, `favicon.svg`, `shared/brand.ts`) are part of CAST and are
covered by its MIT licence.

#### Quaternius licence evidence

The Quaternius packs were downloaded on 2026-10-27. Checked again on 2026-11-10: each author page shows the asset
licence **Creative Commons Zero v1.0 Universal** ("Free to use in personal, educational and commercial projects.
(CC0 License)"). The licence file the author ships is bundled unchanged; its sha256 is recorded here, so a changed
file shows.

| Pack | Author page (checked 2026-11-10) | Bundled licence file | sha256 of that file |
|---|---|---|---|
| Universal Animation Library | <https://quaternius.itch.io/universal-animation-library> | `web/public/assets/animations/License_UAL1.txt` | `6d01f55c6e4c49a2c9963e147e561945ae2c83958c8ca667d90a6bffdbfac061` |
| Universal Animation Library 2 | <https://quaternius.itch.io/universal-animation-library-2> | none of its own: the pack's download page says CC0 and `License_UAL1.txt` covers both | n/a |
| Universal Base Characters | <https://quaternius.itch.io/universal-base-characters> | `web/public/assets/characters/License_Standard.txt` | `0f4beaf0fe360a7732e58bbe3dbf60a2422367fbea60cb9ea4add968f383268e` |

The Quaternius site's general licence page (<https://quaternius.com/license.html>) now shows the Quaternius Asset
License (QAL v1.0) for new releases. It forbids redistributing the assets themselves as a stand-alone asset pack, "in
original or modified form"; it allows shipping them inside a finished product. These packs' own pages say CC0, which has
no such limit. The files here are CC0 and are part of the app, but don't repackage them as a stand-alone asset pack.

## Ported code

| Where | Work | Licence |
|---|---|---|
| `web/src/city/trees/generator.ts`, `species.ts` | TypeScript port of the branching algorithm and presets of [EZ-Tree](https://github.com/dgreenheck/ez-tree) 1.1.0 by Daniel Greenheck | MIT, Copyright (c) 2024 Daniel Greenheck. Full notice in the header of `generator.ts` |
| `web/src/vendor/qrcodegen.ts` | [QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library) (TypeScript) by Project Nayuki, vendored for Settings → Pair a phone | MIT, Copyright (c) Project Nayuki. Licence text in the file header |

## npm packages built into the web app

`bun run build:web` bundles these into `web/dist/` and then runs `scripts/release/third-party-licenses.ts`, which writes
`web/dist/THIRD-PARTY-LICENSES.txt`: the full licence and notice text of every package below (found by following the
`dependencies` of `package.json` through `node_modules`), with the licence blocks of the two vendored pieces above.
The build fails if a package ships no licence file (a `license` field alone is not the text). The Mac kit and CAST.app carry `web/dist`, so
they carry the file too. The compiled server (`bun run build:server`) imports no npm package. Licence files are also in
`node_modules/<package>/` after `bun install`.

| Package | Version | Licence | Author |
|---|---|---|---|
| [three](https://threejs.org), incl. its `examples/jsm` add-ons (GLTFLoader, HDRLoader, CSS2DRenderer, SunLight, LightProbeGrid, RoundedBoxGeometry, meshopt decoder) | 0.186.1 | MIT | three.js authors (meshopt decoder: Arseny Kapoulkine, MIT) |
| [postprocessing](https://github.com/pmndrs/postprocessing) | 6.39.5 | Zlib | Raoul van Rüschen |
| [n8ao](https://github.com/N8python/n8ao) | 2.0.1 | ISC per its package.json; its LICENSE file is CC0 1.0 | N8python |
| [marked](https://marked.js.org) | 18.1.2 | MIT | Christopher Jeffrey and the MarkedJS contributors |
| [diff2html](https://diff2html.xyz) | 3.4.56 | MIT | Rodrigo Fernandes |
| ↳ [diff](https://github.com/kpdecker/jsdiff) (dependency of diff2html) | 8.0.4 | BSD-3-Clause | Kevin Decker |
| ↳ [@profoundlogic/hogan](https://github.com/profoundlogic/hogan.js) (dependency of diff2html) | 3.0.4 | Apache-2.0 | Twitter, Inc. and contributors |
| [highlight.js](https://highlightjs.org) | 11.11.1 | BSD-3-Clause | Ivan Sagalaev, Josh Goebel and contributors |
| [@xterm/xterm](https://xtermjs.org) | 6.0.0 | MIT | The xterm.js authors |
| @xterm/addon-fit, @xterm/addon-unicode11, @xterm/addon-web-links | 0.11.0, 0.9.0, 0.12.0 | MIT | The xterm.js authors |
| ↳ [nopt](https://github.com/isaacs/nopt) (dependency of @profoundlogic/hogan) | 1.0.10 | MIT | Isaac Z. Schlueter |
| ↳ [abbrev](https://github.com/isaacs/abbrev-js) (dependency of nopt) | 1.1.1 | ISC | Isaac Z. Schlueter |

Build and development tools that don't ship in the app: [Vite](https://vite.dev) (MIT), [TypeScript](https://www.typescriptlang.org)
(Apache-2.0) and type packages (`@types/*`, MIT).

## The compiled server

`bun run build:server` produces a single-file server with `bun build --compile`, which embeds the [Bun](https://bun.sh)
runtime: MIT, with JavaScriptCore (LGPL-2) and other statically linked libraries under their own licences, all listed in
[Bun's licence page](https://bun.com/docs/project/licensing). The server's own code imports no npm package.

## Fonts

The UI uses **Inter**, **IBM Plex Sans Thai** and **JetBrains Mono** under the
[SIL Open Font License 1.1](https://openfontlicense.org). They are self-hosted as woff2 web subsets in
`web/public/fonts/` (fetched once by `tools/fonts/fetch.mjs`; nothing is loaded from a font CDN at run time). The
copyright lines and the full licence text are in `web/public/fonts/OFL.txt`.

## cast-agent (a fork of omp)

CAST's agent, **cast-agent**, is in [`agent/`](agent/FORK.md). cast-agent is based on
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi) v18.13.2 by Mario Zechner, Can Bölük and Stencil Labs, MIT:

```
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.
```

It is a modified build, not an official omp release; `agent/FORK.md` lists every change to upstream's files. The full
licence is [`agent/LICENSE`](agent/LICENSE), and omp's own third-party notices (the Rust crates inside its native
addon, which `bun run build` downloads prebuilt from npm as `@oh-my-pi/pi-natives-<platform>`, and the JavaScript
packages bundled into it) are in [`agent/THIRD-PARTY-NOTICES.txt`](agent/THIRD-PARTY-NOTICES.txt).

The Mac kit and CAST.app carry a standalone cast-agent built from `agent/` (see the README, "Mac app").
`scripts/mac/build-kit.sh` always ships `agent/LICENSE` and `agent/THIRD-PARTY-NOTICES.txt` beside it as
`agent-LICENSE` and `agent-THIRD-PARTY-NOTICES.txt`, and `mac/build-dmg.sh` copies both into CAST.app's Resources.
