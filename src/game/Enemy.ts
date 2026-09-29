import { MathUtils } from 'three';
import { createGrunt, createTank, createWeaver, disposeModel } from './models.ts';
import type { Model } from './models.ts';

export type EnemyKind = 'grunt' | 'weaver' | 'tank';

interface EnemyStats {
  hp: number;
  radius: number;
  score: number;
  speed: number;
  /** Seconds between shots, [min, max] before difficulty scaling. */
  fireInterval: readonly [number, number];
  create: () => Model;
}

export const ENEMY_STATS: Record<EnemyKind, EnemyStats> = {
  /** Saucer that drifts down and fires single aimed shots. */
  grunt: { hp: 5, radius: 0.8, score: 100, speed: 3.2, fireInterval: [1.8, 3.4], create: createGrunt },
  /** Fast dart that snakes side to side and fires straight down. */
  weaver: { hp: 8, radius: 0.75, score: 150, speed: 4.4, fireInterval: [1.4, 2.4], create: createWeaver },
  /** Slow heavy that parks near the top and fires aimed 5-way spreads. Always drops a power-up. */
  tank: { hp: 70, radius: 1.35, score: 600, speed: 2.2, fireInterval: [1.5, 2.1], create: createTank },
};

export interface EnemyContext {
  playerX: number;
  playerY: number;
  top: number;
  halfWidth: number;
  /** 0 at start, 1 at maximum difficulty. */
  difficulty: number;
  bulletSpeed: number;
  fire: (x: number, y: number, vx: number, vy: number) => void;
}

const TANK_HOVER_TIME = 7;

export class Enemy {
  readonly model: Model;
  readonly radius: number;
  readonly score: number;
  hp: number;
  x: number;
  y: number;
  age = 0;

  private readonly speed: number;
  private fireTimer: number;
  private flashTimer = 0;
  private readonly baseEmissive: number[];
  private prevX: number;
  private tankState: 'enter' | 'hover' | 'exit' = 'enter';
  private hoverTime = 0;

  constructor(
    readonly kind: EnemyKind,
    private readonly baseX: number,
    y: number,
    private readonly phase: number,
    difficulty: number,
    /** Multiplier on base HP (grows with each wave). */
    hpScale = 1,
  ) {
    const stats = ENEMY_STATS[kind];
    this.model = stats.create();
    this.baseEmissive = this.model.flashMaterials.map((m) => m.emissive.getHex());
    this.radius = stats.radius;
    this.score = stats.score;
    this.hp = Math.round(stats.hp * hpScale);
    this.speed = stats.speed * MathUtils.lerp(1, 1.25, difficulty);
    this.x = baseX;
    this.prevX = baseX;
    this.y = y;
    // First shot comes a little later so enemies don't fire the instant they appear.
    this.fireTimer = this.nextFireDelay(difficulty) + 0.6;
    this.model.object.position.set(this.x, this.y, 0);
  }

  get object() {
    return this.model.object;
  }

  /** Returns true while the enemy is still in play. */
  update(dt: number, ctx: EnemyContext): boolean {
    this.age += dt;
    this.prevX = this.x;
    this.move(dt, ctx);

    const onScreen = this.y < ctx.top - 0.5;
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = this.nextFireDelay(ctx.difficulty);
      // Only shoot from on screen and from above the player, so shots are always dodgeable.
      if (onScreen && this.y > ctx.playerY + 2.5) this.shoot(ctx);
    }

    this.animate(dt);
    return this.y > -ctx.top - 3;
  }

  /** Applies damage; returns true if this killed the enemy. */
  hit(damage: number): boolean {
    this.hp -= damage;
    this.flashTimer = 0.06;
    return this.hp <= 0;
  }

  dispose(): void {
    disposeModel(this.model);
  }

  private move(dt: number, ctx: EnemyContext): void {
    const limit = ctx.halfWidth - this.radius;
    switch (this.kind) {
      case 'grunt':
        this.y -= this.speed * dt;
        this.x = MathUtils.clamp(this.baseX + Math.sin(this.age * 1.6 + this.phase) * 0.6, -limit, limit);
        break;
      case 'weaver':
        this.y -= this.speed * dt;
        this.x = MathUtils.clamp(this.baseX + Math.sin(this.age * 2.4 + this.phase) * 2.6, -limit, limit);
        break;
      case 'tank': {
        const hoverY = ctx.top * 0.45;
        if (this.tankState === 'enter') {
          this.y -= this.speed * dt;
          if (this.y <= hoverY) this.tankState = 'hover';
        } else if (this.tankState === 'hover') {
          this.hoverTime += dt;
          this.y = MathUtils.damp(this.y, hoverY, 2, dt);
          if (this.hoverTime > TANK_HOVER_TIME) this.tankState = 'exit';
        } else {
          this.y -= this.speed * 1.4 * dt;
        }
        this.x = MathUtils.clamp(this.baseX + Math.sin(this.hoverTime * 0.9 + this.phase) * 3, -limit, limit);
        break;
      }
    }
  }

  private shoot(ctx: EnemyContext): void {
    const speed = ctx.bulletSpeed;
    const muzzleY = this.y - this.radius * 0.8;
    if (this.kind === 'weaver') {
      ctx.fire(this.x, muzzleY, 0, -speed);
      return;
    }

    const aim = Math.atan2(ctx.playerY - muzzleY, ctx.playerX - this.x);
    if (this.kind === 'grunt') {
      ctx.fire(this.x, muzzleY, Math.cos(aim) * speed, Math.sin(aim) * speed);
      return;
    }

    const spread = MathUtils.degToRad(14);
    const tankSpeed = speed * 0.85;
    for (let i = -2; i <= 2; i++) {
      const a = aim + i * spread;
      ctx.fire(this.x, muzzleY, Math.cos(a) * tankSpeed, Math.sin(a) * tankSpeed);
    }
  }

  private animate(dt: number): void {
    const obj = this.model.object;
    obj.position.set(this.x, this.y, 0);

    // Bank into turns (enemies face down the screen, so the roll sign is flipped).
    const vx = dt > 0 ? (this.x - this.prevX) / dt : 0;
    obj.rotation.y = MathUtils.damp(obj.rotation.y, MathUtils.clamp(-vx * 0.2, -0.8, 0.8), 8, dt);
    if (this.kind === 'grunt') obj.rotation.x = Math.sin(this.age * 2 + this.phase) * 0.15;

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const flashing = this.flashTimer > 0;
      this.model.flashMaterials.forEach((m, i) => {
        m.emissive.setHex(flashing ? 0xffffff : this.baseEmissive[i]!);
      });
    }
  }

  private nextFireDelay(difficulty: number): number {
    const [min, max] = ENEMY_STATS[this.kind].fireInterval;
    return MathUtils.randFloat(min, max) * MathUtils.lerp(1, 0.55, difficulty);
  }
}
