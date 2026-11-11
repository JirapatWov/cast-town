// Minimal typings for n8ao@2.0.1 (the package ships none). Only what the engine uses.
declare module 'n8ao' {
  import type { Camera, Color, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoSamples: number;
    aoRadius: number;
    denoiseSamples: number;
    denoiseRadius: number;
    distanceFalloff: number;
    intensity: number;
    denoiseIterations: number;
    renderMode: 0 | 1 | 2 | 3 | 4;
    color: Color;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    transparencyAware: boolean;
    accumulate: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    scene: Scene;
    camera: Camera;
    configuration: N8AOConfiguration;
    /** When true (default) every render traverses the scene and turns `transparencyAware` on for good at the
     *  first transparent material it finds. */
    autoDetectTransparency: boolean;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
    setSize(width: number, height: number): void;
    firstFrame(): void;
    render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void;
  }
}
