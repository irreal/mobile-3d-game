import { MathUtils } from 'three';
import { createDiver, createGrunt, createSprayer, createSwooper, createTank, createWeaver, disposeModel } from './models.ts';
import type { Model } from './models.ts';
import { createCore, createSentry } from './AlienBase.ts';
import { randFloat } from './rng.ts';
import type { Rng } from './rng.ts';

export type EnemyKind = 'grunt' | 'weaver' | 'tank' | 'diver' | 'sprayer' | 'swooper' | 'sentry' | 'core';

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
  /** Drops in, locks onto the player (blinking), then dashes straight at where they were. Never shoots. */
  diver: { hp: 6, radius: 0.75, score: 180, speed: 5, fireInterval: [99, 99], create: createDiver },
  /** Parks mid-screen and fires rotating rings of shots, then leaves. */
  sprayer: { hp: 34, radius: 1.2, score: 450, speed: 2.6, fireInterval: [1.7, 2.2], create: createSprayer },
  /** Sweeps across the screen from one side in a dipping arc, with one aimed shot. */
  swooper: { hp: 6, radius: 0.8, score: 160, speed: 7, fireInterval: [99, 99], create: createSwooper },
  /** Alien base turret, fixed on a pylon; fires aimed 3-shot bursts. */
  sentry: { hp: 45, radius: 1.05, score: 800, speed: 0, fireInterval: [2.4, 3.4], create: createSentry },
  /** Alien base reactor: shielded while any sentry stands, then fires rings and fans. */
  core: { hp: 380, radius: 2.1, score: 5000, speed: 0, fireInterval: [1.1, 1.5], create: createCore },
};

/** Explosion particle colors per kind. */
export const EXPLOSION_COLORS: Record<EnemyKind, readonly number[]> = {
  grunt: [0xff5a36, 0xffb443, 0xffffff, 0xff2d55],
  weaver: [0xff2d55, 0xffb443, 0xffffff],
  tank: [0xff5a36, 0xffe14d, 0xff2d55, 0xffffff, 0x9fe8ff],
  diver: [0x57ff9a, 0xb6ffd0, 0xffffff, 0xffe14d],
  sprayer: [0xc04dff, 0xff5ad8, 0xffffff, 0xffe14d, 0x9fe8ff],
  swooper: [0xff9a3d, 0xffe14d, 0xffffff, 0xff5a36],
  sentry: [0xff3df0, 0xffb443, 0xffffff, 0x9fe8ff],
  core: [0xff3df0, 0x57ffd8, 0xffffff, 0xffe14d, 0xff5a36],
};

export interface EnemyContext {
  playerX: number;
  playerY: number;
  top: number;
  halfWidth: number;
  /** 0 at start, 1 at maximum difficulty. */
  difficulty: number;
  bulletSpeed: number;
  /**
   * Co-op: every client runs the same enemies, so fire on a schedule that carries over frame
   * boundaries and place each shot by how late in the frame it was due.
   */
  shared: boolean;
  /** `late`: seconds since the shot was due; it should be that far along already. */
  fire: (x: number, y: number, vx: number, vy: number, late: number) => void;
  /**
   * Who `enemy` shoots and dives at, as of `late` seconds ago (in co-op, the same squad member
   * on every screen); null: nobody to aim at.
   */
  aim: (enemy: Enemy, late: number) => { x: number; y: number } | null;
}

const TANK_HOVER_TIME = 7;
const SPRAYER_HOVER_TIME = 6;
/** Seconds a diver hangs in place, locked on, before dashing. */
const DIVER_AIM_TIME = 0.8;
const DIVER_DASH_SPEED = 17;
const SPRAYER_SHOTS = 10;

type Motion = 'enter' | 'hover' | 'aim' | 'dash' | 'exit';

export class Enemy {
  readonly model: Model;
  readonly radius: number;
  readonly score: number;
  hp: number;
  x: number;
  y: number;
  age = 0;
  /** Same on every co-op client for the same enemy (0 when unnumbered). */
  netId = 0;

  private readonly speed: number;
  private fireTimer: number;
  private flashTimer = 0;
  private readonly baseEmissive: number[];
  private prevX: number;
  private motion: Motion = 'enter';
  private hoverTime = 0;
  /** Seconds before it enters play (hidden until then), for staggered formations. */
  private wait: number;
  private started = false;
  private dirX = 0;
  private dirY = -1;
  private startX = 0;
  private startY = 0;
  private travelled = 0;
  private shotFired = false;
  private sprayAngle = 0;
  private volley = 0;
  /** Base parts (sentry, core) are pinned here by the scene each frame. */
  anchorX: number;
  anchorY: number;
  /** A shielded enemy takes no damage. */
  shielded = false;
  /** Doesn't shoot while set (base parts until the base has arrived). */
  holdFire = false;
  private shieldFlash = 0;
  private readonly rng: Rng;

