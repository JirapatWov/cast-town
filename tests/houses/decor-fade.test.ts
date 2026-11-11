// Finding #63: decor buildings hid users' houses (a cottage behind two apartment blocks). web/src/city/decor-fade.ts
// turns a decor building that stands between the camera and a house into a faint ghost: its slice of the merged town
// mesh is drawn with a see-through material through geometry groups. Run: bun test tests/houses/decor-fade.test.ts
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { AMBIENT, LOTS } from '../../shared/city-layout';
import { DecorFade, FadeHold, occluders, segmentHitsBox, type DecorBox, type DecorPart } from '../../web/src/city/decor-fade';
import { Batch } from '../../web/src/city/util/mesh-writer';

const box: DecorBox = { x: 0, z: 0, hw: 5, hd: 5, rotY: 0, top: 10 };

describe('segment vs a decor building', () => {
  test('through it, over its roof, beside it, short of it', () => {
    expect(segmentHitsBox({ x: -20, y: 4, z: 0 }, { x: 20, y: 4, z: 0 }, box)).toBe(true);
    expect(segmentHitsBox({ x: -20, y: 14, z: 0 }, { x: 20, y: 12, z: 0 }, box)).toBe(false); // over the roof
    expect(segmentHitsBox({ x: -20, y: 4, z: 7 }, { x: 20, y: 4, z: 7 }, box)).toBe(false); // beside it
    expect(segmentHitsBox({ x: -20, y: 4, z: 0 }, { x: -8, y: 4, z: 0 }, box)).toBe(false); // stops before it
  });

  test('a turned building is tested in its own frame', () => {
    const long: DecorBox = { x: 0, z: 0, hw: 10, hd: 1, rotY: Math.PI / 2, top: 10 }; // long side along world Z
    expect(segmentHitsBox({ x: -5, y: 2, z: 8 }, { x: 5, y: 2, z: 8 }, long)).toBe(true);
    expect(segmentHitsBox({ x: 8, y: 2, z: -5 }, { x: 8, y: 2, z: 5 }, long)).toBe(false);
  });

  test('in the real town: the shop behind the Center Street lots hides lot C-E1 seen low from the east', () => {
    const lot = LOTS.find((l) => l.id === 'C-E1')!;
    const boxes = AMBIENT.map((b) => ({ x: b.x, z: b.z, hw: b.width / 2 + 1, hd: b.depth / 2 + 1, rotY: b.rotY, top: 3 + b.floors * 3.2 }));
    const shop = AMBIENT.findIndex((b) => b.x === 45 && b.z === 50);
    const house = { x: lot.x, y: 2.5, z: lot.z };
    expect([...occluders({ x: 75, y: 6, z: 52 }, [house], boxes)]).toContain(shop);
    expect(occluders({ x: 21, y: 60, z: 10 }, [house], boxes).size).toBe(0); // from above the avenue: nothing in the way
  });
});

describe('fade hold', () => {
  test('fades at once, comes back only after it has hidden nothing for a while', () => {
    const hold = new FadeHold(3, 0.5);
    expect(hold.step(0.1, new Set([1]))).toBe(true);
    expect([...hold.faded]).toEqual([1]);
    expect(hold.step(0.3, new Set())).toBe(false); // still held
    expect(hold.step(0.1, new Set([1]))).toBe(false); // hides again: the clock restarts
    expect(hold.step(0.4, new Set())).toBe(false);
    expect(hold.step(0.2, new Set())).toBe(true);
    expect(hold.faded.size).toBe(0);
    hold.step(0.1, new Set([0, 2]));
    expect(hold.reset()).toBe(true);
    expect(hold.faded.size).toBe(0);
  });
});

describe('ghosting a slice of the merged town mesh', () => {
  /** Two decor blocks then a non-decor box in one material, like buildAmbient then the rest of the town. */
  function town() {
    const mat = new THREE.MeshStandardMaterial();
    const batch = new Batch();
    const parts: DecorPart[] = [];
    for (const x of [0, 40]) {
      const before = batch.indexCounts();
      batch.writer(mat).box(new THREE.Matrix4().makeTranslation(x, 6, 0), 10, 12, 10);
      parts.push({ footprint: { x, z: 0, hw: 5, hd: 5, rotY: 0 }, ranges: new Map([[mat, [before.get(mat) ?? 0, batch.indexCounts().get(mat)!]]]), extras: [new THREE.Object3D()] });
    }
    batch.writer(mat).box(new THREE.Matrix4().makeTranslation(80, 1, 0), 4, 2, 4); // a planter: never faded
    const meshes = batch.build(new THREE.Group(), 'town');
    return { mat, parts, mesh: meshes[0]!, fade: new DecorFade(parts, meshes) };
  }

  test('heights come from the geometry; the hidden house’s blocker gets its own group, the rest stays one draw', () => {
    const { mat, parts, mesh, fade } = town();
    expect(fade.boxes[0]!.top).toBeCloseTo(12);
    const cam = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
    cam.position.set(0, 5, 40); // south of block 0, looking north at a house behind it
    cam.lookAt(0, 3, -30);
    cam.updateMatrixWorld();
    const house = new THREE.Vector3(0, 3, -30);
    fade.update(1, cam, [house]);
    expect([...fade.faded]).toEqual([0]);
    expect(Array.isArray(mesh.material)).toBe(true);
    const [s, e] = parts[0]!.ranges.get(mat)!;
    expect(mesh.geometry.groups).toEqual([
      { start: s, count: e - s, materialIndex: 1 },
      { start: e, count: mesh.geometry.index!.count - e, materialIndex: 0 },
    ]);
    expect(parts[0]!.extras[0]!.visible).toBe(false);
    expect(parts[1]!.extras[0]!.visible).toBe(true);
    // driving: everything solid again, one draw
    fade.update(1, cam, [house], true);
    expect(fade.faded.size).toBe(0);
    expect(mesh.material).toBe(mat);
    expect(mesh.geometry.groups).toEqual([]);
    expect(parts[0]!.extras[0]!.visible).toBe(true);
  });

  test('a house behind the camera does not fade what is in front of it', () => {
    const { fade } = town();
    const cam = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
    cam.position.set(0, 5, -30);
    cam.lookAt(0, 5, -100); // facing away from block 0 and the house south of it
    cam.updateMatrixWorld();
    fade.update(1, cam, [new THREE.Vector3(0, 3, 40)]);
    expect(fade.faded.size).toBe(0);
  });
});
