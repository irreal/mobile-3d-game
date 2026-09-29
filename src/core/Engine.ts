import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { config } from '../config.ts';
import { GameLoop } from './GameLoop.ts';
import { PostFx } from './PostFx.ts';
import { observeViewport, preventDefaultGestures } from './viewport.ts';

export interface GameScene {
  readonly scene: Scene;
  update(dt: number, elapsed: number): void;
  /** Called after the drawing buffer and camera aspect change (CSS pixel size). */
  resize?(width: number, height: number): void;
  dispose?(): void;
}

/** Owns the renderer, camera, post-processing and loop; renders whichever `GameScene` is active. */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly fx: PostFx;

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
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = config.shadows;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.camera = new PerspectiveCamera(config.camera.fov, 1, config.camera.near, config.camera.far);
    this.fx = new PostFx(this.renderer, new Scene(), this.camera);
    this.fx.onQualityChange(() => {
      this.needsResize = true;
    });

    preventDefaultGestures(this.canvas);
    this.stopObservingViewport = observeViewport(container, () => {
      this.needsResize = true;
    });

    this.loop = new GameLoop(this.renderer, this.frame);
  }

  setScene(scene: GameScene): void {
    this.activeScene?.dispose?.();
    this.activeScene = scene;
    this.fx.setScene(scene.scene, this.camera);
    this.needsResize = true;
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
    this.fx.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private readonly frame = (dt: number, elapsed: number): void => {
    if (!this.activeScene) return;
    if (this.needsResize) this.resize();
    this.activeScene.update(dt, elapsed);
    if (this.fx.enabled) this.fx.render(dt);
    else this.renderer.render(this.activeScene.scene, this.camera);
    this.frameListeners.forEach((fn) => fn(dt));
  };

  private resize(): void {
    this.needsResize = false;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const aspect = width / height;

    const maxRatio = this.fx.enabled ? config.maxPixelRatioFx : config.maxPixelRatio;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxRatio);
    this.renderer.setPixelRatio(pixelRatio);
    // `false`: CSS owns the canvas' display size; only resize the drawing buffer.
    this.renderer.setSize(width, height, false);
    if (this.fx.enabled) this.fx.setSize(width, height, pixelRatio);

    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.activeScene?.resize?.(width, height);
  }
}
