import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { COCKPIT, PLAYFIELD } from './constants.ts';

/** Camera looks along +y (the ship's forward) with +z as up. */
const COCKPIT_ROTATION = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));
const TOP_DOWN_ROTATION = new Quaternion();
/** Eye position relative to the ship origin: just above the cockpit canopy. */
const EYE_OFFSET = new Vector3(0, 0.15, 0.62);

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const ROLL_AXIS = new Vector3(0, 0, 1);
const roll = new Quaternion();
const sway = new Quaternion();
const swayEuler = new Euler();
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();

/**
 * Owns the camera pose. `blend` goes 0 (top-down shmup view) → 1 (first-person cockpit);
 * in between, the camera swoops down behind the ship along a curve while rotating to
 * face forward and widening its FOV.
 */
export class CameraDirector {
  blend = 0;
  private direction: -1 | 0 | 1 = 0;
  private duration = 1;
  private progress = 0;
  private time = 0;
  readonly eye = new Vector3();

  get inCockpit(): boolean {
    return this.blend >= 1 && this.direction === 0;
  }

  get transitioning(): boolean {
    return this.direction !== 0;
  }

  /** 0..1 amount for cinematic letterbox bars: peaks mid-transition. */
  get letterbox(): number {
    if (this.direction === 0) return 0;
    const p = this.progress;
    return Math.min(1, Math.min(p, 1 - p) * 5);
  }

  enterCockpit(duration = COCKPIT.enterDuration): void {
    this.direction = 1;
    this.duration = duration;
    this.progress = this.blend;
  }

  exitCockpit(duration = COCKPIT.exitDuration): void {
    this.direction = -1;
    this.duration = duration;
    this.progress = 1 - this.blend;
  }

  reset(): void {
    this.direction = 0;
    this.blend = 0;
  }

  update(
    dt: number,
    camera: PerspectiveCamera,
    cameraDistance: number,
    shipX: number,
    shipY: number,
    shake: number,
  ): void {
    this.time += dt;
    if (this.direction !== 0) {
      this.progress = Math.min(1, this.progress + dt / this.duration);
      const eased = easeInOutCubic(this.progress);
      this.blend = this.direction > 0 ? eased : 1 - eased;
      if (this.progress >= 1) this.direction = 0;
    }
    const t = this.blend;

    // Quadratic Bézier: top-down → swing behind and above the ship → cockpit eye.
    a.set(0, 0, cameraDistance);
    c.set(shipX + EYE_OFFSET.x, shipY + EYE_OFFSET.y, EYE_OFFSET.z);
    b.set(shipX * 0.6, shipY - cameraDistance * 0.35, cameraDistance * 0.3);
    const u = 1 - t;
    camera.position
      .set(0, 0, 0)
      .addScaledVector(a, u * u)
      .addScaledVector(b, 2 * u * t)
      .addScaledVector(c, t * t);
    this.eye.copy(c);

    camera.quaternion.slerpQuaternions(TOP_DOWN_ROTATION, COCKPIT_ROTATION, t);
    // Barrel-roll flourish mid-flight; zero at both ends so the resting views stay level.
    camera.quaternion.multiply(roll.setFromAxisAngle(ROLL_AXIS, Math.sin(Math.PI * t) * 0.45));
    // Gentle cockpit sway so first person doesn't feel like a static turret.
    swayEuler.set(Math.sin(this.time * 0.9) * 0.015 * t, 0, Math.sin(this.time * 0.6) * 0.03 * t);
    camera.quaternion.multiply(sway.setFromEuler(swayEuler));

    const s = shake * shake;
    camera.position.x += (Math.random() - 0.5) * s * MathUtils.lerp(1.2, 0.25, t);
    camera.position.y += (Math.random() - 0.5) * s * MathUtils.lerp(1.2, 0.1, t);
    camera.position.z += (Math.random() - 0.5) * s * MathUtils.lerp(0, 0.25, t);

    const fov = MathUtils.lerp(PLAYFIELD.fov, COCKPIT.fov, t);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
