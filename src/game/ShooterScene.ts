import {
  AdditiveBlending,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  MeshBasicMaterial,
  PointLight,
  Scene,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { GameScene } from '../core/Engine.ts';
import type { Input, Vec2 } from '../input/Input.ts';
import type { Hud } from '../ui/Hud.ts';
import {
  DIFFICULTY_RAMP_TIME,
  ENEMY_BULLET,
  GAME_TITLE,
  HISCORE_STORAGE_KEY,
  PLAYER,
  POWERUP,
} from './constants.ts';
import { Effects } from './Effects.ts';
import { Enemy } from './Enemy.ts';
import type { EnemyContext, EnemyKind } from './Enemy.ts';
import { InstancedPool } from './InstancedPool.ts';
import { createPowerup, disposeModel, sharedGeometries } from './models.ts';
import type { Model } from './models.ts';
import { Playfield } from './Playfield.ts';
import { PlayerShip } from './PlayerShip.ts';
import { Starfield } from './Starfield.ts';
import { WaveSpawner } from './WaveSpawner.ts';

type State = 'title' | 'playing' | 'gameover';

interface Powerup {
  model: Model;
  x: number;
  y: number;
}

const ENEMY_COLORS: Record<EnemyKind, readonly number[]> = {
  grunt: [0x57e389, 0xc04dff, 0xffffff],
  weaver: [0xffb443, 0xff5a36, 0xffffff],
  tank: [0x9b5cff, 0xffe14d, 0xff5a36, 0xffffff],
};
const PLAYER_COLORS = [0xdfe7ff, 0x3b7bff, 0xff6a3d, 0xffa040];

/** Offsets and angles (degrees) of the player's shots per weapon level. */
const WEAPON_PATTERNS: readonly (readonly [number, number])[][] = [
  [],
  [
    [-0.3, 0],
    [0.3, 0],
  ],
  [
    [-0.3, 0],
    [0.3, 0],
    [-0.6, 9],
    [0.6, -9],
  ],
  [
    [0, 0],
    [-0.35, 0],
    [0.35, 0],
    [-0.6, 8],
    [0.6, -8],
    [-0.8, 16],
    [0.8, -16],
  ],
];

const GAMEOVER_INPUT_DELAY = 1.2;

export class ShooterScene implements GameScene {
  readonly scene = new Scene();

  private readonly playfield = new Playfield();
  private readonly starfield = new Starfield();
  private readonly effects = new Effects();
  private readonly spawner = new WaveSpawner();
  private readonly player = new PlayerShip();
  private readonly playerBullets = new InstancedPool(
    sharedGeometries.playerBullet,
    new MeshBasicMaterial({ color: 0x7ff6ff, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    160,
  );
  private readonly enemyBullets = new InstancedPool(
    sharedGeometries.enemyBullet,
    new MeshBasicMaterial({ color: 0xff4f8b, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    400,
  );
  private readonly enemies: Enemy[] = [];
  private readonly powerups: Powerup[] = [];
  private readonly drag: Vec2 = { x: 0, y: 0 };
  private readonly unsubscribeTap: () => void;
  private readonly enemyContext: EnemyContext;

  private state: State = 'title';
  private stateTime = 0;
  private time = 0;
  private score = 0;
  private hiScore = loadHiScore();
  private lives: number = PLAYER.lives;
  private weaponLevel = 1;
  private fireTimer = 0;
  private invulnerable = 0;
  private shake = 0;
  private gameOverShown = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: Input,
    private readonly hud: Hud,
  ) {
    this.scene.background = new Color(0x05060f);
    this.scene.add(new HemisphereLight(0xb8c8ff, 0x1a1030, 1.4));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 10);
    this.scene.add(key);
    const engineGlow = new PointLight(0xff8a3d, 6, 6, 1.5);
    engineGlow.position.set(0, -1.4, 0.8);
    this.player.object.add(engineGlow);

    for (const layer of this.starfield.layers) this.scene.add(layer.points);
    this.scene.add(this.player.object, this.playerBullets.mesh, this.enemyBullets.mesh, this.effects.particles.mesh);

    this.enemyContext = {
      playerX: 0,
      playerY: 0,
      top: 0,
      halfWidth: 0,
      difficulty: 0,
      bulletSpeed: ENEMY_BULLET.speedMin,
      fire: (x, y, vx, vy) => this.enemyBullets.spawn(x, y, vx, vy, ENEMY_BULLET.radius),
    };

    this.unsubscribeTap = input.onTap(this.handleTap);
    this.enterTitle();
  }

  resize(width: number, height: number): void {
    this.playfield.fit(this.camera, width, height);
    if (this.state !== 'playing') this.placePlayerAtStart();
    else this.clampPlayer();
  }

  update(dt: number): void {
    this.stateTime += dt;
    this.input.update();

    const playing = this.state === 'playing';
    if (playing) {
      this.time += dt;
      this.updatePlayer(dt);
      const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
      this.spawner.update(dt, this.time, difficulty, this.playfield.halfWidth, this.spawnEnemy);
    } else {
      this.input.consumeDrag(this.drag);
      if (this.state === 'gameover' && !this.gameOverShown && this.stateTime > GAMEOVER_INPUT_DELAY) {
        this.showGameOverMessage();
      }
      if (this.state === 'title') this.player.y = this.startY() + Math.sin(this.stateTime * 2) * 0.25;
    }

    this.updateEnemies(dt);
    this.updateBullets(dt);
    this.updatePowerups(dt);
    if (playing) this.checkCollisions();

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.player.sync(dt, this.invulnerable);
    this.effects.update(dt);
    this.starfield.update(dt, playing ? 14 : 5);
    this.playerBullets.sync();
    this.enemyBullets.sync();
    this.updateCamera(dt);
    this.updateHud();
  }

  dispose(): void {
    this.unsubscribeTap();
    this.clearWorld();
    this.starfield.dispose();
    this.playerBullets.dispose();
    this.enemyBullets.dispose();
    this.effects.particles.dispose();
    disposeModel(this.player.model);
  }

  // --- State transitions -------------------------------------------------------------

  private readonly handleTap = (): void => {
    if (this.state === 'title') this.startGame();
    else if (this.state === 'gameover' && this.stateTime > GAMEOVER_INPUT_DELAY) this.startGame();
  };

  private enterTitle(): void {
    this.state = 'title';
    this.stateTime = 0;
    this.player.object.visible = true;
    this.placePlayerAtStart();
    this.hud.showMessage(GAME_TITLE, isTouchDevice() ? 'Tap to start' : 'Click or press Space to start');
  }

  private startGame(): void {
    this.clearWorld();
    this.state = 'playing';
    this.stateTime = 0;
    this.time = 0;
    this.score = 0;
    this.lives = PLAYER.lives;
    this.weaponLevel = 1;
    this.fireTimer = 0;
    this.invulnerable = 1;
    this.spawner.reset();
    this.placePlayerAtStart();
    this.input.consumeDrag(this.drag);
    this.hud.hideMessage();
  }

  private gameOver(): void {
    this.state = 'gameover';
    this.stateTime = 0;
    this.player.object.visible = false;
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(this.hiScore);
    }
    this.gameOverShown = false;
  }

  private showGameOverMessage(): void {
    this.gameOverShown = true;
    const action = isTouchDevice() ? 'Tap to retry' : 'Click or press Space to retry';
    const best = this.score >= this.hiScore && this.score > 0 ? 'New high score!\n' : '';
    this.hud.showMessage('GAME OVER', `${best}Score ${this.score.toLocaleString('en-US')}\n${action}`);
  }

  private clearWorld(): void {
    for (const e of this.enemies) this.removeEnemyObject(e);
    this.enemies.length = 0;
    for (const p of this.powerups) this.removePowerupObject(p);
    this.powerups.length = 0;
    this.playerBullets.clear();
    this.enemyBullets.clear();
    this.effects.clear();
  }

  // --- Player --------------------------------------------------------------------------

  private startY(): number {
    return this.playfield.bottom + Math.min(4, this.playfield.visibleHalfHeight * 0.3);
  }

  private placePlayerAtStart(): void {
    this.player.place(0, this.startY());
  }

  private clampPlayer(): void {
    const pf = this.playfield;
    const marginX = 1.1;
    this.player.x = MathUtils.clamp(this.player.x, -pf.halfWidth + marginX, pf.halfWidth - marginX);
    this.player.y = MathUtils.clamp(this.player.y, pf.bottom + 1.2, pf.top - 2.5);
  }

  private updatePlayer(dt: number): void {
    const drag = this.input.consumeDrag(this.drag);
    const scale = this.playfield.worldPerPixel * PLAYER.dragSensitivity;
    this.player.x += drag.x * scale + this.input.axis.x * PLAYER.keyboardSpeed * dt;
    this.player.y += drag.y * scale + this.input.axis.y * PLAYER.keyboardSpeed * dt;
    this.clampPlayer();

    // Auto-fire: mobile players need both thumbs free for steering.
    this.fireTimer -= dt;
    while (this.fireTimer <= 0) {
      this.fireTimer += PLAYER.fireInterval;
      this.fire();
    }
  }

  private fire(): void {
    const pattern = WEAPON_PATTERNS[this.weaponLevel]!;
    const y = this.player.y + 0.9;
    for (const [dx, deg] of pattern) {
      const a = MathUtils.degToRad(90 + deg);
      const b = this.playerBullets.spawn(
        this.player.x + dx,
        y,
        Math.cos(a) * PLAYER.bulletSpeed,
        Math.sin(a) * PLAYER.bulletSpeed,
        0.3,
      );
      if (b) b.rotation = MathUtils.degToRad(deg);
    }
  }

  private damagePlayer(): void {
    if (this.invulnerable > 0) return;
    const { x, y } = this.player;
    this.lives--;
    this.effects.explode(x, y, PLAYER_COLORS, 40, 12, 0.9);
    this.shake = 0.6;
    navigator.vibrate?.(this.lives > 0 ? 80 : 250);

    // Clearing enemy fire on hit gives the player a moment to recover.
    for (let i = 0; i < this.enemyBullets.count; i++) {
      const b = this.enemyBullets.items[i]!;
      this.effects.explode(b.x, b.y, [0xff4f8b], 2, 3, 0.3);
    }
    this.enemyBullets.clear();

    if (this.lives <= 0) {
      this.gameOver();
      return;
    }
    this.weaponLevel = Math.max(1, this.weaponLevel - 1);
    this.invulnerable = PLAYER.invulnerableTime;
  }

  // --- Enemies, bullets, power-ups -----------------------------------------------------

  private readonly spawnEnemy = (kind: EnemyKind, x: number, yOffset: number, phase: number): void => {
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
    const enemy = new Enemy(kind, x, this.playfield.top + 2 + yOffset, phase, difficulty);
    this.enemies.push(enemy);
    this.scene.add(enemy.object);
  };

  private updateEnemies(dt: number): void {
    const ctx = this.enemyContext;
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
    ctx.playerX = this.player.x;
    ctx.playerY = this.state === 'playing' ? this.player.y : this.playfield.bottom - 10;
    ctx.top = this.playfield.top;
    ctx.halfWidth = this.playfield.halfWidth;
    ctx.difficulty = difficulty;
    ctx.bulletSpeed = MathUtils.lerp(ENEMY_BULLET.speedMin, ENEMY_BULLET.speedMax, difficulty);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (!enemy.update(dt, ctx)) this.removeEnemyAt(i);
    }
  }

  private updateBullets(dt: number): void {
    const pf = this.playfield;
    this.playerBullets.update(dt, (b) => !pf.isOutside(b.x, b.y, 1));
    this.enemyBullets.update(dt, (b) => {
      b.scale = 1 + Math.sin(b.age * 18) * 0.15;
      return !pf.isOutside(b.x, b.y, 1);
    });
  }

  private updatePowerups(dt: number): void {
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i]!;
      p.y -= POWERUP.fallSpeed * dt;
      p.model.object.position.set(p.x, p.y, 0);
      p.model.object.rotation.y += dt * 3;
      p.model.object.rotation.x += dt * 1.3;
      if (p.y < this.playfield.bottom - 2) {
        this.removePowerupObject(p);
        this.powerups.splice(i, 1);
      }
    }
  }

  private checkCollisions(): void {
    const px = this.player.x;
    const py = this.player.y;

    // Player bullets vs enemies.
    for (let i = this.playerBullets.count - 1; i >= 0; i--) {
      const b = this.playerBullets.items[i]!;
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j]!;
        if (!circlesOverlap(b.x, b.y, b.radius, e.x, e.y, e.radius)) continue;
        this.playerBullets.remove(i);
        this.effects.explode(b.x, b.y + 0.3, [0x7ff6ff, 0xffffff], 3, 5, 0.25);
        if (e.hit(1)) this.killEnemy(j);
        break;
      }
    }

    // Enemy bullets vs player.
    for (let i = this.enemyBullets.count - 1; i >= 0; i--) {
      const b = this.enemyBullets.items[i]!;
      if (circlesOverlap(b.x, b.y, b.radius, px, py, PLAYER.hitRadius)) {
        this.damagePlayer();
        if (this.state !== 'playing') return;
        break;
      }
    }

    // Enemies ramming the player.
    for (let j = this.enemies.length - 1; j >= 0; j--) {
      const e = this.enemies[j]!;
      if (!circlesOverlap(e.x, e.y, e.radius * 0.8, px, py, PLAYER.hitRadius)) continue;
      if (this.invulnerable > 0) continue;
      if (e.hit(6)) this.killEnemy(j);
      this.damagePlayer();
      if (this.state !== 'playing') return;
    }

    // Power-up pickup.
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i]!;
      if (!circlesOverlap(p.x, p.y, 0.45, px, py, PLAYER.pickupRadius)) continue;
      if (this.weaponLevel < PLAYER.maxWeaponLevel) this.weaponLevel++;
      else this.score += POWERUP.maxedScore;
      this.effects.explode(p.x, p.y, [0x5dff9e, 0xffffff], 16, 6, 0.4);
      navigator.vibrate?.(20);
      this.removePowerupObject(p);
      this.powerups.splice(i, 1);
    }
  }

  private killEnemy(index: number): void {
    const e = this.enemies[index]!;
    this.score += e.score;
    const big = e.kind === 'tank';
    this.effects.explode(e.x, e.y, ENEMY_COLORS[e.kind], big ? 60 : 18, big ? 11 : 8, big ? 0.9 : 0.55);
    if (big) this.shake = Math.max(this.shake, 0.35);
    if (big || Math.random() < POWERUP.dropChance) this.spawnPowerup(e.x, e.y);
    this.removeEnemyAt(index);
  }

  private removeEnemyAt(index: number): void {
    const e = this.enemies[index]!;
    this.removeEnemyObject(e);
    this.enemies[index] = this.enemies[this.enemies.length - 1]!;
    this.enemies.pop();
  }

  private removeEnemyObject(e: Enemy): void {
    this.scene.remove(e.object);
    e.dispose();
  }

  private spawnPowerup(x: number, y: number): void {
    const model = createPowerup();
    model.object.position.set(x, y, 0);
    this.scene.add(model.object);
    this.powerups.push({ model, x, y });
  }

  private removePowerupObject(p: Powerup): void {
    this.scene.remove(p.model.object);
    disposeModel(p.model);
  }

  // --- Presentation ----------------------------------------------------------------------

  private updateCamera(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 1.5);
    const s = this.shake * this.shake;
    this.camera.position.set(
      (Math.random() - 0.5) * s * 1.2,
      (Math.random() - 0.5) * s * 1.2,
      this.playfield.cameraDistance,
    );
  }

  private updateHud(): void {
    this.hud.setScore(this.score);
    this.hud.setHiScore(Math.max(this.hiScore, this.score));
    this.hud.setLives(this.state === 'title' ? PLAYER.lives : this.lives);
    this.hud.setWeaponLevel(this.weaponLevel, PLAYER.maxWeaponLevel);
  }
}

function circlesOverlap(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy < r * r;
}

function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

function loadHiScore(): number {
  try {
    return Number(localStorage.getItem(HISCORE_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveHiScore(score: number): void {
  try {
    localStorage.setItem(HISCORE_STORAGE_KEY, String(score));
  } catch {
    // Storage can be unavailable (private mode, quota); the high score just won't persist.
  }
}