  constructor(
    readonly kind: EnemyKind,
    private readonly baseX: number,
    y: number,
    private readonly phase: number,
    difficulty: number,
    /** Multiplier on base HP (grows with each wave). */
    hpScale = 1,
    delay = 0,
    /** Drives the fire timing (seeded per enemy in co-op, so every client shoots alike). */
    rng: Rng = Math.random,
  ) {
    this.rng = rng;
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
    this.anchorX = baseX;
    this.anchorY = y;
    this.wait = delay;
    // First shot comes a little later so enemies don't fire the instant they appear.
    this.fireTimer = this.nextFireDelay(difficulty) + 0.6;
    this.model.object.position.set(this.x, this.y, 0);
    this.model.object.visible = delay <= 0;
  }

  get object() {
    return this.model.object;
  }

  /** False while it is still waiting to enter; it can't be hit or collide yet. */
  get active(): boolean {
    return this.wait <= 0;
  }

  /** Returns true while the enemy is still in play. */
  update(dt: number, ctx: EnemyContext): boolean {
    if (this.wait !== 0) {
      this.wait -= dt;
      if (this.wait > 0) return true;
      // Only the part of the frame after it entered (a negative delay means it's already in).
      dt = -this.wait;
      this.wait = 0;
      this.model.object.visible = true;
    }
    if (!this.started) this.begin(ctx);
    this.age += dt;
    this.prevX = this.x;
    const x0 = this.x;
    const y0 = this.y;
    const inPlay = this.move(dt, ctx);

    this.fireTimer -= dt;
    if (ctx.shared) {
      const x1 = this.x;
      const y1 = this.y;
      for (let shots = 0; this.fireTimer <= 0 && shots < 3; shots++) {
        const late = -this.fireTimer;
        this.fireTimer += this.nextFireDelay(ctx.difficulty);
        // Fire from where it was when the shot was due, not where the frame happened to end.
        const k = dt > 0 ? Math.min(1, late / dt) : 0;
        this.x = x1 - (x1 - x0) * k;
        this.y = y1 - (y1 - y0) * k;
        if (!this.holdFire && this.y < ctx.top - 0.5) this.shoot(ctx, late);
      }
      this.x = x1;
      this.y = y1;
    } else if (this.fireTimer <= 0) {
      this.fireTimer = this.nextFireDelay(ctx.difficulty);
      if (!this.holdFire && this.y < ctx.top - 0.5) this.shoot(ctx, 0);
    }

    this.animate(dt);
    return inPlay && this.y > -ctx.top - 3 && Math.abs(this.x) < ctx.halfWidth + 4;
  }

  /** Applies damage; returns true if this killed the enemy. */
  hit(damage: number): boolean {
    if (this.shielded) {
      this.shieldFlash = 0.08;
      return false;
    }
    this.hp -= damage;
    this.flashTimer = 0.06;
    return this.hp <= 0;
  }

  dispose(): void {
    disposeModel(this.model);
  }

  private begin(ctx: EnemyContext): void {
    this.started = true;
    if (this.kind === 'swooper') {
      // Enters from the side `baseX` points to, a little below the top edge.
      const side = Math.sign(this.baseX) || 1;
      this.startX = side * (ctx.halfWidth + 1.5);
      this.startY = ctx.top * 0.8 - this.phase;
      this.x = this.prevX = this.startX;
      this.y = this.startY;
    }
  }

