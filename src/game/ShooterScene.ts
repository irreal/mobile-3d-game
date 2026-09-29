import {
  AdditiveBlending,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  MeshBasicMaterial,
  PointLight,
  Scene,
  Vector3,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { PostFx } from '../core/PostFx.ts';
import type { GameAudio } from '../audio/GameAudio.ts';
import { LOCK_ON, NOVA_DRIVE } from '../audio/songs.ts';
import type { GameScene } from '../core/Engine.ts';
import type { Input, Vec2 } from '../input/Input.ts';
import type { CockpitOverlay } from '../ui/CockpitOverlay.ts';
import type { Hud } from '../ui/Hud.ts';
import { PauseMenu } from '../ui/PauseMenu.ts';
import { TutorialOverlay } from '../ui/Tutorial.ts';
import { CameraDirector } from './CameraDirector.ts';
import { CockpitInterior } from './CockpitInterior.ts';
import { CockpitSection } from './CockpitSection.ts';
import type { SectionStatus } from './CockpitSection.ts';
import {
  COCKPIT,
  WAVES,
  DIFFICULTY_RAMP_TIME,
  ENEMY_BULLET,
  GAME_TITLE,
  HISCORE_STORAGE_KEY,
  LASER_LEVELS,
  PLAYER,
  POWERUP,
  ROCKET,
  ROCKET_LEVELS,
} from './constants.ts';
import { Effects } from './Effects.ts';
import { createGlowMaterial, glowGeometry } from './glow.ts';
import { Enemy } from './Enemy.ts';
import type { EnemyContext, EnemyKind } from './Enemy.ts';
import { InstancedPool } from './InstancedPool.ts';
import { createPowerup, disposeModel, POWERUP_COLORS, sharedGeometries } from './models.ts';
import type { Model, PowerupKind } from './models.ts';
import { Playfield } from './Playfield.ts';
import { PlayerShip } from './PlayerShip.ts';
import { Nebula } from './Nebula.ts';
import { Starfield } from './Starfield.ts';
import { WarpField } from './WarpField.ts';
import { WaveSpawner } from './WaveSpawner.ts';

type State = 'title' | 'playing' | 'gameover';

export interface GameUi {
  /** Element that DOM overlays (menus, tutorials) are added to. */
  container: HTMLElement;
  hud: Hud;
  cockpit: CockpitOverlay;
}

/**
 * Phases while playing:
 * shmup → waveClear (wave done, brief breather) → toCockpit (camera flies in) → hudBoot
 * (cockpit HUD powers on) → cockpit (first-person fight) → sectionEnd (results) → toShmup (camera flies out) → next wave.
 */
type Phase = 'shmup' | 'waveClear' | 'toCockpit' | 'hudBoot' | 'cockpit' | 'sectionEnd' | 'toShmup';

const WAVE_CLEAR_PAUSE = 1.8;
/** Camera blend above which the cockpit interior is shown, and the exterior ship hidden. */
const INTERIOR_FROM_BLEND = 0.85;
const HIDE_SHIP_FROM_BLEND = 0.97;
const SECTION_END_PAUSE = 1.6;

interface Powerup {
  kind: PowerupKind;
  model: Model;
  x: number;
  y: number;
}

const ENEMY_COLORS: Record<EnemyKind, readonly number[]> = {
  grunt: [0xff5a36, 0xffb443, 0xffffff],
  weaver: [0xff2d55, 0xffb443, 0xffffff],
  tank: [0xff5a36, 0xffe14d, 0xff2d55, 0xffffff],
};
const PLAYER_COLORS = [0xdfe7ff, 0x3b7bff, 0x6ff3ff, 0xffa040];
const PLAYER_BULLET_COLOR = new Color(0x7ff6ff).multiplyScalar(1.25);

const MAX_LASER = LASER_LEVELS.length - 1;
const MAX_ROCKET = ROCKET_LEVELS.length - 1;
const ROCKET_COLOR = new Color(0xffd08a).multiplyScalar(1.5);

const GAMEOVER_INPUT_DELAY = 1.2;

export class ShooterScene implements GameScene {
  readonly scene = new Scene();

  private readonly playfield = new Playfield();
  private readonly starfield = new Starfield();
  private readonly nebula = new Nebula();
  private readonly effects = new Effects(this.scene);
  private readonly spawner = new WaveSpawner();
  private readonly player = new PlayerShip();
  private readonly playerBullets = new InstancedPool(
    sharedGeometries.playerBullet,
    new MeshBasicMaterial({ color: PLAYER_BULLET_COLOR, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    160,
  );
  private readonly enemyBullets = new InstancedPool(
    glowGeometry,
    createGlowMaterial({ size: 1.05, intensity: 1.6, core: 0.4, color: [1, 0.3, 0.55] }),
    400,
  );
  private readonly rockets = new InstancedPool(
    sharedGeometries.rocket,
    new MeshBasicMaterial({ color: ROCKET_COLOR }),
    60,
  );
  private readonly enemies: Enemy[] = [];
  private readonly powerups: Powerup[] = [];
  private readonly drag: Vec2 = { x: 0, y: 0 };
  private readonly unsubscribeTap: () => void;
  private readonly unsubscribeRelease: () => void;
  private readonly enemyContext: EnemyContext;
  private readonly director = new CameraDirector();
  private readonly cockpitFill = new DirectionalLight(0xcfe0ff, 0);
  private readonly warp = new WarpField();
  private readonly interior = new CockpitInterior();
  private readonly cockpit: CockpitSection;

  private state: State = 'title';
  private stateTime = 0;
  private time = 0;
  private score = 0;
  private hiScore = loadHiScore();
  private lives: number = PLAYER.lives;
  private laserLevel = 1;
  private rocketLevel = 0;
  private fireTimer = 0;
  private rocketTimer = 0;
  /** Power-ups dropped this game; drives the rocket/laser alternation. */
  private drops = 0;
  private invulnerable = 0;
  private shake = 0;
  private gameOverShown = false;
  private phase: Phase = 'shmup';
  private phaseTime = 0;
  private messageTimer = 0;
  private paused = false;
  private cockpitTutorialDone = false;
  private wasFocusing = false;
  /** Last requested music cutoff, restored after pausing. */
  private musicCutoff = 20000;
  private prevBlend = 0;
  private plumeTimer = 0;
  private readonly hud: Hud;
  private readonly cockpitOverlay: CockpitOverlay;
  private readonly pauseMenu: PauseMenu;
  private readonly tutorial: TutorialOverlay;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: Input,
    private readonly audio: GameAudio,
    ui: GameUi,
    private readonly fx: PostFx,
  ) {
    this.hud = ui.hud;
    this.cockpitOverlay = ui.cockpit;
    const cockpitOverlay = ui.cockpit;
    this.tutorial = new TutorialOverlay(ui.container);
    this.pauseMenu = new PauseMenu(
      ui.container,
      {
        pause: () => this.pause(),
        resume: () => this.resume(),
        restart: () => {
          this.closePause();
          this.startGame();
        },
        quit: () => {
          this.closePause();
          this.quitToTitle();
        },
        toggleSound: () => audio.engine.toggleMuted(),
        toggleEffects: () => {
          fx.setQuality(fx.quality === 'high' ? 'low' : 'high');
          return fx.quality;
        },
        resetTutorials: () => this.tutorial.store.reset(),
      },
      audio.engine.muted,
      fx.quality,
    );
    audio.engine.onMuteChange((muted) => this.pauseMenu.renderSound(muted));
    input.onKey('Escape', () => (this.paused ? this.resume() : this.pause()));
    input.onKey('KeyP', () => (this.paused ? this.resume() : this.pause()));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });

    this.scene.background = new Color(0x05060f);
    this.scene.add(new HemisphereLight(0xc4d2ff, 0x2a1840, 2.2));
    const key = new DirectionalLight(0xffffff, 3);
    key.position.set(4, 6, 10);
    this.scene.add(key);
    // The key light comes from ahead of the ship, so fighters would be backlit in first person.
    this.cockpitFill.position.set(0, -1, 0.6);
    this.scene.add(this.cockpitFill);
    const engineGlow = new PointLight(0xff8a3d, 2, 4, 1.5);
    engineGlow.position.set(0, -1.4, 0.8);
    this.player.object.add(engineGlow);

    this.scene.add(this.nebula.mesh);
    for (const layer of this.starfield.layers) this.scene.add(layer.points);
    this.scene.add(this.player.object, this.playerBullets.mesh, this.enemyBullets.mesh, this.rockets.mesh);
    this.scene.add(this.warp.object, this.interior.object);
    cockpitOverlay.setInterior(this.interior.available);

    this.cockpit = new CockpitSection(this.scene, this.effects, cockpitOverlay, audio.sfx, {
      addScore: (points) => {
        this.score += points;
      },
      playerHit: () => this.damagePlayer(),
      blast: (position, strength) => this.blast(position, strength),
    });
    cockpitOverlay.setOpacity(0);

    this.enemyContext = {
      playerX: 0,
      playerY: 0,
      top: 0,
      halfWidth: 0,
      difficulty: 0,
      bulletSpeed: ENEMY_BULLET.speedMin,
      fire: (x, y, vx, vy) => {
        this.enemyBullets.spawn(x, y, vx, vy, ENEMY_BULLET.radius);
        this.audio.sfx.enemyShot();
      },
    };

    this.unsubscribeTap = input.onTap(this.handleTap);
    this.unsubscribeRelease = input.onRelease(() => {
      if (this.frozen) return;
      if (this.state === 'playing' && (this.phase === 'cockpit' || this.phase === 'toCockpit')) this.cockpit.fire();
    });
    this.enterTitle();
  }

  resize(width: number, height: number): void {
    this.playfield.fit(width, height);
    if (this.state !== 'playing') this.placePlayerAtStart();
    else if (this.phase === 'shmup') this.clampPlayer();
  }

  /** Simulation is stopped while the pause menu or a tutorial is open. */
  private get frozen(): boolean {
    return this.paused || this.tutorial.isOpen;
  }

  update(realDt: number): void {
    this.input.update();
    if (this.frozen) {
      this.input.consumeDrag(this.drag);
      this.director.update(0, this.camera, this.playfield.cameraDistance, this.player.x, this.player.y, 0);
      this.updateHud();
      return;
    }
    // Cockpit Focus slows the whole world down, not just the fight.
    const dt = realDt * this.cockpit.timeScale;
    this.stateTime += realDt;

    const playing = this.state === 'playing';
    if (playing) {
      this.updatePhase(realDt);
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
    if (playing && this.phase !== 'toCockpit' && this.phase !== 'cockpit') this.checkCollisions();

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.player.sync(dt, this.invulnerable);
    this.updateEnginePlume(dt);
    this.effects.update(dt, this.camera);
    const blend = this.director.blend;
    this.cockpitFill.intensity = 2.6 * blend;
    this.starfield.update(dt, playing ? MathUtils.lerp(14, 30, blend) : 5);
    this.warp.update(dt, blend, this.player.x, this.player.y, 45);
    this.playerBullets.sync();
    this.rockets.sync();
    this.enemyBullets.sync();
    this.shake = Math.max(0, this.shake - realDt * 1.5);
    this.director.update(realDt, this.camera, this.playfield.cameraDistance, this.player.x, this.player.y, this.shake);
    this.nebula.update(dt, this.camera, playing ? MathUtils.lerp(14, 30, blend) : 5);
    this.updateFx(realDt);
    const hudOpacity = this.cockpitHudOpacity(blend);
    this.cockpitOverlay.setOpacity(hudOpacity);
    this.interior.update(this.director.eye, blend > INTERIOR_FROM_BLEND, hudOpacity);
    if (this.interior.available && blend > HIDE_SHIP_FROM_BLEND) this.player.object.visible = false;
    this.cockpitOverlay.setLetterbox(this.director.letterbox);
    this.cockpitOverlay.update(realDt);
    if (this.messageTimer > 0) {
      this.messageTimer -= realDt;
      if (this.messageTimer <= 0) this.hud.hideMessage();
    }
    this.updateHud();
  }

  private cockpitHudOpacity(blend: number): number {
    if (this.state !== 'playing') return MathUtils.clamp((blend - 0.6) / 0.4, 0, 1);
    switch (this.phase) {
      case 'hudBoot':
      case 'cockpit':
      case 'sectionEnd':
        return 1;
      case 'toShmup':
        return MathUtils.clamp((blend - 0.7) / 0.3, 0, 1);
      default:
        return 0;
    }
  }

  private updatePhase(dt: number): void {
    this.phaseTime += dt;
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);

    switch (this.phase) {
      case 'shmup':
        this.time += dt;
        this.updatePlayer(dt);
        this.spawner.update(dt, this.time, difficulty, this.playfield.halfWidth, this.spawnEnemy);
        if (this.spawner.done && this.enemies.length === 0) {
          this.setPhase('waveClear');
          this.popEnemyBullets();
          this.audio.sfx.waveClear();
          const body = this.isStrikeWave ? 'Enemy squadron ahead!\nSwitching to cockpit…' : 'Next wave incoming';
          this.flashMessage(`WAVE ${this.spawner.wave} CLEAR`, body, 2.2);
        }
        break;

      case 'waveClear':
        // Player can still steer to grab falling power-ups; no firing.
        this.steerPlayer(dt);
        if (this.phaseTime > WAVE_CLEAR_PAUSE && !this.isStrikeWave) {
          this.startNextWave();
        } else if (this.phaseTime > WAVE_CLEAR_PAUSE) {
          this.setPhase('toCockpit');
          this.director.enterCockpit();
          this.audio.sfx.flyIn(COCKPIT.enterDuration);
          this.setMusicCutoff(450, COCKPIT.enterDuration * 0.8);
          const pf = this.playfield;
          const strike = this.spawner.wave / COCKPIT.everyWaves;
          this.cockpit.start(this.player.x, this.player.y, strike, difficulty, pf.widthPx / pf.heightPx);
        }
        break;

      case 'toCockpit':
      case 'hudBoot':
      case 'cockpit':
        this.input.consumeDrag(this.drag);
        if (this.phase === 'toCockpit' && this.director.inCockpit) this.bootHud();
        else if (this.phase === 'hudBoot' && this.phaseTime > COCKPIT.bootDuration) this.startCockpitFight();
        this.endSectionIfDone(this.updateCockpit(dt));
        if (this.cockpit.focusing !== this.wasFocusing) {
          this.wasFocusing = this.cockpit.focusing;
          this.setMusicCutoff(this.wasFocusing ? 900 : 20000, 0.25);
        }
        break;

      case 'sectionEnd':
        this.input.consumeDrag(this.drag);
        this.updateCockpit(dt);
        if (this.phaseTime > SECTION_END_PAUSE) {
          this.setPhase('toShmup');
          this.director.exitCockpit();
          this.audio.sfx.flyOut(COCKPIT.exitDuration);
          this.setMusicCutoff(500, COCKPIT.exitDuration * 0.5);
        }
        break;

      case 'toShmup':
        this.input.consumeDrag(this.drag);
        if (!this.director.transitioning) {
          this.cockpit.clear();
          this.startNextWave();
        }
        break;
    }
  }

  private get isStrikeWave(): boolean {
    return this.spawner.wave % COCKPIT.everyWaves === 0;
  }

  private startCockpitFight(): void {
    this.setPhase('cockpit');
    if (this.cockpitTutorialDone) return;
    this.cockpitTutorialDone = true;
    this.tutorial.showIfWanted('cockpit', () => this.input.consumeDrag(this.drag));
  }

  private bootHud(): void {
    this.setPhase('hudBoot');
    this.cockpitOverlay.powerOn(COCKPIT.bootDuration);
    this.audio.sfx.hudBoot(COCKPIT.bootDuration);
    this.audio.music.play(LOCK_ON, 0.4);
    this.setMusicCutoff(20000, COCKPIT.bootDuration);
  }

  private updateCockpit(dt: number): SectionStatus {
    const input = this.input;
    const pf = this.playfield;
    return this.cockpit.update(dt, {
      camera: this.camera,
      eye: this.director.eye,
      active: this.phase === 'cockpit',
      pointerDown: input.dragging,
      pointerX: input.pointer.x,
      pointerY: input.pointer.y,
      widthPx: pf.widthPx,
      heightPx: pf.heightPx,
    });
  }

  private endSectionIfDone(status: SectionStatus): void {
    if (status === 'running' || this.state !== 'playing') return;
    this.cockpit.popOrbs();
    this.setPhase('sectionEnd');
    if (status === 'cleared') {
      const wave = this.spawner.wave;
      const bonus = COCKPIT.clearBonusPerWave * wave + Math.round(this.cockpit.timeLeft) * COCKPIT.timeBonusPerSecond;
      this.score += bonus;
      this.cockpitOverlay.showCallout(`SQUADRON DESTROYED\n+${bonus.toLocaleString('en-US')}`, SECTION_END_PAUSE);
      this.audio.sfx.squadronCleared();
    }
  }

  private startNextWave(): void {
    this.setPhase('shmup');
    this.spawner.startWave();
    this.fireTimer = 0;
    this.audio.music.play(NOVA_DRIVE, 0.8);
    this.setMusicCutoff(20000, 1.2);
    this.flashMessage(`WAVE ${this.spawner.wave}`, '', 1.4);
  }

  private setMusicCutoff(hz: number, seconds: number): void {
    this.musicCutoff = hz;
    this.audio.music.setCutoff(hz, seconds);
  }

  // --- Pause -----------------------------------------------------------------------------

  private pause(): void {
    if (this.paused || this.state !== 'playing' || this.tutorial.isOpen) return;
    this.paused = true;
    this.pauseMenu.show();
    this.audio.music.setCutoff(600, 0.3);
  }

  private resume(): void {
    if (!this.paused) return;
    this.closePause();
    this.input.consumeDrag(this.drag);
    this.audio.music.setCutoff(this.musicCutoff, 0.3);
  }

  private closePause(): void {
    this.paused = false;
    this.pauseMenu.hide();
  }

  private quitToTitle(): void {
    this.tutorial.cancel();
    this.clearWorld();
    this.cockpit.clear();
    this.director.reset();
    this.audio.music.stop(0.8);
    this.messageTimer = 0;
    this.enterTitle();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private flashMessage(title: string, body: string, seconds: number): void {
    this.hud.showMessage(title, body);
    this.messageTimer = seconds;
  }

  dispose(): void {
    this.unsubscribeTap();
    this.unsubscribeRelease();
    this.clearWorld();
    this.cockpit.dispose();
    this.warp.dispose();
    this.interior.dispose();
    this.starfield.dispose();
    this.playerBullets.dispose();
    this.rockets.dispose();
    this.enemyBullets.dispose();
    this.effects.dispose();
    this.nebula.dispose();
    disposeModel(this.player.model);
  }

  // --- State transitions -------------------------------------------------------------

  private readonly handleTap = (): void => {
    if (this.tutorial.isOpen) {
      this.tutorial.dismiss();
      return;
    }
    if (this.paused) return;
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
    this.audio.sfx.start();
    this.clearWorld();
    this.state = 'playing';
    this.stateTime = 0;
    this.time = 0;
    this.score = 0;
    this.lives = PLAYER.lives;
    this.laserLevel = 1;
    this.rocketLevel = 0;
    this.fireTimer = 0;
    this.rocketTimer = 0;
    this.drops = 0;
    this.invulnerable = 1;
    this.spawner.reset();
    this.director.reset();
    this.cockpit.clear();
    this.cockpitTutorialDone = false;
    this.wasFocusing = false;
    this.placePlayerAtStart();
    this.input.consumeDrag(this.drag);
    this.hud.hideMessage();
    this.messageTimer = 0;
    this.startNextWave();
    this.tutorial.showIfWanted('flight', () => this.input.consumeDrag(this.drag));
  }

  private gameOver(): void {
    this.state = 'gameover';
    this.stateTime = 0;
    this.player.object.visible = false;
    this.messageTimer = 0;
    this.cockpit.clear();
    if (this.director.blend > 0) this.director.exitCockpit(1.2);
    this.audio.music.stop(1.5);
    this.audio.sfx.gameOver();
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
    this.rockets.clear();
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

  private steerPlayer(dt: number): void {
    const drag = this.input.consumeDrag(this.drag);
    const scale = this.playfield.worldPerPixel * PLAYER.dragSensitivity;
    this.player.x += drag.x * scale + this.input.axis.x * PLAYER.keyboardSpeed * dt;
    this.player.y += drag.y * scale + this.input.axis.y * PLAYER.keyboardSpeed * dt;
    this.clampPlayer();
  }

  private updatePlayer(dt: number): void {
    this.steerPlayer(dt);

    // Auto-fire: mobile players need both thumbs free for steering.
    this.fireTimer -= dt;
    while (this.fireTimer <= 0) {
      this.fireTimer += LASER_LEVELS[this.laserLevel]!.interval;
      this.fireLasers();
    }
    if (this.rocketLevel > 0) {
      this.rocketTimer -= dt;
      while (this.rocketTimer <= 0) {
        this.rocketTimer += ROCKET_LEVELS[this.rocketLevel]!.interval;
        this.fireRockets();
      }
    }
  }

  private fireRockets(): void {
    this.audio.sfx.rocket();
    for (const dx of ROCKET_LEVELS[this.rocketLevel]!.offsets) {
      const r = this.rockets.spawn(this.player.x + dx, this.player.y + 0.2, dx * 2, ROCKET.launchSpeed, ROCKET.radius);
      if (r) r.scale = 1.1;
    }
  }

  private fireLasers(): void {
    this.audio.sfx.shot();
    const y = this.player.y + 0.9;
    for (const [dx, deg] of LASER_LEVELS[this.laserLevel]!.shots) {
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
    this.shake = 0.6;
    navigator.vibrate?.(this.lives > 0 ? 80 : 250);
    this.audio.sfx.playerHit();
    this.fx.kickAberration(1.2);
    if (this.director.blend > 0) {
      this.cockpitOverlay.hitFlash();
    } else {
      this.effects.explode(x, y, PLAYER_COLORS, 40, 12, 0.9);
      this.effects.ring(x, y, 0.2, 0x6ff3ff, 5, 0.5);
      this.blast(tmpVec.set(x, y, 0), this.lives > 1 ? 0.6 : 1.3);
    }

    // Clearing enemy fire on hit gives the player a moment to recover.
    this.popEnemyBullets();
    this.cockpit.popOrbs();

    if (this.lives <= 0) {
      this.gameOver();
      return;
    }
    this.invulnerable = PLAYER.invulnerableTime;
  }

  // --- Enemies, bullets, power-ups -----------------------------------------------------

  private popEnemyBullets(): void {
    for (let i = 0; i < this.enemyBullets.count; i++) {
      const b = this.enemyBullets.items[i]!;
      this.effects.explode(b.x, b.y, [0xff4f8b], 2, 3, 0.3);
    }
    this.enemyBullets.clear();
  }

  private readonly spawnEnemy = (kind: EnemyKind, x: number, yOffset: number, phase: number): void => {
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
    const hpScale = 1 + WAVES.hpGrowthPerWave * (this.spawner.wave - 1);
    const enemy = new Enemy(kind, x, this.playfield.top + 2 + yOffset, phase, difficulty, hpScale);
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
    this.updateRockets(dt);
    this.enemyBullets.update(dt, (b) => {
      b.scale = 1 + Math.sin(b.age * 18) * 0.15;
      return !pf.isOutside(b.x, b.y, 1);
    });
  }

  /** Rockets accelerate up the screen; homing ones curve toward the nearest enemy ahead. */
  private updateRockets(dt: number): void {
    const pf = this.playfield;
    const homing = ROCKET_LEVELS[this.rocketLevel]!.homing;
    const steer = 1 - Math.exp(-ROCKET.steer * dt);
    this.rockets.update(dt, (r) => {
      let speed = Math.hypot(r.vx, r.vy);
      speed = Math.min(ROCKET.maxSpeed, speed + ROCKET.acceleration * dt);
      let dirX = r.vx / (speed || 1);
      let dirY = r.vy / (speed || 1);
      const target = homing && r.age > 0.12 ? this.nearestEnemy(r.x, r.y) : null;
      if (target) {
        const dx = target.x - r.x;
        const dy = target.y - r.y;
        const len = Math.hypot(dx, dy) || 1;
        dirX += (dx / len - dirX) * steer;
        dirY += (dy / len - dirY) * steer;
      } else {
        dirX += (0 - dirX) * steer * 0.5;
        dirY += (1 - dirY) * steer * 0.5;
      }
      const len = Math.hypot(dirX, dirY) || 1;
      r.vx = (dirX / len) * speed;
      r.vy = (dirY / len) * speed;
      r.rotation = Math.atan2(r.vy, r.vx) - Math.PI / 2;
      this.effects.trail(r.x - dirX * 0.4, r.y - dirY * 0.4, 0, r.age < 0.1 ? 0xffffff : 0xffa040, 0.3, 0.45);
      return !pf.isOutside(r.x, r.y, 2);
    });
  }

  private nearestEnemy(x: number, y: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = Infinity;
    for (const e of this.enemies) {
      if (e.y < y - 1 || e.y > this.playfield.top + 0.5) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
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
        else this.audio.sfx.hit();
        break;
      }
    }

    // Rockets vs enemies.
    for (let i = this.rockets.count - 1; i >= 0; i--) {
      const r = this.rockets.items[i]!;
      const j = this.enemies.findIndex((e) => circlesOverlap(r.x, r.y, r.radius, e.x, e.y, e.radius));
      if (j < 0) continue;
      this.rockets.remove(i);
      this.rocketImpact(r.x, r.y, j);
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
      this.audio.sfx.powerup();
      this.applyPowerup(p.kind);
      this.effects.explode(p.x, p.y, [POWERUP_COLORS[p.kind], 0xffffff], 16, 6, 0.4);
      this.effects.ring(p.x, p.y, 0.2, POWERUP_COLORS[p.kind], 3.5, 0.4);
      navigator.vibrate?.(20);
      this.removePowerupObject(p);
      this.powerups.splice(i, 1);
    }
  }

  private killEnemy(index: number): void {
    const e = this.enemies[index]!;
    this.score += e.score;
    const big = e.kind === 'tank';
    this.effects.explode(e.x, e.y, ENEMY_COLORS[e.kind], big ? 60 : 22, big ? 11 : 8, big ? 0.9 : 0.55);
    this.effects.ring(e.x, e.y, 0.3, big ? 0xffb443 : 0xff5a36, big ? 8 : 3.2, big ? 0.6 : 0.35);
    if (big) {
      this.shake = Math.max(this.shake, 0.35);
      this.blast(tmpVec.set(e.x, e.y, 0), 1);
    }
    this.audio.sfx.explosion(big ? 'big' : 'small');
    if (big) this.spawnPowerup(e.x, e.y);
    this.removeEnemyAt(index);
  }

  private rocketImpact(x: number, y: number, hitIndex: number): void {
    const splash = ROCKET_LEVELS[this.rocketLevel]!.splash;
    this.effects.explode(x, y, [0xffa040, 0xffe14d, 0xffffff], splash > 0 ? 18 : 10, splash > 0 ? 9 : 6, 0.35);
    if (splash > 0) this.effects.ring(x, y, 0.3, 0xffa040, splash * 2, 0.3);
    const target = this.enemies[hitIndex]!;
    const victims = new Set<Enemy>([target]);
    if (splash > 0) {
      for (const e of this.enemies) if (circlesOverlap(x, y, splash, e.x, e.y, e.radius)) victims.add(e);
    }
    for (const e of victims) {
      const index = this.enemies.indexOf(e);
      if (index < 0) continue;
      if (e.hit(e === target ? ROCKET.damage : ROCKET.splashDamage)) this.killEnemy(index);
      else this.audio.sfx.hit();
    }
  }

  /** Deterministic drops: alternate rocket/laser upgrades, skipping a weapon that's maxed. */
  private nextPowerupKind(): PowerupKind {
    const preferred: PowerupKind = this.drops++ % 2 === 0 ? 'rocket' : 'laser';
    if (preferred === 'rocket' && this.rocketLevel >= MAX_ROCKET) return 'laser';
    if (preferred === 'laser' && this.laserLevel >= MAX_LASER) return 'rocket';
    return preferred;
  }

  private applyPowerup(kind: PowerupKind): void {
    if (kind === 'laser' && this.laserLevel < MAX_LASER) {
      this.laserLevel++;
      this.flashMessage('LASER UP', `Level ${this.laserLevel}/${MAX_LASER}`, 1.1);
    } else if (kind === 'rocket' && this.rocketLevel < MAX_ROCKET) {
      this.rocketLevel++;
      const extra = ROCKET_LEVELS[this.rocketLevel]!;
      const note = this.rocketLevel === 1 ? 'Rockets online' : extra.splash > 0 ? 'Splash damage' : extra.homing ? 'Homing' : '';
      this.flashMessage('ROCKETS UP', `Level ${this.rocketLevel}/${MAX_ROCKET}${note ? ` · ${note}` : ''}`, 1.1);
    } else {
      this.score += POWERUP.maxedScore;
      this.flashMessage('MAXED', `+${POWERUP.maxedScore}`, 0.9);
    }
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
    const kind = this.nextPowerupKind();
    const model = createPowerup(kind);
    model.object.position.set(x, y, 0);
    this.scene.add(model.object);
    this.powerups.push({ kind, model, x, y });
  }

  private removePowerupObject(p: Powerup): void {
    this.scene.remove(p.model.object);
    disposeModel(p.model);
  }

  // --- Presentation ----------------------------------------------------------------------

  /** Screen shockwave (and a little aberration) at a world position. */
  private blast(position: Vector3, strength: number): void {
    tmpVec.copy(position).project(this.camera);
    if (tmpVec.z > 1) return;
    this.fx.shockwave((tmpVec.x + 1) / 2, (tmpVec.y + 1) / 2, strength);
    this.fx.kickAberration(0.5 * strength);
  }

  /** Zoom blur while the camera swoops between views, and the Focus slow-mo tint. */
  private updateFx(realDt: number): void {
    const blend = this.director.blend;
    const speed = realDt > 0 ? Math.abs(blend - this.prevBlend) / realDt : 0;
    this.prevBlend = blend;
    const transition = this.director.transitioning ? speed * COCKPIT.enterDuration * 0.45 : 0;
    this.fx.zoomBlur = MathUtils.damp(this.fx.zoomBlur, transition + blend * 0.06, 8, realDt);
    const focusing = this.state === 'playing' && this.cockpit.focusing;
    this.fx.focus = MathUtils.damp(this.fx.focus, focusing ? 1 : 0, 10, realDt);
    this.fx.aberration = blend * 0.15;
  }

  /** Glowing exhaust trail behind the ship in the top-down view. */
  private updateEnginePlume(dt: number): void {
    if (!this.player.object.visible || this.director.blend > 0.3) return;
    this.plumeTimer -= dt;
    while (this.plumeTimer <= 0) {
      this.plumeTimer += 1 / 45;
      const color = Math.random() < 0.5 ? 0xffa040 : 0x6ff3ff;
      const x = this.player.x + MathUtils.randFloatSpread(0.25);
      this.effects.trail(x, this.player.y + this.player.tailY, -0.1, color, 0.28, 0.5, -9);
    }
  }

  private updateHud(): void {
    this.pauseMenu.setButtonVisible(this.state === 'playing' && !this.frozen);
    this.hud.setWave(this.state === 'title' ? 0 : this.spawner.wave);
    this.hud.setScore(this.score);
    this.hud.setHiScore(Math.max(this.hiScore, this.score));
    this.hud.setLives(this.state === 'title' ? PLAYER.lives : this.lives);
    this.hud.setWeapons(this.laserLevel, MAX_LASER, this.rocketLevel, MAX_ROCKET);
  }
}

const tmpVec = new Vector3();

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
