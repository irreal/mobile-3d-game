import { AdditiveBlending, MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { CockpitOverlay, LockMarker } from '../ui/CockpitOverlay.ts';
import { COCKPIT } from './constants.ts';
import type { Effects } from './Effects.ts';
import { ENEMY_STATS } from './Enemy.ts';
import type { EnemyKind } from './Enemy.ts';
import { disposeModel, sharedGeometries } from './models.ts';
import type { Model } from './models.ts';

/** Anything that can be locked onto: squadron fighters and their plasma orbs. */
interface Lockable {
  position: Vector3;
  radius: number;
  hp: number;
  /** Locks painted but not fired yet. */
  locks: number;
  /** Rockets in flight toward this target. */
  incoming: number;
  lastLockTime: number;
  alive: boolean;
}

interface Fighter extends Lockable {
  kind: EnemyKind;
  model: Model;
  baseEmissive: number[];
  start: Vector3;
  hover: Vector3;
  /** Seconds before it starts flying in. */
  delay: number;
  age: number;
  phase: number;
  fireTimer: number;
  flash: number;
}

interface Orb extends Lockable {
  mesh: Mesh;
  velocity: Vector3;
  age: number;
}

interface Rocket {
  mesh: Mesh;
  velocity: Vector3;
  target: Lockable | null;
  age: number;
  volley: Volley;
}

interface Volley {
  kills: number;
}

export type SectionStatus = 'running' | 'cleared' | 'escaped';

export interface CockpitFrame {
  camera: PerspectiveCamera;
  /** Unshaken eye position; orbs aim here. */
  eye: Vector3;
  /** True once the camera has fully arrived in the cockpit. */
  active: boolean;
  pointerDown: boolean;
  pointerX: number;
  pointerY: number;
  widthPx: number;
  heightPx: number;
}

export interface CockpitCallbacks {
  addScore: (points: number) => void;
  playerHit: () => void;
}

const COCKPIT_SCORE: Record<EnemyKind, number> = { grunt: 200, weaver: 250, tank: 1200 };
const FIGHTER_HP: Record<EnemyKind, number> = { grunt: 1, weaver: 1, tank: 4 };
const FIGHTER_SCALE = 1.4;
const ORB_RADIUS = 0.32;
const ORB_COLORS = [0xff4f8b, 0xffffff];
const EXPLOSION_COLORS: Record<EnemyKind, readonly number[]> = {
  grunt: [0x57e389, 0xc04dff, 0xffffff, 0xffa040],
  weaver: [0xffb443, 0xff5a36, 0xffffff],
  tank: [0x9b5cff, 0xffe14d, 0xff5a36, 0xffffff],
};
const UP = new Vector3(0, 1, 0);
const tmp = new Vector3();
const tmp2 = new Vector3();

/**
 * First-person "strike" fight between waves: a squadron flies in ahead of the ship.
 * The player swipes across targets to paint locks (several per heavy target), then lifts
 * the finger to launch homing rockets at everything locked. Kills in the same volley
 * chain for a score multiplier. Enemy plasma orbs fly at the cockpit and can be locked
 * and shot down too.
 */
export class CockpitSection {
  private readonly fighters: Fighter[] = [];
  private readonly orbs: Orb[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly launchQueue: { target: Lockable; volley: Volley }[] = [];
  private readonly markers: LockMarker[] = [];
  private readonly orbMaterial = new MeshBasicMaterial({
    color: 0xff4f8b,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  private readonly rocketMaterial = new MeshBasicMaterial({ color: 0xfff1c9 });

  private anchor = new Vector3();
  private wave = 1;
  private difficulty = 0;
  private time = 0;
  private activeTime = 0;
  private launchTimer = 0;
  private launchSide = 1;
  private fleeing = false;
  private totalLocks = 0;
  private running = false;

  constructor(
    private readonly scene: Scene,
    private readonly effects: Effects,
    private readonly overlay: CockpitOverlay,
    private readonly callbacks: CockpitCallbacks,
  ) {}

  get timeLeft(): number {
    return Math.max(0, COCKPIT.timeLimit - this.activeTime);
  }

  /** Spawns the squadron ahead of the ship at (`shipX`, `shipY`). */
  start(shipX: number, shipY: number, wave: number, difficulty: number, aspect: number): void {
    this.clear();
    this.running = true;
    this.anchor.set(shipX, shipY, 0);
    this.wave = wave;
    this.difficulty = difficulty;
    this.time = 0;
    this.activeTime = 0;
    this.fleeing = false;

    const kinds: EnemyKind[] = [];
    const small = Math.min(5 + wave * 2, 14);
    for (let i = 0; i < small; i++) kinds.push(i % 3 === 2 ? 'weaver' : 'grunt');
    const tanks = wave >= 4 ? 2 : wave >= 2 ? 1 : 0;
    for (let i = 0; i < tanks; i++) kinds.splice(MathUtils.randInt(0, kinds.length), 0, 'tank');

    const tanHalfFov = Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    kinds.forEach((kind, i) => {
      const depth = MathUtils.randFloat(15, 30);
      // Keep hover spots inside the view at that depth; portrait screens are narrow.
      const halfH = depth * tanHalfFov;
      const rangeX = Math.min(7, halfH * aspect * 0.7 - 1.5);
      const rangeZ = Math.min(5, halfH * 0.55 - 1);
      const hover = new Vector3(
        shipX + MathUtils.randFloatSpread(2 * Math.max(rangeX, 0.5)),
        shipY + depth,
        MathUtils.randFloatSpread(2 * Math.max(rangeZ, 0.5)) + 0.6,
      );
      const start = hover.clone().add(tmp.set(MathUtils.randFloatSpread(30), 70, MathUtils.randFloatSpread(20)));
      this.spawnFighter(kind, start, hover, i * 0.22);
    });
  }

  /** Launches rockets at everything locked (call on pointer release). */
  fire(): void {
    if (!this.running || this.totalLocks === 0) return;
    const volley: Volley = { kills: 0 };
    for (const target of this.lockables()) {
      for (let i = 0; i < target.locks; i++) this.launchQueue.push({ target, volley });
      target.incoming += target.locks;
      target.locks = 0;
    }
    this.totalLocks = 0;
  }

  /** Destroys all orbs in flight (used when the player takes a hit). */
  popOrbs(): void {
    for (const orb of this.orbs) {
      this.effects.explode(orb.position.x, orb.position.y, ORB_COLORS, 6, 4, 0.35, orb.position.z);
      this.removeMesh(orb.mesh);
    }
    this.orbs.length = 0;
  }

  update(dt: number, frame: CockpitFrame): SectionStatus {
    if (!this.running) return 'running';
    this.time += dt;
    if (frame.active) this.activeTime += dt;
    if (!this.fleeing && this.activeTime >= COCKPIT.timeLimit) this.flee();

    this.updateFighters(dt, frame);
    if (this.updateOrbs(dt, frame)) {
      // May end the game, which clears this section.
      this.callbacks.playerHit();
      if (!this.running) return 'running';
    }
    if (frame.active && frame.pointerDown && !this.fleeing) this.paintLocks(frame);
    this.updateLaunches(dt, frame);
    this.updateRockets(dt);
    this.updateOverlay(frame);

    if (this.fighters.length === 0 && this.launchQueue.length === 0) {
      this.running = false;
      return this.fleeing ? 'escaped' : 'cleared';
    }
    return 'running';
  }

  clear(): void {
    for (const f of this.fighters) this.removeFighterModel(f);
    for (const o of this.orbs) this.removeMesh(o.mesh);
    for (const r of this.rockets) this.removeMesh(r.mesh);
    this.fighters.length = 0;
    this.orbs.length = 0;
    this.rockets.length = 0;
    this.launchQueue.length = 0;
    this.totalLocks = 0;
    this.running = false;
    this.overlay.reset();
  }

  dispose(): void {
    this.clear();
    this.orbMaterial.dispose();
    this.rocketMaterial.dispose();
  }

  // --- Fighters and orbs -------------------------------------------------------------

  private spawnFighter(kind: EnemyKind, start: Vector3, hover: Vector3, delay: number): void {
    const model = ENEMY_STATS[kind].create();
    model.object.scale.setScalar(FIGHTER_SCALE);
    // Models are built facing +z (the top-down camera); turn them toward the cockpit.
    model.object.rotation.x = Math.PI / 2;
    model.object.position.copy(start);
    model.object.visible = false;
    this.scene.add(model.object);
    this.fighters.push({
      kind,
      model,
      baseEmissive: model.flashMaterials.map((m) => m.emissive.getHex()),
      position: model.object.position,
      radius: ENEMY_STATS[kind].radius * FIGHTER_SCALE,
      hp: FIGHTER_HP[kind],
      locks: 0,
      incoming: 0,
      lastLockTime: -Infinity,
      alive: true,
      start,
      hover,
      delay,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      fireTimer: MathUtils.randFloat(2.5, 4.5),
      flash: 0,
    });
  }

  private updateFighters(dt: number, frame: CockpitFrame): void {
    for (let i = this.fighters.length - 1; i >= 0; i--) {
      const f = this.fighters[i]!;
      if (this.time < f.delay) continue;
      f.age += dt;
      f.model.object.visible = true;

      if (this.fleeing) {
        f.position.y += (20 + f.age) * dt;
        f.position.z += 8 * dt;
        if (f.position.y > this.anchor.y + 90) {
          this.removeFighterModel(f);
          this.fighters.splice(i, 1);
          continue;
        }
      } else {
        const arrive = Math.min(1, f.age / 1.8);
        const eased = 1 - (1 - arrive) ** 3;
        const t = f.age * (f.kind === 'weaver' ? 1.6 : 0.9) + f.phase;
        tmp.set(Math.sin(t) * 1.6, Math.sin(t * 0.7) * 1.2, Math.cos(t) * 1.0);
        f.position.lerpVectors(f.start, f.hover, eased).addScaledVector(tmp, eased);

        if (frame.active && arrive >= 1) {
          f.fireTimer -= dt;
          if (f.fireTimer <= 0) {
            f.fireTimer = MathUtils.randFloat(3, 5) * MathUtils.lerp(1, 0.6, this.difficulty);
            this.fireOrbs(f, frame.eye);
          }
        }
      }

      const obj = f.model.object;
      if (f.kind === 'grunt') obj.rotation.y += dt * 2;
      else obj.rotation.y = Math.sin(f.age * 2 + f.phase) * 0.4;

      if (f.flash > 0) {
        f.flash -= dt;
        const on = f.flash > 0;
        f.model.flashMaterials.forEach((m, j) => m.emissive.setHex(on ? 0xffffff : f.baseEmissive[j]!));
      }
    }
  }

  private fireOrbs(f: Fighter, eye: Vector3): void {
    const speed = COCKPIT.orbSpeed + COCKPIT.orbSpeedPerWave * (this.wave - 1);
    const shots = f.kind === 'tank' ? 3 : 1;
    for (let s = 0; s < shots; s++) {
      tmp.copy(eye);
      if (s > 0) tmp.x += (s === 1 ? -1 : 1) * 2.5;
      const velocity = tmp.sub(f.position).normalize().multiplyScalar(speed).clone();
      const mesh = new Mesh(sharedGeometries.enemyBullet, this.orbMaterial);
      mesh.scale.setScalar(ORB_RADIUS / 0.22);
      mesh.position.copy(f.position);
      this.scene.add(mesh);
      this.orbs.push({
        mesh,
        position: mesh.position,
        velocity,
        radius: ORB_RADIUS,
        hp: 1,
        locks: 0,
        incoming: 0,
        lastLockTime: -Infinity,
        alive: true,
        age: 0,
      });
    }
  }

  /** Moves orbs; returns true if one reached the cockpit. */
  private updateOrbs(dt: number, frame: CockpitFrame): boolean {
    let hit = false;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i]!;
      orb.age += dt;
      orb.position.addScaledVector(orb.velocity, dt);
      orb.mesh.scale.setScalar((ORB_RADIUS / 0.22) * (1 + Math.sin(orb.age * 16) * 0.12));

      const reachedCockpit = orb.position.distanceTo(frame.eye) < 1.1;
      const passed = orb.position.y < frame.eye.y - 2;
      hit ||= reachedCockpit;
      if (reachedCockpit || passed) {
        orb.alive = false;
        this.removeMesh(orb.mesh);
        this.orbs.splice(i, 1);
      }
    }
    return hit;
  }

  private flee(): void {
    this.fleeing = true;
    this.launchQueue.length = 0;
    for (const target of this.lockables()) target.locks = 0;
    this.totalLocks = 0;
    this.overlay.showCallout('THEY GOT AWAY', 1.5);
  }

  // --- Locking and rockets -------------------------------------------------------------

  private *lockables(): Generator<Lockable> {
    for (const f of this.fighters) if (f.alive && f.age > 0.6) yield f;
    for (const o of this.orbs) if (o.alive) yield o;
  }

  private paintLocks(frame: CockpitFrame): void {
    for (const target of this.lockables()) {
      if (this.totalLocks >= COCKPIT.maxLocks) return;
      if (target.locks + target.incoming >= target.hp) continue;
      if (this.time - target.lastLockTime < COCKPIT.relockDelay) continue;
      const screen = this.project(target, frame);
      if (!screen) continue;
      const dx = screen.x - frame.pointerX;
      const dy = screen.y - frame.pointerY;
      const r = Math.max(screen.r, COCKPIT.minLockRadiusPx);
      if (dx * dx + dy * dy > r * r) continue;
      target.locks++;
      target.lastLockTime = this.time;
      this.totalLocks++;
      navigator.vibrate?.(8);
    }
  }

  private updateLaunches(dt: number, frame: CockpitFrame): void {
    this.launchTimer -= dt;
    while (this.launchQueue.length > 0 && this.launchTimer <= 0) {
      this.launchTimer += 0.05;
      const { target, volley } = this.launchQueue.shift()!;
      this.launchSide = -this.launchSide;
      const mesh = new Mesh(sharedGeometries.rocket, this.rocketMaterial);
      mesh.position.set(frame.eye.x + this.launchSide * 1.3, frame.eye.y + 0.6, frame.eye.z - 0.6);
      this.scene.add(mesh);
      this.rockets.push({
        mesh,
        velocity: new Vector3(this.launchSide * 7, 8, MathUtils.randFloat(2, 5)),
        target,
        age: 0,
        volley,
      });
    }
    if (this.launchQueue.length === 0) this.launchTimer = Math.max(this.launchTimer, 0);
  }

  private updateRockets(dt: number): void {
    const steer = 1 - Math.exp(-7 * dt);
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]!;
      r.age += dt;
      const pos = r.mesh.position;

      if (r.target && !r.target.alive) r.target = this.retarget(pos);
      if (r.target) {
        const speed = Math.min(COCKPIT.rocketSpeed, 12 + r.age * 70);
        tmp.subVectors(r.target.position, pos).normalize().multiplyScalar(speed);
        r.velocity.lerp(tmp, steer);
      }
      pos.addScaledVector(r.velocity, dt);
      r.mesh.quaternion.setFromUnitVectors(UP, tmp2.copy(r.velocity).normalize());
      this.effects.trail(pos.x, pos.y, pos.z, r.age < 0.15 ? 0xffffff : 0xffa040);

      if (r.target && pos.distanceTo(r.target.position) < r.target.radius + 0.4) {
        this.hitTarget(r.target, r.volley);
        this.removeMesh(r.mesh);
        this.rockets.splice(i, 1);
      } else if (r.age > 3) {
        if (r.target) r.target.incoming = Math.max(0, r.target.incoming - 1);
        this.removeMesh(r.mesh);
        this.rockets.splice(i, 1);
      }
    }
  }

  /** Rockets whose target already died pick the nearest living target that still needs hits. */
  private retarget(from: Vector3): Lockable | null {
    let best: Lockable | null = null;
    let bestDist = Infinity;
    for (const t of this.lockables()) {
      if (t.incoming >= t.hp) continue;
      const d = t.position.distanceToSquared(from);
      if (d < bestDist) {
        best = t;
        bestDist = d;
      }
    }
    if (best) best.incoming++;
    return best;
  }

  private hitTarget(target: Lockable, volley: Volley): void {
    target.hp--;
    target.incoming = Math.max(0, target.incoming - 1);
    const p = target.position;

    const fighter = this.fighters.find((f) => f === target);
    if (!fighter) {
      target.alive = false;
      this.effects.explode(p.x, p.y, ORB_COLORS, 10, 5, 0.4, p.z);
      this.callbacks.addScore(50);
      const index = this.orbs.findIndex((o) => o === target);
      if (index >= 0) {
        this.removeMesh(this.orbs[index]!.mesh);
        this.orbs.splice(index, 1);
      }
      return;
    }

    if (target.hp > 0) {
      fighter.flash = 0.08;
      this.effects.explode(p.x, p.y, [0xffffff, 0xffa040], 8, 5, 0.3, p.z);
      return;
    }

    target.alive = false;
    volley.kills++;
    const chain = volley.kills;
    this.callbacks.addScore(COCKPIT_SCORE[fighter.kind] * chain);
    if (chain >= 2) this.overlay.showCallout(`${chain}× CHAIN`);
    const big = fighter.kind === 'tank';
    this.effects.explode(p.x, p.y, EXPLOSION_COLORS[fighter.kind], big ? 70 : 28, big ? 12 : 8, big ? 1 : 0.7, p.z);
    navigator.vibrate?.(big ? 40 : 15);
    this.removeFighterModel(fighter);
    this.fighters.splice(this.fighters.indexOf(fighter), 1);
  }

  // --- Presentation ----------------------------------------------------------------------

  private project(target: Lockable, frame: CockpitFrame): { x: number; y: number; r: number } | null {
    const cam = frame.camera;
    tmp.copy(target.position).project(cam);
    if (tmp.z < -1 || tmp.z > 1 || Math.abs(tmp.x) > 1.2 || Math.abs(tmp.y) > 1.2) return null;
    const distance = cam.position.distanceTo(target.position);
    const pxPerUnit = frame.heightPx / 2 / (distance * Math.tan(MathUtils.degToRad(cam.fov / 2)));
    return {
      x: ((tmp.x + 1) / 2) * frame.widthPx,
      y: ((1 - tmp.y) / 2) * frame.heightPx,
      r: target.radius * pxPerUnit,
    };
  }

  private updateOverlay(frame: CockpitFrame): void {
    this.markers.length = 0;
    for (const target of this.lockables()) {
      const count = target.locks + target.incoming;
      if (count === 0) continue;
      const screen = this.project(target, frame);
      if (!screen) continue;
      this.markers.push({ x: screen.x, y: screen.y, count, size: Math.max(screen.r * 1.15, 22) });
    }
    this.overlay.setLocks(this.markers, this.totalLocks, COCKPIT.maxLocks);
    this.overlay.setTimer(this.timeLeft / COCKPIT.timeLimit);
    this.overlay.setBrush(frame.active && frame.pointerDown ? frame.pointerX : null, frame.pointerY);
    this.overlay.setHintVisible(frame.active && this.activeTime < 4 && this.wave <= 2);
  }

  private removeFighterModel(f: Fighter): void {
    this.scene.remove(f.model.object);
    disposeModel(f.model);
  }

  private removeMesh(mesh: Mesh): void {
    this.scene.remove(mesh);
  }
}
