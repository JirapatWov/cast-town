// People studio harness (fast to render headless): a lit floor + wall and a row of characters, each playing a
// clip frozen at ?t= (or animating). Checks avatars, retargeted poses, hair edges, props, LODs.
// ?avatars=all|f03,m08|ubc  ?clips=Idle_Loop,Walk_Loop  ?t=0.6 (freeze, seconds)  ?mannequin (UAL reference row)
// ?quality=low  ?prop=phone|mug|can  ?az=0&el=6&dist=6&ty=1  ?yaw=0.3  ?sp=0.85 (spacing)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { Quality } from '../src/core/types';
import { Animator } from '../src/people/animator';
import { lookForAgent, lookForAvatar } from '../src/people/appearance';
import { AVATARS } from '../src/people/avatars';
import { loadCharacter } from '../src/people/character';
import { loadCharacterLibrary } from '../src/people/library';
import { makeMug, makePhone, makeWateringCan } from '../src/people/props';
import { ArmOverlay } from '../src/people/typing';
import { createStubEngine } from './house-engine-stub';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const logEl = document.getElementById('log')!;
const log = (s: string) => { logEl.textContent = `${s}\n${logEl.textContent}`.slice(0, 1200); };
const quality = (params.get('quality') ?? 'high') as Quality;
const engine = createStubEngine(document.getElementById('app')!, { quality, ao: !params.has('noao') });

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9d2c7');
const pmrem = new THREE.PMREMGenerator(engine.renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const sun = new THREE.DirectionalLight('#fff1dd', 2.6);
sun.position.set(-3, 6, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 4, bottom: -2, near: 0.5, far: 20 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, new THREE.HemisphereLight('#fff6ea', '#7a6450', 0.5));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 12).rotateX(-Math.PI / 2), engine.assets.pbr('woodfloor', [8, 3]));
floor.receiveShadow = true;
const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 6), new THREE.MeshStandardMaterial({ color: '#cfc6b8', roughness: 0.9 }));
wall.position.set(0, 3, -2.2);
wall.receiveShadow = true;
scene.add(floor, wall);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const az = THREE.MathUtils.degToRad(num('az', 0)), el = THREE.MathUtils.degToRad(num('el', 6)), dist = num('dist', 7);
const target = new THREE.Vector3(num('tx', 0), num('ty', 0.95), num('tz', 0));
camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist);
camera.lookAt(target);
engine.setView(scene, camera, 'indoor');

async function main() {
  const t0 = performance.now();
  const lib = await loadCharacterLibrary(engine.assets, () => quality);
  const avatarParam = params.get('avatars') ?? 'all';
  const ids = avatarParam === 'ubc' ? ['ubc-f', 'ubc-m'] : avatarParam === 'all' ? AVATARS.map((a) => a.id) : avatarParam.split(',');
  const clips = (params.get('clips') ?? 'Idle_Loop').split(',');
  const freeze = params.has('t') ? num('t', 0) : null;
  const sp = num('sp', 0.85);
  const anims: { anim: Animator; arms?: ArmOverlay; group: THREE.Group }[] = [];
  const mannequinMixers: { mixer: THREE.AnimationMixer; m: THREE.Object3D; clips: THREE.AnimationClip[] }[] = [];
  let tris = 0;
  const looks = ids.map((id, i) => (id.startsWith('ubc-')
    ? { ...lookForAgent({ vendor: 'anthropic', kind: 'role', appearance: { seed: 11 + i, gender: id === 'ubc-m' ? 'm' : 'f' } }), avatar: null }
    : lookForAvatar(id)));
  const chars = await Promise.all(looks.map((look) => loadCharacter(lib, look)));
  if (params.has('debughair')) {
    // show every hair/opacity triangle in flat red (which geometry uses the cut-out material)
    const red = new THREE.MeshBasicMaterial({ color: '#ff2a2a', side: THREE.DoubleSide });
    for (const ch of chars) ch.model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && ((m.material as THREE.Material).userData.hair || (m.material as THREE.Material).userData.hairEdge)) m.material = red; });
  }
  chars.forEach((ch, i) => {
    const g = new THREE.Group();
    const rows = Math.max(1, num('rows', 1));
    const perRow = Math.ceil(chars.length / rows);
    const row = Math.floor(i / perRow), col = i % perRow;
    g.position.x = (col - (perRow - 1) / 2) * sp + (row % 2) * sp * 0.5;
    g.position.z = -row * num('rz', 1.1);
    g.rotation.y = num('yaw', 0);
    g.add(ch.model);
    scene.add(g);
    tris += ch.triangles;
    const anim = new Animator(ch.model, ch.entry.clips, looks[i].height);
    const clip = clips[i % clips.length];
    anim.play(clip, { fade: 0, once: false });
    anim.mixer.setTime(freeze ?? i * 0.37);
    anim.update(0);
    const prop = params.get('prop');
    if (prop) {
      const p = prop === 'phone' ? makePhone() : prop === 'mug' ? makeMug() : makeWateringCan();
      p.position.set(0, prop === 'phone' ? 0.09 : 0.08, prop === 'phone' ? 0.03 : 0.05);
      ch.socket('hand_r').add(p);
    }
    anims.push({ anim, group: g });
  });
  if (params.has('mannequin')) {
    const gltf = await engine.assets.gltf('/assets/animations/UAL1_resampled.glb');
    const gltf2 = await engine.assets.gltf('/assets/animations/UAL2_resampled.glb');
    const all = [...gltf.animations, ...gltf2.animations];
    clips.forEach((name, i) => {
      const m = SkeletonUtils.clone(gltf.scene);
      m.position.set((i - (clips.length - 1) / 2) * sp, 0, -1.2);
      m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      scene.add(m);
      const mixer = new THREE.AnimationMixer(m);
      const clip = all.find((c) => c.name === name);
      if (clip) mixer.clipAction(clip).play();
      mixer.setTime(freeze ?? i * 0.37);
      mannequinMixers.push({ mixer, m, clips: all });
      if (freeze === null) engine.onFrame((dt) => mixer.update(dt));
    });
  }
  if (freeze === null) engine.onFrame((dt) => { for (const a of anims) a.anim.update(dt); });
  log(`${chars.length} people · ${tris} tris · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  (window as unknown as { __people: unknown }).__people = {
    lib, chars, tris,
    /** Re-pose every character (and mannequin) at `t` seconds, optionally switching clip (frozen shots). */
    pose: (t: number, clip?: string) => {
      for (const a of anims) {
        if (clip && a.anim.current !== clip) a.anim.play(clip, { fade: 0, once: false });
        a.anim.mixer.setTime(t);
        a.anim.update(0);
      }
      for (const mm of mannequinMixers) {
        if (clip) {
          const c = mm.clips.find((x) => x.name === clip);
          mm.mixer.stopAllAction();
          if (c) mm.mixer.clipAction(c).play();
        }
        mm.mixer.setTime(t);
      }
    },
    speeds: () => Object.fromEntries([...lib.bodies.values()].map((b) => [b.id, ['Walk_Loop', 'Walk_Formal_Loop'].map((c) => +(b.clips.get(c)?.speed ?? 0).toFixed(3))])),
    info: () => ({ calls: engine.renderer.info.render.calls, tris: engine.renderer.info.render.triangles, programs: engine.renderer.info.programs?.length, textures: engine.renderer.info.memory.textures }),
  };
  let frames = 0;
  engine.onFrame(() => { if (++frames === 3) (window as unknown as { __ready: boolean }).__ready = true; });
}
main().catch((e) => { console.error(e); log(String(e)); });
