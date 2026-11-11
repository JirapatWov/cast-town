// DOM layers stacked over the canvas: CSS2D label layer and the black fade curtain.
import type * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export interface LabelLayer {
  readonly element: HTMLElement;
  setSize(w: number, h: number): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  /** Hide every label of a scene that is no longer rendered (CSS2DRenderer only touches the active scene). */
  hideScene(scene: THREE.Scene): void;
}

export function createLabelLayer(): LabelLayer {
  const css = new CSS2DRenderer();
  const el = css.domElement;
  el.classList.add('rlt-label-layer');
  Object.assign(el.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '1' });
  return {
    element: el,
    setSize: (w, h) => css.setSize(w, h),
    render: (scene, camera) => css.render(scene, camera),
    hideScene(scene) {
      scene.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.style.display = 'none';
      });
    },
  };
}

export interface FadeCurtain {
  readonly element: HTMLElement;
  fade(toBlack: boolean, ms?: number): Promise<void>;
}

export function createFadeCurtain(): FadeCurtain {
  const el = document.createElement('div');
  el.className = 'rlt-fade';
  Object.assign(el.style, {
    position: 'absolute', inset: '0', background: '#07080a', opacity: '0', pointerEvents: 'none',
    zIndex: '2', transitionProperty: 'opacity', transitionTimingFunction: 'cubic-bezier(.4,0,.2,1)',
  });
  return {
    element: el,
    fade(toBlack, ms = 450) {
      el.style.transitionDuration = `${ms}ms`;
      el.style.pointerEvents = toBlack ? 'auto' : 'none';
      // Force a style flush so the transition starts from the current opacity.
      void el.offsetWidth;
      el.style.opacity = toBlack ? '1' : '0';
      return new Promise((resolve) => setTimeout(resolve, ms + 20));
    },
  };
}

export interface Dissolve {
  readonly element: HTMLCanvasElement;
  /** Freeze the frame just rendered on top of the canvas (call right after rendering, in the same task). */
  capture(source: HTMLCanvasElement): void;
  /** Fade the frozen frame out over the live one. */
  release(ms?: number): void;
  readonly holding: boolean;
}

/** Cross-dissolve between two looks (time-of-day switches): a snapshot of the old frame fades over the new. */
export function createDissolve(): Dissolve {
  const el = document.createElement('canvas');
  el.className = 'rlt-dissolve';
  Object.assign(el.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', opacity: '0',
    zIndex: '0', transitionProperty: 'opacity', transitionTimingFunction: 'cubic-bezier(.4,0,.2,1)', display: 'none',
  });
  let holding = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    element: el,
    get holding() {
      return holding;
    },
    capture(source) {
      if (hideTimer) clearTimeout(hideTimer);
      el.width = source.width;
      el.height = source.height;
      const g = el.getContext('2d');
      if (!g) return;
      g.drawImage(source, 0, 0);
      el.style.transitionDuration = '0ms';
      el.style.display = 'block';
      el.style.opacity = '1';
      holding = true;
    },
    release(ms = 900) {
      if (!holding) return;
      holding = false;
      void el.offsetWidth;
      el.style.transitionDuration = `${ms}ms`;
      el.style.opacity = '0';
      hideTimer = setTimeout(() => {
        el.style.display = 'none';
        el.width = el.height = 1; // free the snapshot
      }, ms + 50);
    },
  };
}
