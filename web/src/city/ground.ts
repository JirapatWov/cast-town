// Ground map: a top-down render of the town into a small texture, refreshed when buildings come and go.
//   R = lawn (1 where grass grows: lawn and countryside, not under paving, buildings, hedges or beds)
//   G = openness (0 under/next to buildings, hedges and tree crowns; read from a blurred mip as ambient occlusion)
// Lawn shading darkens grass near walls and under trees with it, and grass blades only grow where R is set.
import * as THREE from 'three';

/** World rectangle covered by the map (the town plus a margin of countryside). */
export const GROUND_RECT = { x0: -170, z0: -125, w: 340, h: 250 };

const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;

/** Shared uniforms for every material that reads the map. */
export const GROUND_UNIFORMS = {
  uGroundMap: { value: white as THREE.Texture },
  uGroundRect: { value: new THREE.Vector4(GROUND_RECT.x0, GROUND_RECT.z0, 1 / GROUND_RECT.w, 1 / GROUND_RECT.h) },
};

/** GLSL: map uv of a world XZ position (v flipped: the map camera looks down with -Z up). */
export const GROUND_GLSL = /* glsl */ `
uniform sampler2D uGroundMap;
uniform vec4 uGroundRect;
vec2 rltGroundUv(vec2 xz) { return vec2((xz.x - uGroundRect.x) * uGroundRect.z, 1.0 - (xz.y - uGroundRect.y) * uGroundRect.w); }
`;

const LAWN = new Set(['lawn', 'ground']);
const FLAT = new Set(['asphalt', 'marking', 'sidewalk', 'curb', 'paving']);

export interface TreeDisc {
  x: number;
  z: number;
  r: number;
}

export class GroundMap {
  private rt: THREE.WebGLRenderTarget;
  private cam: THREE.OrthographicCamera;
  private matLawn = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 0), fog: false });
  private matFlat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 1, 0), fog: false });
  private matSolid = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0), fog: false });
  // tree crowns multiply openness only (dst × src), so grass still grows under them
  private matCrown = new THREE.MeshBasicMaterial({
    color: 0xffffff, fog: false, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  });

  constructor(size = 1024) {
    const h = Math.round((size * GROUND_RECT.h) / GROUND_RECT.w);
    this.rt = new THREE.WebGLRenderTarget(size, h, {
      type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.rt.texture.name = 'ground-map';
    const { w, h: hh } = GROUND_RECT;
    this.cam = new THREE.OrthographicCamera(-w / 2, w / 2, hh / 2, -hh / 2, 1, 400);
    this.cam.up.set(0, 0, -1);
    this.cam.position.set(GROUND_RECT.x0 + w / 2, 200, GROUND_RECT.z0 + hh / 2);
    this.cam.lookAt(GROUND_RECT.x0 + w / 2, 0, GROUND_RECT.z0 + hh / 2);
    this.cam.updateMatrixWorld();
    this.matCrown.map = crownTexture();
  }

  /**
   * Render the map from the scene's `include` subtrees only (town geometry: no people, cars or the tree system,
   * whose crowns are drawn as soft discs instead of leaf cards). Transparent things (decals, glows) never count.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, include: THREE.Object3D[], trees: TreeDisc[]): void {
    const saved: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const hidden: THREE.Object3D[] = [];
    for (const o of scene.children) {
      if (o.visible && !include.includes(o)) {
        hidden.push(o);
        o.visible = false;
      }
    }
    scene.traverseVisible((o) => {
      if ((o as THREE.Sprite).isSprite || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) {
        hidden.push(o);
        o.visible = false;
        return;
      }
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      if (!mat || mat.transparent || !mat.visible || (mat as THREE.MeshBasicMaterial).colorWrite === false) {
        hidden.push(o);
        o.visible = false;
        return;
      }
      saved.push([m, m.material]);
      m.material = LAWN.has(mat.name) ? this.matLawn : FLAT.has(mat.name) ? this.matFlat : this.matSolid;
    });
    const crowns = this.crowns(trees);
    scene.add(crowns);
    const bg = scene.background, fog = scene.fog, prevRt = renderer.getRenderTarget();
    // no shadow pass here (and leave a pending engine shadow update for the real frame)
    const auto = renderer.shadowMap.autoUpdate, pending = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    const clear = renderer.getClearColor(new THREE.Color()), clearA = renderer.getClearAlpha();
    scene.background = null;
    scene.fog = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x00ff00, 1);
    renderer.clear();
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(prevRt);
    renderer.setClearColor(clear, clearA);
    renderer.shadowMap.autoUpdate = auto;
    renderer.shadowMap.needsUpdate = pending;
    scene.background = bg;
    scene.fog = fog;
    scene.remove(crowns);
    crowns.geometry.dispose();
    crowns.dispose();
    for (const [m, mat] of saved) m.material = mat;
    for (const o of hidden) o.visible = true;
    GROUND_UNIFORMS.uGroundMap.value = this.rt.texture;
  }

  private crowns(trees: TreeDisc[]): THREE.InstancedMesh {
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const im = new THREE.InstancedMesh(g, this.matCrown, Math.max(1, trees.length));
    const m = new THREE.Matrix4();
    trees.forEach((t, i) => im.setMatrixAt(i, m.makeScale(t.r * 2, 1, t.r * 2).setPosition(t.x, 30, t.z)));
    im.count = trees.length;
    im.renderOrder = 10;
    im.frustumCulled = false;
    return im;
  }

  dispose(): void {
    this.rt.dispose();
  }
}

let crownTex: THREE.Texture | null = null;
/** Soft disc: openness × (1 − 0.55 at the trunk … 0 at the drip line). */
function crownTexture(): THREE.Texture {
  if (crownTex) return crownTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgb(255,110,255)');
  grad.addColorStop(0.55, 'rgb(255,150,255)');
  grad.addColorStop(1, 'rgb(255,255,255)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  crownTex = new THREE.CanvasTexture(c);
  crownTex.colorSpace = THREE.NoColorSpace;
  return crownTex;
}
