// Character lineup for the house harness (?scene=lineup): a row of people in front of the camera,
// each playing a clip (?clips=Idle_Loop,Walk_Loop,...) — for checking clothing zones, hair, feet on
// the floor and clip choice. Also measures locomotion clip ground speeds from foot plants.
import * as THREE from 'three';
import type { AgentInfo, Vendor } from '../../shared/protocol';
import type { Engine } from '../src/core/types';
import { Animator } from '../src/people/animator';
import { lookForAgent, lookForAvatar } from '../src/people/appearance';
import { AVATARS } from '../src/people/avatars';
import { createCharacter, loadCharacter } from '../src/people/character';
import { loadCharacterLibrary } from '../src/people/library';

const VENDORS: Vendor[] = ['anthropic', 'openai', 'deepseek', 'google', 'anthropic', 'openai', 'deepseek', 'google'];

export async function showLineup(engine: Engine, scene: THREE.Scene, params: URLSearchParams) {
  const lib = await loadCharacterLibrary(engine.assets, () => engine.quality);
  const clips = (params.get('clips') ?? 'Idle_Loop').split(',');
  // ?avatars=f03,m08 or ?avatars=all (Rocketbox), ?avatars=ubc (fallback bodies), default: seeded looks
  const avatarParam = params.get('avatars');
  const ids = avatarParam === 'all' ? AVATARS.map((a) => a.id) : avatarParam && avatarParam !== 'ubc' ? avatarParam.split(',') : null;
  const n = ids ? ids.length : +(params.get('n') ?? 8);
  const spacing = +(params.get('sp') ?? 0.9);
  const seed0 = +(params.get('seed') ?? 1);
  const root = new THREE.Group();
  root.position.set(+(params.get('lx') ?? 0), 0, +(params.get('lz') ?? 2.2));
  scene.add(root);
  const anims: Animator[] = [];
  const mixers: THREE.AnimationMixer[] = [];
  for (let i = 0; i < n; i++) {
    const agent = {
      vendor: VENDORS[i % VENDORS.length], kind: 'role',
      appearance: { seed: seed0 + i * 13, gender: i % 2 ? 'm' : 'f' },
    } as Pick<AgentInfo, 'vendor' | 'appearance' | 'kind'>;
    let look = ids ? lookForAvatar(ids[i]) : lookForAgent(agent);
    if (avatarParam === 'ubc') look = { ...look, avatar: null };
    const ch = await loadCharacter(lib, look);
    const g = new THREE.Group();
    g.position.x = (i - (n - 1) / 2) * spacing;
    g.rotation.y = +(params.get('yaw') ?? 0);
    g.add(ch.model);
    root.add(g);
    const anim = new Animator(ch.model, ch.entry.clips, look.height);
    anim.play(clips[i % clips.length], { fade: 0, once: false });
    anim.mixer.setTime(i * 0.37);
    anims.push(anim);
  }
  // reference: the UAL mannequin itself playing the raw clips (ground truth for the poses)
  if (params.has('mannequin')) {
    const gltf = await engine.assets.gltf('/assets/animations/UAL1_resampled.glb');
    const gltf2 = await engine.assets.gltf('/assets/animations/UAL2_resampled.glb');
    const all = [...gltf.animations, ...gltf2.animations];
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    clips.forEach((name, i) => {
      const m = clone(gltf.scene);
      m.position.set((i - (clips.length - 1) / 2) * 0.9, 0, -1.2);
      root.add(m);
      const mixer = new THREE.AnimationMixer(m);
      const clip = all.find((c) => c.name === name);
      if (clip) mixer.clipAction(clip).play();
      mixer.setTime(i * 0.37);
      mixers.push(mixer);
    });
  }
  engine.onFrame((dt) => { for (const a of anims) a.update(dt); for (const m of mixers) m.update(dt); });
  return {
    measure: () => measureSpeeds(lib),
    speeds: () => Object.fromEntries([...lib.bodies.values()].map((b) => [b.id, ['Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop'].map((c) => +(b.clips.get(c)?.speed ?? 0).toFixed(3))])),
    tris: () => anims.length,
  };
}

/** Ground speed of in-place locomotion clips: how fast a planted foot slides backward. */
async function measureSpeeds(lib: Awaited<ReturnType<typeof loadCharacterLibrary>>) {
  const out: Record<string, number> = {};
  for (const name of ['Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop', 'Push_Loop', 'Jog_Fwd_Loop']) {
    const look = lookForAgent({ vendor: 'other', kind: 'role', appearance: { seed: 1, gender: 'm' } });
    await lib.load(look);
    const ch = createCharacter(lib, look);
    const anim = new Animator(ch.model, ch.entry.clips, 1);
    const info = ch.entry.clips.get(name);
    if (!info) continue;
    anim.play(name, { fade: 0, once: false });
    const dur = info.clip.duration, N = 240;
    const foot = ch.bone('ball_l');
    const p = new THREE.Vector3();
    const samples: { y: number; z: number }[] = [];
    for (let k = 0; k <= N; k++) {
      anim.mixer.setTime((k / N) * dur);
      ch.model.updateMatrixWorld(true);
      foot.getWorldPosition(p);
      samples.push({ y: p.y, z: p.z });
    }
    const minY = Math.min(...samples.map((s) => s.y));
    // velocity while the foot is planted (within 2 cm of its lowest point)
    let dist = 0, time = 0;
    for (let k = 1; k <= N; k++) {
      if (samples[k].y < minY + 0.02 && samples[k - 1].y < minY + 0.02) {
        dist += samples[k - 1].z - samples[k].z;
        time += dur / N;
      }
    }
    out[name] = time > 0 ? +(dist / time).toFixed(3) : 0;
    ch.dispose();
  }
  return out;
}
