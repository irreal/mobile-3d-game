import type { WebGLRenderer } from 'three';
import { config } from '../config.ts';

export type FrameCallback = (dt: number, elapsed: number) => void;

/**
 * Drives the frame callback via `renderer.setAnimationLoop` (rAF, and WebXR-compatible).
 * Stops while the page is hidden and resets timing on resume.
 */
export class GameLoop {
  private lastTime: number | null = null;
  private elapsed = 0;
  private running = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly onFrame: FrameCallback,
  ) {
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    this.renderer.setAnimationLoop(this.tick);
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose(): void {
    this.stop();
    document.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private readonly tick = (time: number): void => {
    const dt = this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, config.maxDeltaTime);
    this.lastTime = time;
    this.elapsed += dt;
    this.onFrame(dt, this.elapsed);
  };

  private readonly handleVisibility = (): void => {
    if (document.hidden) {
      this.renderer.setAnimationLoop(null);
    } else if (this.running) {
      this.lastTime = null;
      this.renderer.setAnimationLoop(this.tick);
    }
  };
}
