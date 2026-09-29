import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Scene } from 'three';
import { config } from '../config.ts';
import { GameLoop } from './GameLoop.ts';
import { observeViewport, preventDefaultGestures } from './viewport.ts';

export interface GameScene {
  readonly scene: Scene;
  update(dt: number, elapsed: number): void;
  dispose?(): void;
}

/** Owns the renderer, camera and loop; renders whichever `GameScene` is active. */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private readonly loop: GameLoop;
  private readonly stopObservingViewport: () => void;
  private readonly frameListeners = new Set<(dt: number) => void>();
  private activeScene: GameScene | null = null;
  private needsResize = true;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({
      antialias: config.antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.camera = new PerspectiveCamera(config.camera.fovLandscape, 1, config.camera.near, config.camera.far);

    preventDefaultGestures(this.canvas);
    this.stopObservingViewport = observeViewport(container, () => {
      this.needsResize = true;
    });

    this.loop = new GameLoop(this.renderer, this.frame);
  }

  setScene(scene: GameScene): void {
    this.activeScene?.dispose?.();
    this.activeScene = scene;
  }

  /** Subscribe to per-frame callbacks (e.g. HUD). Returns an unsubscribe function. */
  onFrame(listener: (dt: number) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.dispose();
    this.stopObservingViewport();
    this.activeScene?.dispose?.();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private readonly frame = (dt: number, elapsed: number): void => {
    if (this.needsResize) this.resize();
    if (!this.activeScene) return;
    this.activeScene.update(dt, elapsed);
    this.renderer.render(this.activeScene.scene, this.camera);
    this.frameListeners.forEach((fn) => fn(dt));
  };

  private resize(): void {
    this.needsResize = false;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.maxPixelRatio));
    // `false`: CSS owns the canvas' display size; only resize the drawing buffer.
    this.renderer.setSize(width, height, false);

    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1 ? config.camera.fovPortrait : config.camera.fovLandscape;
    this.camera.updateProjectionMatrix();
  }
}
