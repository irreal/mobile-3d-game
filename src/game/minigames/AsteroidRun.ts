import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  TorusGeometry,
  Vector3,
} from 'three';
import type { Scene } from 'three';
import type { Sfx } from '../../audio/Sfx.ts';
import type { CockpitOverlay, Grade } from '../../ui/CockpitOverlay.ts';
import { COCKPIT } from '../constants.ts';
import type { Effects } from '../Effects.ts';
import type { MiniGame, MiniGameCallbacks, MiniGameContext, MiniGameFrame, MiniGameStatus } from './MiniGame.ts';

interface Rock {
  mesh: Mesh;
  x: number;
  z: number;
  depth: number;
  radius: number;
  spin: Vector3;
  resolved: boolean;
}

interface Ring {
  mesh: Mesh;
  x: number;
  z: number;
  depth: number;
  resolved: boolean;
}

/** How far the ship can steer from the centre line (field units, sideways and up/down). */
const STEER_X = 5;
const STEER_Z = 3.2;
const SHIP_RADIUS = 0.55;
/** Passing a rock within this much of its surface is a close call. */
const NEAR_MISS = 1.3;
const RING_RADIUS = 1.35;
const SPAWN_DEPTH = 110;
/** Rocks and rings grow in over this distance after spawning. */
const GROW_DEPTH = 18;
/** Wall gaps (and their ring) have this radius. */
const GAP_RADIUS = 2.5;
const DUST = 420;
const MAX_BANK = 0.18;
/** Field units per CSS pixel of drag, as a fraction of screen width. */
const DRAG_UNITS_PER_WIDTH = 16;
const KEY_SPEED = 9;
const HIT_GRACE = 1.2;
const RING_SCORE = 150;
const CLOSE_SCORE = 100;
const ROCK_COLORS = [0xa89580, 0x8a827a, 0xb49c80, 0x7a7478];
const DEBRIS_COLORS = [0xb8a48c, 0x6e6660, 0xffd08a];

const rockGeometries = Array.from({ length: 5 }, (_, i) => lumpyRock(i * 1.7 + 0.3));
const ringGeometry = new TorusGeometry(RING_RADIUS, 0.11, 8, 36).rotateX(Math.PI / 2);
const tmp = new Vector3();

/**
 * First-person asteroid field between waves: drag (or use the arrow keys) to steer the ship
 * through scattered rocks, walls with one gap and big boulders, and fly through glowing
 * rings for points and combo. Hits drain the shield, then lives. The field rushes toward
 * the cockpit and banks as you steer; the crosshair is the ship's centre.
 */
