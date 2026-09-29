import { CapsuleGeometry, Group, MathUtils, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import type { MoveVector } from '../input/Input.ts';

export interface Obstacle {
  /** Center on the ground plane (y is ignored). */
  position: Vector3;
  halfX: number;
  halfZ: number;
  height: number;
}

const SPEED = 6;
const ACCELERATION = 12;
const TURN_SPEED = 12;
const GRAVITY = -28;
const JUMP_VELOCITY = 10;
const RADIUS = 0.45;
const HEIGHT = 1.4;

export class Player {
  readonly object = new Group();
  readonly velocity = new Vector3();
  private grounded = true;
  private heading = 0;

  constructor() {
    const material = new MeshStandardMaterial({ color: 0xff7a45, roughness: 0.45 });
    const body = new Mesh(new CapsuleGeometry(RADIUS, HEIGHT - RADIUS * 2, 6, 16), material);
    body.position.y = HEIGHT / 2;
    body.castShadow = true;

    // Visor on the front (+Z local) so facing direction is visible.
    const visor = new Mesh(
      new SphereGeometry(0.16, 16, 12),
      new MeshStandardMaterial({ color: 0x1b2440, roughness: 0.2, metalness: 0.3 }),
    );
    visor.position.set(0, HEIGHT - 0.4, RADIUS - 0.05);
    visor.castShadow = true;

    this.object.add(body, visor);
  }

  get position(): Vector3 {
    return this.object.position;
  }

  jump(): void {
    if (!this.grounded) return;
    this.velocity.y = JUMP_VELOCITY;
    this.grounded = false;
  }

  update(dt: number, move: MoveVector, obstacles: readonly Obstacle[], bound: number): void {
    // Camera looks down -Z, so "forward" on the stick maps to -Z in world space.
    const targetVX = move.x * SPEED;
    const targetVZ = -move.y * SPEED;
    const blend = 1 - Math.exp(-ACCELERATION * dt);
    this.velocity.x += (targetVX - this.velocity.x) * blend;
    this.velocity.z += (targetVZ - this.velocity.z) * blend;
    this.velocity.y += GRAVITY * dt;

    const pos = this.object.position;
    const prevY = pos.y;
    pos.addScaledVector(this.velocity, dt);
    pos.x = MathUtils.clamp(pos.x, -bound, bound);
    pos.z = MathUtils.clamp(pos.z, -bound, bound);

    const floor = this.resolveObstacles(obstacles, prevY);
    if (pos.y <= floor) {
      pos.y = floor;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    if (Math.hypot(move.x, move.y) > 0.05) {
      const target = Math.atan2(targetVX, targetVZ);
      const delta = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
      this.heading += delta * (1 - Math.exp(-TURN_SPEED * dt));
      this.object.rotation.y = this.heading;
    }
  }

  /** Pushes the player out of box sides; returns the floor height (box top if standing on one). */
  private resolveObstacles(obstacles: readonly Obstacle[], prevY: number): number {
    const pos = this.object.position;
    let floor = 0;
    for (const o of obstacles) {
      const dx = pos.x - o.position.x;
      const dz = pos.z - o.position.z;
      const nearestX = MathUtils.clamp(dx, -o.halfX, o.halfX);
      const nearestZ = MathUtils.clamp(dz, -o.halfZ, o.halfZ);
      const offX = dx - nearestX;
      const offZ = dz - nearestZ;
      const distSq = offX * offX + offZ * offZ;
      if (distSq >= RADIUS * RADIUS) continue;

      if (prevY >= o.height - 0.05) {
        floor = Math.max(floor, o.height);
        continue;
      }

      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = RADIUS - dist;
        pos.x += (offX / dist) * push;
        pos.z += (offZ / dist) * push;
      } else {
        // Center is inside the box: exit through the nearest face.
        const exitX = o.halfX - Math.abs(dx) + RADIUS;
        const exitZ = o.halfZ - Math.abs(dz) + RADIUS;
        if (exitX < exitZ) pos.x += Math.sign(dx || 1) * exitX;
        else pos.z += Math.sign(dz || 1) * exitZ;
      }
    }
    return floor;
  }
}
