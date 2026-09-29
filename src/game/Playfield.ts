import { MathUtils } from 'three';
import { PLAYFIELD } from './constants.ts';

/**
 * Gameplay happens on the z = 0 plane with +y as "up the screen". The camera looks
 * straight down -z and is pulled back far enough to show the playfield on any aspect ratio.
 */
export class Playfield {
  /** Half extents of what the camera sees at z = 0. */
  visibleHalfWidth = PLAYFIELD.minWidth / 2;
  visibleHalfHeight = PLAYFIELD.height / 2;
  /** Half width the player and spawns are confined to. */
  halfWidth = PLAYFIELD.minWidth / 2;
  worldPerPixel = 0.05;
  cameraDistance = 25;
  widthPx = 1;
  heightPx = 1;

  /** Recomputes bounds for a new screen size. Camera pose and FOV are left to `CameraDirector`. */
  fit(widthPx: number, heightPx: number): void {
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    const aspect = widthPx / heightPx;
    let halfH = PLAYFIELD.height / 2;
    let halfW = halfH * aspect;
    if (halfW < PLAYFIELD.minWidth / 2) {
      halfW = PLAYFIELD.minWidth / 2;
      halfH = halfW / aspect;
    }

    this.visibleHalfWidth = halfW;
    this.visibleHalfHeight = halfH;
    this.halfWidth = Math.min(halfW, PLAYFIELD.maxWidth / 2);
    this.worldPerPixel = (halfH * 2) / heightPx;
    this.cameraDistance = halfH / Math.tan(MathUtils.degToRad(PLAYFIELD.fov / 2));
  }

  get top(): number {
    return this.visibleHalfHeight;
  }

  get bottom(): number {
    return -this.visibleHalfHeight;
  }

  isOutside(x: number, y: number, margin: number): boolean {
    return (
      y > this.visibleHalfHeight + margin ||
      y < -this.visibleHalfHeight - margin ||
      Math.abs(x) > this.visibleHalfWidth + margin
    );
  }
}