export class AsteroidRun implements MiniGame {
  private readonly root = new Group();
  private readonly field = new Group();
  private readonly rocks: Rock[] = [];
  private readonly rings: Ring[] = [];
  private readonly rockMaterials = ROCK_COLORS.map(
    (color) => new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.05, flatShading: true, emissive: 0x2a2018 }),
  );
  private readonly ringMaterial = new MeshBasicMaterial({
    color: new Color(0x6ff3ff).multiplyScalar(1.6),
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  private readonly dust: Points;
  private readonly dustPositions = new Float32Array(DUST * 3);

  private running = false;
  private active = false;
  private round = 1;
  private duration = 30;
  private elapsed = 0;
  private spawnTimer = 0;
  private started = false;
  private sx = 0;
  private sz = 0;
  private targetX = 0;
  private targetZ = 0;
  private bankAngle = 0;
  private shield: number = COCKPIT.shield;
  private grace = 0;
  private ringsTotal = 0;
  private ringsHit = 0;
  private closeCalls = 0;
  private hits = 0;
  private widthPx = 1;
  private heightPx = 1;
  private lastFrame: MiniGameFrame | null = null;
  combo = 0;
  maxCombo = 0;

  constructor(
    private readonly scene: Scene,
    private readonly effects: Effects,
    private readonly overlay: CockpitOverlay,
    private readonly sfx: Sfx,
    private readonly callbacks: MiniGameCallbacks,
  ) {
    for (let i = 0; i < DUST; i++) this.placeDust(i, Math.random() * SPAWN_DEPTH);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.dustPositions, 3));
    this.dust = new Points(
      geometry,
      new PointsMaterial({ color: 0xbcc8ff, size: 0.09, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }),
    );
    this.dust.frustumCulled = false;
    this.field.add(this.dust);
    this.root.add(this.field);
    this.root.visible = false;
    scene.add(this.root);
  }

  /** Rings flown through this run (1 when there were none). */
  get accuracy(): number {
    return this.ringsTotal > 0 ? this.ringsHit / this.ringsTotal : 1;
  }

  private get multiplier(): number {
    return 1 + Math.floor(this.combo / COCKPIT.comboStep) * 0.5;
  }

  start({ strike }: MiniGameContext): void {
    this.clear();
    this.running = true;
    this.round = Math.max(1, Math.ceil(strike / 2));
    this.duration = 30 + 5 * (this.round - 1);
    this.shield = COCKPIT.shield;
    this.root.visible = true;
    this.overlay.setMode('asteroids');
  }

  tap(): void {}
  drag(): void {}
  release(): void {}
  clearIncoming(): void {}
  onResume(): void {}

  update(dt: number, frame: MiniGameFrame): MiniGameStatus {
    if (!this.running) return 'running';
    this.lastFrame = frame;
    this.active = frame.active;
    this.widthPx = frame.widthPx;
    this.heightPx = frame.heightPx;
    this.root.position.copy(frame.eye);

    if (this.active) {
      if (!this.started) {
        this.started = true;
        this.overlay.showCallout('ASTEROID FIELD', 1.6);
      }
      this.elapsed += dt;
      this.grace = Math.max(0, this.grace - dt);
      this.steer(dt, frame);
      this.spawn(dt);
    }
    this.advance(dt);
    // A final hit may end the game, which clears this run.
    if (!this.running) return 'running';
    this.updateOverlay();

    if (this.elapsed >= this.duration && this.rocks.length === 0 && this.rings.length === 0) {
      this.running = false;
      this.root.visible = false;
      return 'cleared';
    }
    return 'running';
  }

  result(): { title: string; stats: string } {
    const flawless = this.hits === 0 && this.ringsHit === this.ringsTotal;
    return {
      title: flawless ? 'FLAWLESS RUN!' : 'FIELD CLEARED',
      stats: `RINGS ${this.ringsHit}/${this.ringsTotal} · CLOSE CALLS ${this.closeCalls} · MAX COMBO ${this.maxCombo}`,
    };
  }

  clear(): void {
    for (const r of this.rocks) this.field.remove(r.mesh);
    for (const r of this.rings) this.field.remove(r.mesh);
    this.rocks.length = 0;
    this.rings.length = 0;
    this.running = false;
    this.active = false;
    this.started = false;
    this.elapsed = 0;
    this.spawnTimer = 1.2;
    this.sx = this.sz = this.targetX = this.targetZ = 0;
    this.bankAngle = 0;
    this.field.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.visible = false;
    this.grace = 0;
    this.ringsTotal = this.ringsHit = this.closeCalls = this.hits = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.overlay.reset();
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.root);
    for (const m of this.rockMaterials) m.dispose();
    this.ringMaterial.dispose();
    this.dust.geometry.dispose();
    (this.dust.material as PointsMaterial).dispose();
  }

  // --- Flight ----------------------------------------------------------------------------

  private get speed(): number {
    return 34 + 4 * (this.round - 1) + 10 * Math.min(1, this.elapsed / this.duration);
  }

  private steer(dt: number, frame: MiniGameFrame): void {
    const perPx = DRAG_UNITS_PER_WIDTH / Math.max(1, frame.widthPx);
    this.targetX = MathUtils.clamp(this.targetX + frame.drag.x * perPx + frame.axis.x * KEY_SPEED * dt, -STEER_X, STEER_X);
    this.targetZ = MathUtils.clamp(this.targetZ + frame.drag.y * perPx + frame.axis.y * KEY_SPEED * dt, -STEER_Z, STEER_Z);
    const prevX = this.sx;
    this.sx = MathUtils.damp(this.sx, this.targetX, 10, dt);
    this.sz = MathUtils.damp(this.sz, this.targetZ, 10, dt);
    const vx = dt > 0 ? (this.sx - prevX) / dt : 0;
    // Bank into the turn: rolling the field the other way reads as the ship rolling.
    this.bankAngle = MathUtils.damp(this.bankAngle, MathUtils.clamp(-vx * 0.03, -MAX_BANK, MAX_BANK), 6, dt);
    this.field.position.set(-this.sx, 0, -this.sz);
    this.root.rotation.y = this.bankAngle;
  }

  /** Moves everything toward the cockpit and resolves what passes the ship. */
  private advance(dt: number): void {
    const move = (this.active ? this.speed : 6) * dt;
    for (let i = 0; i < DUST; i++) {
      const y = this.dustPositions[i * 3 + 1]! - move;
      if (y < -2) this.placeDust(i, SPAWN_DEPTH + y);
      else this.dustPositions[i * 3 + 1] = y;
    }
    this.dust.geometry.attributes.position!.needsUpdate = true;

    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const r = this.rocks[i]!;
      r.depth -= move;
      r.mesh.position.set(r.x, r.depth, r.z);
      r.mesh.rotation.x += r.spin.x * dt;
      r.mesh.rotation.y += r.spin.y * dt;
      r.mesh.rotation.z += r.spin.z * dt;
      r.mesh.scale.setScalar(r.radius * MathUtils.smoothstep(SPAWN_DEPTH - r.depth, 0, GROW_DEPTH));
      if (!r.resolved && r.depth < r.radius * 0.4) {
        r.resolved = true;
        const destroyed = this.resolveRock(r);
        if (!this.running) return;
        if (destroyed) {
          this.field.remove(r.mesh);
          this.rocks.splice(i, 1);
          continue;
        }
      }
      if (r.depth < -r.radius - 4) {
        this.field.remove(r.mesh);
        this.rocks.splice(i, 1);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const g = this.rings[i]!;
      g.depth -= move;
      g.mesh.position.set(g.x, g.depth, g.z);
      g.mesh.rotation.y += dt * 1.5;
      g.mesh.scale.setScalar(MathUtils.smoothstep(SPAWN_DEPTH - g.depth, 0, GROW_DEPTH));
      if (!g.resolved && g.depth < 0.3) {
        g.resolved = true;
        if (this.resolveRing(g)) {
          this.field.remove(g.mesh);
          this.rings.splice(i, 1);
          continue;
        }
      }
      if (g.depth < -4) {
        this.field.remove(g.mesh);
        this.rings.splice(i, 1);
      }
    }
  }

  /** Returns true if the rock was destroyed (it hit the ship). */
  private resolveRock(r: Rock): boolean {
    const d = Math.hypot(r.x - this.sx, r.z - this.sz);
    if (d < r.radius * 0.85 + SHIP_RADIUS) {
      if (this.grace > 0) return false;
      this.hitShip(r);
      return true;
    }
    if (d < r.radius + SHIP_RADIUS + NEAR_MISS) {
      this.closeCalls++;
      this.bumpCombo();
      this.callbacks.addScore(Math.round(CLOSE_SCORE * this.multiplier));
      this.sfx.warpIn();
      this.popup('CLOSE!', 'great', r);
    }
    return false;
  }

  private resolveRing(g: Ring): boolean {
    this.ringsTotal++;
    if (Math.hypot(g.x - this.sx, g.z - this.sz) < RING_RADIUS - 0.15) {
      this.ringsHit++;
      this.bumpCombo();
      this.callbacks.addScore(Math.round(RING_SCORE * this.multiplier));
      this.sfx.noteHit(72 + (this.combo % 8) * 2, true);
      this.worldOf(g.x, g.depth, g.z);
      this.effects.ring(tmp.x, tmp.y, tmp.z, 0x6ff3ff, 3, 0.35, true);
      this.popup('RING', 'perfect', g);
      return true;
    }
    this.combo = 0;
    this.sfx.miss();
    return false;
  }

  private hitShip(r: Rock): void {
    this.hits++;
    this.combo = 0;
    this.grace = HIT_GRACE;
    // Burst a little ahead of the canopy so the debris reads as debris, not a white-out.
    this.worldOf(r.x, Math.max(r.depth, 7), r.z);
    this.effects.explode(tmp.x, tmp.y, DEBRIS_COLORS, 22, 5, 0.6, tmp.z);
    this.effects.flash(tmp.x, tmp.y, tmp.z, 0xfff1c9, 3, 0.3);
    this.callbacks.blast(tmp, 0.8);
    this.sfx.explosion('big');
    if (this.shield > 0) {
      this.shield--;
      this.sfx.shieldHit();
      this.overlay.hitFlash();
      this.overlay.showCallout(this.shield > 0 ? 'SHIELD HIT' : 'SHIELD DOWN', 0.9);
    } else {
      this.callbacks.playerHit();
    }
  }

  private bumpCombo(): void {
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
  }

  // --- Spawning --------------------------------------------------------------------------

  private spawn(dt: number): void {
    if (this.elapsed >= this.duration) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    const t = this.elapsed;
    const roll = Math.random();
    const pace = 1 - 0.08 * (this.round - 1);
    if (t > 5 && roll < 0.22 + 0.06 * this.round) {
      this.spawnWall();
      this.spawnTimer = 2.3 * pace;
    } else if (t > 9 && roll < 0.42 + 0.06 * this.round) {
      this.spawnBoulder();
      this.spawnTimer = 1.5 * pace;
    } else if (roll < 0.7) {
      this.spawnScatter(3 + this.round + Math.floor(t / 10));
      this.spawnTimer = 0.75 * pace;
    } else {
      this.spawnRingTrail();
      this.spawnTimer = 1.4 * pace;
    }
  }

  /** Loose rocks around where the ship is heading. */
  private spawnScatter(count: number): void {
    for (let i = 0; i < count; i++) {
      this.addRock(
        this.targetX + MathUtils.randFloatSpread(12),
        this.targetZ + MathUtils.randFloatSpread(8),
        SPAWN_DEPTH + MathUtils.randFloat(0, 14),
        MathUtils.randFloat(0.7, 1.8),
      );
    }
  }

  /** A wall of rocks across the whole flight box with one gap (and a ring in it). */
  private spawnWall(): void {
    const reach = 4;
    const gx = MathUtils.clamp(this.targetX + MathUtils.randFloatSpread(reach * 2), -STEER_X + 1, STEER_X - 1);
    const gz = MathUtils.clamp(this.targetZ + MathUtils.randFloatSpread(reach), -STEER_Z + 0.5, STEER_Z - 0.5);
    const step = 2.4;
    for (let x = -STEER_X - 3; x <= STEER_X + 3; x += step) {
      for (let z = -STEER_Z - 3; z <= STEER_Z + 3; z += step) {
        const rx = x + MathUtils.randFloatSpread(0.5);
        const rz = z + MathUtils.randFloatSpread(0.5);
        const radius = MathUtils.randFloat(1.1, 1.45);
        if (Math.hypot(rx - gx, rz - gz) < GAP_RADIUS + radius * 0.7) continue;
        this.addRock(rx, rz, SPAWN_DEPTH + MathUtils.randFloatSpread(1.5), radius);
      }
    }
    this.addRing(gx, gz, SPAWN_DEPTH);
  }

  /** One huge, slow-tumbling rock aimed where the ship is, flanked by rings. */
  private spawnBoulder(): void {
    const radius = MathUtils.randFloat(3, 3.8);
    const x = this.targetX + MathUtils.randFloatSpread(1);
    const z = this.targetZ + MathUtils.randFloatSpread(0.8);
    const rock = this.addRock(x, z, SPAWN_DEPTH + 8, radius);
    rock.spin.multiplyScalar(0.3);
    const side = x > 0 ? -1 : 1;
    const ringX = MathUtils.clamp(x + side * (radius + 2), -STEER_X, STEER_X);
    this.addRing(ringX, z, SPAWN_DEPTH + 8);
  }

  /** A curving trail of rings with a few rocks to weave past. */
  private spawnRingTrail(): void {
    const count = 4 + Math.min(2, this.round - 1);
    const x0 = MathUtils.clamp(this.targetX + MathUtils.randFloatSpread(6), -STEER_X, STEER_X);
    const z0 = MathUtils.clamp(this.targetZ + MathUtils.randFloatSpread(3), -STEER_Z, STEER_Z);
    const dx = MathUtils.randFloatSpread(1.8);
    const dz = MathUtils.randFloatSpread(1.2);
    for (let i = 0; i < count; i++) {
      const x = MathUtils.clamp(x0 + dx * i + Math.sin(i * 1.3) * 0.8, -STEER_X, STEER_X);
      const z = MathUtils.clamp(z0 + dz * i, -STEER_Z, STEER_Z);
      this.addRing(x, z, SPAWN_DEPTH + i * 10);
      if (i > 0 && Math.random() < 0.5 + 0.15 * this.round) {
        const off = Math.random() < 0.5 ? -1 : 1;
        this.addRock(x + off * MathUtils.randFloat(2.6, 3.4), z + MathUtils.randFloatSpread(2), SPAWN_DEPTH + i * 10 + 4, MathUtils.randFloat(0.8, 1.3));
      }
    }
  }

  private addRock(x: number, z: number, depth: number, radius: number): Rock {
    const mesh = new Mesh(
      rockGeometries[Math.floor(Math.random() * rockGeometries.length)]!,
      this.rockMaterials[Math.floor(Math.random() * this.rockMaterials.length)]!,
    );
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    mesh.scale.setScalar(0.001);
    this.field.add(mesh);
    const spin = new Vector3(MathUtils.randFloatSpread(2), MathUtils.randFloatSpread(2), MathUtils.randFloatSpread(2));
    const rock = { mesh, x, z, depth, radius, spin, resolved: false };
    this.rocks.push(rock);
    return rock;
  }

  private addRing(x: number, z: number, depth: number): void {
    const mesh = new Mesh(ringGeometry, this.ringMaterial);
    mesh.scale.setScalar(0.001);
    mesh.renderOrder = 2;
    this.field.add(mesh);
    this.rings.push({ mesh, x, z, depth, resolved: false });
  }

  private placeDust(i: number, depth: number): void {
    this.dustPositions[i * 3] = MathUtils.randFloatSpread(30);
    this.dustPositions[i * 3 + 1] = depth;
    this.dustPositions[i * 3 + 2] = MathUtils.randFloatSpread(20);
  }

  // --- Presentation ----------------------------------------------------------------------

  /** World position of field point (x, depth, z), into `tmp`. */
  private worldOf(x: number, depth: number, z: number): Vector3 {
    this.root.updateMatrixWorld();
    return this.field.localToWorld(tmp.set(x, depth, z));
  }

  private popup(text: string, grade: Grade, at: { x: number; z: number }): void {
    const camera = this.lastFrame?.camera;
    if (!camera) return;
    this.worldOf(at.x, 6, at.z).project(camera);
    const x = MathUtils.clamp(((tmp.x + 1) / 2) * this.widthPx, 60, this.widthPx - 60);
    const y = MathUtils.clamp(((1 - tmp.y) / 2) * this.heightPx, 80, this.heightPx - 120);
    this.overlay.judgement(text, grade, x, y);
  }

  private updateOverlay(): void {
    this.overlay.setCombo(this.combo, this.multiplier, false);
    this.overlay.setShield(this.shield, COCKPIT.shield);
    this.overlay.setTimer(1 - this.elapsed / this.duration);
    this.overlay.setHintVisible(this.active && this.round === 1 && this.elapsed < 7);
  }
}

/**
 * A unit lumpy rock: an icosphere pushed in and out by smooth bumps. The displacement depends
 * only on direction, so the (unindexed) faces stay sealed.
 */
function lumpyRock(seed: number): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const pos = geometry.attributes.position!;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const bump =
      1 +
      0.22 * Math.sin(v.x * 3.1 + seed) * Math.sin(v.y * 2.7 + seed * 2.1) * Math.sin(v.z * 3.4 + seed * 0.7) +
      0.1 * Math.sin(v.x * 7.3 + seed * 3) * Math.sin(v.z * 6.1 - seed);
    v.multiplyScalar(bump);
    v.y *= 0.85 + (seed % 1) * 0.2;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}
