import { MathUtils } from 'three';
import { createPlayerShip } from './models.ts';
import type { PlayerModel } from './models.ts';
import { ShipWeapons } from './ShipWeapons.ts';

/** Visual state of the player's ship; movement rules live in the scene. */
export class PlayerShip {
  readonly model: PlayerModel = createPlayerShip();
  readonly weapons = new ShipWeapons();
  x = 0;
  y = 0;
  /** Blown up (game over): stays hidden until placed again. */
  destroyed = false;
  private prevX = 0;
  private strafeRoll = 0;
  private time = 0;
  private maneuverKind: Maneuver | null = null;
  private maneuverTime = 0;
  private maneuverDuration = 1;
  private maneuverSide = 1;

  constructor() {
    this.model.object.add(this.weapons.object);
  }

  get object() {
    return this.model.object;
  }

  get tailY(): number {
    return this.model.tailY;
  }

  place(x: number, y: number): void {
    this.x = this.prevX = x;
    this.y = y;
    this.destroyed = false;
    this.maneuverKind = null;
    this.object.rotation.set(0, 0, 0);
    this.object.scale.setScalar(1);
    this.sync(0, 0);
  }

  /**
   * Plays a flourish over `seconds` (purely visual): a banking S-turn, nose down and dropping
   * away into a planet's atmosphere ('dive'), or a wide climbing turn away from it ('climb').
   */
  maneuver(kind: Maneuver, seconds: number): void {
    this.maneuverKind = kind;
    this.maneuverTime = 0;
    this.maneuverDuration = seconds;
    this.maneuverSide = this.x > 0 ? 1 : -1;
  }

  /** Updates transform, banking and engine flicker; the ship blinks while `invulnerable` > 0. */
  sync(dt: number, invulnerable: number): void {
    this.time += dt;
    const obj = this.object;
    obj.position.set(this.x, this.y, 0);

    // Roll around the ship's long axis when strafing.
    const vx = dt > 0 ? (this.x - this.prevX) / dt : 0;
    this.prevX = this.x;
    const targetRoll = MathUtils.clamp(vx * 0.05, -0.75, 0.75);
    this.strafeRoll = MathUtils.damp(this.strafeRoll, targetRoll, 10, dt);
    const m = this.updateManeuver(dt);
    obj.rotation.set(m.pitch, this.strafeRoll + m.roll, m.yaw);
    obj.scale.setScalar(m.scale);

    this.model.flame.scale.set(1, 0.8 + Math.sin(this.time * 40) * 0.2 + Math.random() * 0.15, 1);
    obj.visible = !this.destroyed && (invulnerable <= 0 || Math.floor(invulnerable * 14) % 2 === 0);
  }

  private updateManeuver(dt: number): { pitch: number; roll: number; yaw: number; scale: number } {
    const pose = maneuverPose;
    pose.pitch = pose.roll = pose.yaw = 0;
    pose.scale = 1;
    if (!this.maneuverKind) return pose;
    this.maneuverTime += dt;
    const t = Math.min(1, this.maneuverTime / this.maneuverDuration);
    // The camera is still pulling out of the cockpit early on; build up as the ship comes into view.
    const env = MathUtils.smoothstep(t, 0.08, 0.35) * (1 - MathUtils.smoothstep(t, 0.72, 1));
    const side = this.maneuverSide;
    if (this.maneuverKind === 'dive') {
      // Swing toward the centre and back: yaw one way then the other, banking into each turn.
      const s = Math.sin(MathUtils.smoothstep(t, 0.1, 0.95) * Math.PI * 2);
      pose.yaw = side * 0.42 * s * env;
      pose.roll = -side * 0.95 * s * env;
      pose.pitch = -0.6 * env;
      pose.scale = 1 - 0.2 * env;
    } else {
      // One long banked turn while pulling the nose up, rising toward the camera.
      pose.yaw = side * 0.5 * env;
      pose.roll = -side * 1.05 * env;
      pose.pitch = 0.65 * env;
      pose.scale = 1 + 0.16 * env;
    }
    if (t >= 1) this.maneuverKind = null;
    return pose;
  }
}

export type Maneuver = 'dive' | 'climb';

const maneuverPose = { pitch: 0, roll: 0, yaw: 0, scale: 1 };