  private move(dt: number, ctx: EnemyContext): boolean {
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
      case 'tank':
      case 'sprayer': {
        const hoverY = ctx.top * (this.kind === 'tank' ? 0.45 : 0.4);
        if (this.motion === 'enter') {
          this.y -= this.speed * dt;
          if (this.y <= hoverY) this.motion = 'hover';
        } else if (this.motion === 'hover') {
          this.hoverTime += dt;
          this.y = MathUtils.damp(this.y, hoverY, 2, dt);
          if (this.hoverTime > (this.kind === 'tank' ? TANK_HOVER_TIME : SPRAYER_HOVER_TIME)) this.motion = 'exit';
        } else {
          this.y -= this.speed * 1.4 * dt;
        }
        const sway = this.kind === 'tank' ? 3 : 1.5;
        this.x = MathUtils.clamp(this.baseX + Math.sin(this.hoverTime * 0.9 + this.phase) * sway, -limit, limit);
        break;
      }
      case 'diver': {
        const aimY = ctx.top * (0.55 - 0.08 * Math.abs(this.phase));
        if (this.motion === 'enter') {
          this.y = Math.max(aimY, this.y - this.speed * 1.6 * dt);
          if (this.y <= aimY) this.motion = 'aim';
        } else if (this.motion === 'aim') {
          this.hoverTime += dt;
          const target = ctx.aim(this, 0);
          if (target) {
            const dx = target.x - this.x;
            const dy = target.y - this.y;
            const len = Math.hypot(dx, dy) || 1;
            this.dirX = dx / len;
            this.dirY = dy / len;
          }
          if (this.hoverTime > DIVER_AIM_TIME) this.motion = 'dash';
        } else {
          const speed = DIVER_DASH_SPEED * MathUtils.lerp(1, 1.2, ctx.difficulty);
          this.x += this.dirX * speed * dt;
          this.y += this.dirY * speed * dt;
        }
        break;
      }
      case 'swooper': {
        const width = 2 * Math.abs(this.startX);
        this.travelled += this.speed * dt;
        const t = this.travelled / width;
        const swoop = (travelled: number): void => {
          this.x = this.startX - Math.sign(this.startX) * travelled;
          this.y = this.startY - Math.sin(Math.min(travelled / width, 1) * Math.PI) * ctx.top * 0.45;
        };
        if (!this.shotFired && t > 0.3) {
          this.shotFired = true;
          // Shared: from the point on the path where the shot was due.
          const late = ctx.shared ? (this.travelled - 0.3 * width) / this.speed : 0;
          swoop(ctx.shared ? 0.3 * width : this.travelled);
          const target = ctx.aim(this, late);
          if (target && this.y > target.y + 2.5) this.aimedShot(ctx, 1, target, late);
        }
        swoop(this.travelled);
        return t < 1;
      }
      case 'sentry':
      case 'core':
        this.x = this.anchorX;
        this.y = this.anchorY;
        {
          const target = ctx.aim(this, 0);
          if (target) {
            this.dirX = target.x - this.x;
            this.dirY = target.y - this.y;
          }
        }
        break;
    }
    return true;
  }

  private shoot(ctx: EnemyContext, late: number): void {
    // Only shoot from above the target, so shots are always dodgeable.
    const target = ctx.aim(this, late);
    if (!target || this.y <= target.y + 2.5) return;
    const speed = ctx.bulletSpeed;
    const muzzleY = this.y - this.radius * 0.8;
    switch (this.kind) {
      case 'weaver':
        ctx.fire(this.x, muzzleY, 0, -speed, late);
        return;
      case 'grunt':
        this.aimedShot(ctx, 1, target, late);
        return;
      case 'sprayer': {
        if (this.motion !== 'hover') return;
        this.sprayAngle += Math.PI / SPRAYER_SHOTS;
        const ringSpeed = speed * 0.7;
        for (let i = 0; i < SPRAYER_SHOTS; i++) {
          const a = this.sprayAngle + (i / SPRAYER_SHOTS) * Math.PI * 2;
          ctx.fire(this.x, this.y, Math.cos(a) * ringSpeed, Math.sin(a) * ringSpeed, late);
        }
        return;
      }
      case 'tank': {
        const aim = Math.atan2(target.y - muzzleY, target.x - this.x);
        const spread = MathUtils.degToRad(14);
        const tankSpeed = speed * 0.85;
        for (let i = -2; i <= 2; i++) {
          const a = aim + i * spread;
          ctx.fire(this.x, muzzleY, Math.cos(a) * tankSpeed, Math.sin(a) * tankSpeed, late);
        }
        return;
      }
      case 'sentry': {
        const aim = Math.atan2(target.y - this.y, target.x - this.x);
        for (let i = -1; i <= 1; i++) {
          const a = aim + i * MathUtils.degToRad(9);
          const x = this.x + Math.cos(aim) * 0.9;
          const y = this.y + Math.sin(aim) * 0.9;
          ctx.fire(x, y, Math.cos(a) * speed * 0.9, Math.sin(a) * speed * 0.9, late);
        }
        return;
      }
      case 'core': {
        // Shielded: slow rings now and then. Exposed: alternating spiral rings and aimed fans.
        this.volley++;
        if (this.shielded && this.volley % 2 === 0) return;
        if (this.shielded || this.volley % 3 !== 0) {
          const count = this.shielded ? 8 : 14;
          this.sprayAngle += Math.PI / count;
          for (let i = 0; i < count; i++) {
            const a = this.sprayAngle + (i / count) * Math.PI * 2;
            ctx.fire(this.x, this.y, Math.cos(a) * speed * 0.6, Math.sin(a) * speed * 0.6, late);
          }
        } else {
          const aim = Math.atan2(target.y - this.y, target.x - this.x);
          for (let i = -3; i <= 3; i++) {
            const a = aim + i * MathUtils.degToRad(11);
            ctx.fire(this.x, this.y - 1, Math.cos(a) * speed * 0.8, Math.sin(a) * speed * 0.8, late);
          }
        }
        return;
      }
      default:
    }
  }

  private aimedShot(ctx: EnemyContext, speedScale: number, target: { x: number; y: number }, late: number): void {
    const muzzleY = this.y - this.radius * 0.8;
    const aim = Math.atan2(target.y - muzzleY, target.x - this.x);
    const speed = ctx.bulletSpeed * speedScale;
    ctx.fire(this.x, muzzleY, Math.cos(aim) * speed, Math.sin(aim) * speed, late);
  }

  private animate(dt: number): void {
    const obj = this.model.object;
    obj.position.set(this.x, this.y, 0);

    // Bank into turns (enemies face down the screen, so the roll sign is flipped).
    const vx = dt > 0 ? (this.x - this.prevX) / dt : 0;
    obj.rotation.y = MathUtils.damp(obj.rotation.y, MathUtils.clamp(-vx * 0.2, -0.8, 0.8), 8, dt);
    if (this.kind === 'grunt') obj.rotation.x = Math.sin(this.age * 2 + this.phase) * 0.15;
    if (this.kind === 'sprayer') obj.rotation.z += dt * (this.motion === 'hover' ? 1.6 : 0.4);
    if (this.kind === 'diver' && this.motion !== 'enter') {
      // Nose (-y) toward the locked-on direction.
      const target = Math.atan2(this.dirY, this.dirX) + Math.PI / 2;
      obj.rotation.z = MathUtils.damp(obj.rotation.z, target, 14, dt);
    }
    if (this.kind === 'sentry') {
      obj.rotation.z = MathUtils.damp(obj.rotation.z, Math.atan2(this.dirY, this.dirX) + Math.PI / 2, 6, dt);
    }
    if (this.kind === 'core') {
      const spin = obj.getObjectByName('spin');
      if (spin) spin.rotation.z += dt * (this.shielded ? 0.6 : 2.2);
      const crystal = obj.getObjectByName('crystal');
      if (crystal) {
        crystal.rotation.x += dt * 0.7;
        crystal.rotation.y += dt * 0.5;
        crystal.scale.setScalar(1 + Math.sin(this.age * (this.shielded ? 3 : 7)) * 0.06);
      }
      const shield = obj.getObjectByName('shield');
      if (shield) {
        shield.visible = this.shielded;
        this.shieldFlash = Math.max(0, this.shieldFlash - dt);
        shield.scale.setScalar(1 + Math.sin(this.age * 2.4) * 0.03 + this.shieldFlash * 0.5);
      }
    }
    if (this.kind === 'swooper') {
      const t = this.travelled / (2 * Math.abs(this.startX) || 1);
      obj.rotation.z = Math.sign(this.startX) * Math.cos(Math.min(t, 1) * Math.PI) * -0.6;
    }

    // A locked-on diver blinks as a warning before it dashes.
    const warning = this.kind === 'diver' && this.motion === 'aim' && Math.floor(this.hoverTime * 12) % 2 === 0;
    if (this.flashTimer > 0) this.flashTimer -= dt;
    const flashing = this.flashTimer > 0 || warning;
    this.model.flashMaterials.forEach((m, i) => {
      m.emissive.setHex(flashing ? (warning && this.flashTimer <= 0 ? 0x57ff9a : 0xffffff) : this.baseEmissive[i]!);
    });
  }

  private nextFireDelay(difficulty: number): number {
    const [min, max] = ENEMY_STATS[this.kind].fireInterval;
    return randFloat(this.rng, min, max) * MathUtils.lerp(1, 0.55, difficulty);
  }
}
