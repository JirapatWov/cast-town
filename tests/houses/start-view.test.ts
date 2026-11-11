// Finding #63 (phone): from the desktop's start pose a phone held upright saw a narrow slice of the town and the
// user's houses fell off its edge. web/src/city/framing.ts fits the start view to the screen. Run:
// bun test tests/houses/start-view.test.ts
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { LOTS } from '../../shared/city-layout';
import { framePose, poseShows, type FramePose } from '../../web/src/city/framing';

// the town's start pose and camera (web/src/city/index.ts)
const HOME: FramePose = { target: new THREE.Vector3(-10, 0, 5), radius: 230, phi: 1.0, theta: 0.5 };
const FOV = 38;
const MAX = 380;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** A house on a lot: its ground and the top of its name tag. */
const house = (lotId: string, h = 6) => {
  const l = LOTS.find((x) => x.id === lotId)!;
  return [{ x: l.x, y: 0, z: l.z }, { x: l.x, y: h + 3, z: l.z }];
};

describe('start view', () => {
  test('the desktop keeps its pose when the houses already show', () => {
    const pts = [...house('A-N3'), ...house('A-N1')];
    expect(poseShows(HOME, pts, DESKTOP, FOV)).toBe(true);
    expect(framePose(HOME, pts, DESKTOP, FOV, MAX)).toBe(HOME);
  });

  test('a phone held upright gets a view that shows both houses (todo-api off the edge before)', () => {
    const pts = [...house('A-N3'), ...house('A-N1')];
    expect(poseShows(HOME, pts, PHONE, FOV)).toBe(false);
    const p = framePose(HOME, pts, PHONE, FOV, MAX);
    expect(p).not.toBe(HOME);
    expect(poseShows(p, pts, PHONE, FOV)).toBe(true);
    expect(p.radius).toBeLessThanOrEqual(MAX);
    expect(p.phi).toBe(HOME.phi);
  });

  test('houses far apart: it turns the view along them rather than give up', () => {
    const pts = [...house('A-N1'), ...house('A-N6')]; // 210 m apart on Main Avenue
    const p = framePose(HOME, pts, PHONE, FOV, MAX);
    expect(poseShows(p, pts, PHONE, FOV)).toBe(true);
    expect(p.theta).not.toBe(HOME.theta);
  });

  test('no houses, or no screen yet: the start pose as it is', () => {
    expect(framePose(HOME, [], PHONE, FOV, MAX)).toBe(HOME);
    expect(framePose(HOME, house('A-N1'), { width: 0, height: 0 }, FOV, MAX)).toBe(HOME);
  });
});
