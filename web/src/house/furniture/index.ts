// Furnishes the interior template and returns the interactive pieces (TV, corkboard, screens).
import * as THREE from 'three';
import { VENDOR_COLORS } from '../../../../shared/protocol';
import { Corkboard } from '../corkboard';
import { ROOM } from '../layout';
import { Screen, ScreenAtlas } from '../screens';
import { TvScreen } from '../tv';
import { furnishKitchen } from './kitchen';
import { Kit, box } from './kit';
import { furnishFill } from './fill';
import { furnishLibrary } from './library';
import { furnishLiving } from './living';
import { DESK_XS, furnishWorkroom } from './workroom';

export interface Furnished {
  tv: TvScreen;
  board: Corkboard;
  screens: Screen[];
}

export async function furnish(kit: Kit): Promise<Furnished> {
  const tv = new TvScreen();
  const board = new Corkboard();
  const screens: Screen[] = [];
  const atlas = new ScreenAtlas(4);
  const tints = [VENDOR_COLORS.anthropic, VENDOR_COLORS.deepseek, VENDOR_COLORS.openai];
  await Promise.all([
    furnishKitchen(kit),
    furnishLiving(kit, tv),
    furnishWorkroom(kit, screens, tints, atlas),
    furnishLibrary(kit),
    furnishFill(kit),
  ]);
  mountCorkboard(kit, board);
  kit.updaters.push((dt) => {
    tv.update(dt);
    board.update(dt);
    for (const s of screens) s.update(dt);
    atlas.update(dt);
  });
  return { tv, board, screens };
}

function mountCorkboard(kit: Kit, board: Corkboard) {
  const w = 2.1, h = 1.31, x = DESK_XS[1], y = 1.66, z = -ROOM.halfD;
  const g = new THREE.Group();
  g.name = 'corkboard';
  g.add(box(w + 0.08, h + 0.08, 0.04, kit.pal.oak, 0, -(h + 0.08) / 2, 0.02));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), board.material);
  face.position.set(0, 0, 0.041);
  face.receiveShadow = true;
  g.add(face);
  g.position.set(x, y, z);
  kit.onWall('back', g, 2.2);
  kit.pickable(g, { kind: 'board', label: 'Job board · workflow', anchor: new THREE.Vector3(x, y + h / 2 + 0.2, z + 0.1) });
}
