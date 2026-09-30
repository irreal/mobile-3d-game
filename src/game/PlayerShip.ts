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
  private time = 0;

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
    this.object.rotation.set(0, 0, 0);
    this.sync(0, 0);
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
    obj.rotation.y = MathUtils.damp(obj.rotation.y, targetRoll, 10, dt);

    this.model.flame.scale.set(1, 0.8 + Math.sin(this.time * 40) * 0.2 + Math.random() * 0.15, 1);
    obj.visible = !this.destroyed && (invulnerable <= 0 || Math.floor(invulnerable * 14) % 2 === 0);
  }
}
