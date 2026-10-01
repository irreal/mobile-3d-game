import {
  AdditiveBlending,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { PostFx } from '../core/PostFx.ts';
import { MUSIC_LEVEL } from '../audio/AudioEngine.ts';
import type { GameAudio } from '../audio/GameAudio.ts';
import { NOVA_DRIVE } from '../audio/songs.ts';
import type { GameScene } from '../core/Engine.ts';
import type { Input, Vec2 } from '../input/Input.ts';
import type { CockpitOverlay } from '../ui/CockpitOverlay.ts';
import type { Hud } from '../ui/Hud.ts';
import { PauseMenu } from '../ui/PauseMenu.ts';
import { TutorialOverlay } from '../ui/Tutorial.ts';
import type { TutorialId } from '../ui/Tutorial.ts';
import { AlienBase, BASE_CLEARING, CORE_OFFSET, HANGAR_OFFSETS, SENTRY_OFFSETS } from './AlienBase.ts';
import { CameraDirector } from './CameraDirector.ts';
import { CockpitInterior } from './CockpitInterior.ts';
import type { MiniGame, MiniGameCallbacks, MiniGameStatus, MiniGameWorld } from './minigames/MiniGame.ts';
import { MINI_GAMES, MiniGameLibrary, pickMiniGame, worldOf } from './minigames/registry.ts';
import type { MiniGameEntry } from './minigames/registry.ts';
import {
  COCKPIT,
  WAVES,
  DIFFICULTY_RAMP_TIME,
  ENEMY_BULLET,
  GAME_TITLE,
  GUN_TYPES,
  GUNS,
  HISCORE_STORAGE_KEY,
  MAX_GUN_LEVEL,
  PLAYER,
  POWERUP,
  ROCKET,
  ROCKET_LEVELS,
} from './constants.ts';
import type { GunType } from './constants.ts';
import { Effects } from './Effects.ts';
import { createGlowMaterial, glowGeometry } from './glow.ts';
import { Enemy, EXPLOSION_COLORS } from './Enemy.ts';
import { Environment, environmentForWave, TERRAIN_SCROLL_RATE, upcomingPlanet } from './Environment.ts';
import type { EnvironmentId } from './Environment.ts';
import type { EnemyContext, EnemyKind } from './Enemy.ts';
import { InstancedPool } from './InstancedPool.ts';
import { RemoteShips } from './RemoteShips.ts';
import { COOP_ALIVE, COOP_COCKPIT, COOP_FIRING, COOP_HURT, CoopClient, coopServerUrl, loadCoop, saveCoop } from '../net/CoopClient.ts';
import type { CoopGameEvent } from '../net/CoopClient.ts';
import { seededRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { createPowerup, disposeModel, POWERUP_COLORS, POWERUP_KINDS, sharedGeometries } from './models.ts';
import type { PowerupKind, PowerupModel } from './models.ts';
import { Playfield } from './Playfield.ts';
import { PlayerShip } from './PlayerShip.ts';
import { Nebula } from './Nebula.ts';
import { Starfield } from './Starfield.ts';
import { WarpField } from './WarpField.ts';
import { WaveSpawner } from './WaveSpawner.ts';

type State = 'title' | 'playing' | 'gameover' | 'victory';

export interface GameUi {
  /** Element that DOM overlays (menus, tutorials) are added to. */
  container: HTMLElement;
  hud: Hud;
  cockpit: CockpitOverlay;
}

/**
 * Phases while playing (in co-op, each wave starts with sync: waiting for the squad):
 * shmup → [bossApproach → boss → bossDown: alien base at the end of a planet] → waveClear (wave done, brief breather) → toCockpit (camera flies in) → hudBoot
 * (cockpit HUD powers on) → cockpit (first-person mini-game) → sectionEnd (results) → toShmup (camera flies out) → next wave.
 * A strike wave with no mini-game for its world goes waveClear → transit (straight on to the next world) instead.
 */
type Phase =
  | 'sync'
  | 'shmup'
  | 'bossApproach'
  | 'boss'
  | 'bossDown'
  | 'waveClear'
  | 'toCockpit'
  | 'hudBoot'
  | 'cockpit'
  | 'sectionEnd'
  | 'toShmup'
  | 'transit';

/** Base centre rests at this fraction of the visible top once arrived. */
const BASE_REST = 0.42;
/** Within this distance of its resting place the scroll brakes to a stop. */
const BASE_BRAKE_DISTANCE = 22;
const BASE_DOWN_TIME = 3.6;

const WAVE_CLEAR_PAUSE = 1.8;
/** Camera blend above which the cockpit interior is shown, and the exterior ship hidden. */
const INTERIOR_FROM_BLEND = 0.85;
const HIDE_SHIP_FROM_BLEND = 0.97;
const SECTION_END_PAUSE = 1.6;

interface Powerup {
  /** The heavy that dropped it, so co-op pickups count once. */
  netId: number;
  /** Index into POWERUP_KINDS of the colour it is right now. */
  kindIndex: number;
  model: PowerupModel;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds until the next colour change. */
  cycleTimer: number;
}

const PLAYER_COLORS = [0xdfe7ff, 0x3b7bff, 0x6ff3ff, 0xffa040];
/** Bolts are tinted per gun; this lifts them a little above their HUD colour. */
const PLAYER_BULLET_BOOST = new Color(0xffffff).multiplyScalar(1.05);
const BOLT_SCALE: Record<GunType, number> = { pulse: 1, lance: 1.35, scatter: 0.8 };

const MAX_ROCKET = ROCKET_LEVELS.length - 1;
const ROCKET_COLOR = new Color(0xffd08a).multiplyScalar(1.2);

const GAMEOVER_INPUT_DELAY = 1.2;

/**
 * Upgrade close-up timeline (real seconds): time slows to a crawl first, then the camera zooms
 * in, the part installs, it holds, and zooms back out as time speeds up again.
 */
const UPGRADE_SLOW = 0.4;
const UPGRADE_ZOOM_AT = 1;
const UPGRADE_IN = 0.55;
const UPGRADE_HOLD_END = 2.7;
const UPGRADE_OUT = 0.6;
const UPGRADE_TIME_SCALE = 0.06;
/** Victory: when the "mission complete" card appears, and when a tap restarts. */
const VICTORY_MESSAGE_AT = 4;
const VICTORY_INPUT_AT = 7;

/**
 * A co-op wave, started by the server for the whole squad. The world runs in lockstep on the
 * server clock, from `at`: first the wave, then (on a base wave) the base fight from `bossAt`.
 */
interface NetWave {
  w: number;
  /** Server ms the current lockstep segment started. */
  at: number;
  seed: number;
  segment: 'wave' | 'boss';
  /** Server ms the squad's base fight starts (0: not set yet). */
  bossAt: number;
  /** We told the server we've reached the base. */
  bossAsked: boolean;
}
/** Co-op play time credited per wave, so difficulty matches on every client. */
const NET_WAVE_TIME = 40;
/** Further behind the squad's clock than this, the world fast-forwards (after a pause or a late join). */
const NET_CATCH_UP = 0.5;
const NET_STEP = 1 / 30;
/** After fast-forwarding, enemy fire in the meantime is on screen: a moment to find your bearings. */
const NET_CATCH_UP_GRACE = 1.5;
/**
 * In co-op, enemies aim at where their target was this long ago: by then every client has the
 * same ship states (see CoopClient.pilotsAt), so every client fires the same shots.
 */
const NET_AIM_DELAY_MS = 250;
/** Give up on the squad and play the wave solo if the server doesn't start it by then. */
const NET_SYNC_TIMEOUT = 25;
const NET_DAMAGE_INTERVAL = 0.05;
/** Shared-arena spawns start a little higher, so tall phone screens don't see them pop in. */
const SHARED_SPAWN_LIFT = 2.5;
const NET_BOSS_ID = 1000;
/** Scroll speed of the play plane in the top-down view (world units per second). */
const SHMUP_CRUISE = 14;
const NET_HANGAR_ID = 2000;

export class ShooterScene implements GameScene {
  readonly scene = new Scene();

  private readonly playfield = new Playfield();
  private readonly starfield = new Starfield();
  private readonly nebula = new Nebula();
  private readonly environment: Environment;
  private readonly effects = new Effects(this.scene);
  private readonly spawner = new WaveSpawner();
  private readonly player = new PlayerShip();
  private readonly playerBullets = new InstancedPool(
    sharedGeometries.playerBullet,
    new MeshBasicMaterial({ color: PLAYER_BULLET_BOOST, transparent: true, blending: AdditiveBlending, depthWrite: false }),
    240,
    true,
  );
  private readonly enemyBullets = new InstancedPool(
    glowGeometry,
    createGlowMaterial({ size: 1, intensity: 1.35, core: 0.4, color: [1, 0.3, 0.55] }),
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
  private readonly unsubscribePress: () => void;
  private readonly unsubscribeMove: () => void;
  private readonly unsubscribeRelease: () => void;
  private readonly enemyContext: EnemyContext;
  private readonly director = new CameraDirector();
  private readonly cockpitFill = new DirectionalLight(0xcfe0ff, 0);
  private readonly warp = new WarpField();
  private readonly interior = new CockpitInterior();
  private readonly coop = new CoopClient();
  private readonly remoteShips = new RemoteShips(this.scene);
  private readonly miniGames: MiniGameLibrary;
  /** The first-person mini-game for the current (or last) strike. */
  private cockpit: MiniGame | null = null;
  private cockpitEntry: MiniGameEntry | null = null;
  /** Seconds the current transit (strike skipped) takes. */
  private transitTime = 0;

  private state: State = 'title';
  private stateTime = 0;
  private time = 0;
  private score = 0;
  private hiScore = loadHiScore();
  private lives: number = PLAYER.lives;
  private gunType: GunType = 'pulse';
  private gunLevel = 1;
  private rocketLevel = 0;
  /** Absorbs the next hit (earned by catching an orb for a maxed weapon). */
  private barrier = false;
  private readonly barrierMesh = new Mesh(
    new SphereGeometry(1.15, 24, 16),
    new MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
  );
  private fireTimer = 0;
  private rocketTimer = 0;
  /** Power orbs dropped this game; alternates the colour new orbs start on. */
  private drops = 0;
  private invulnerable = 0;
  private shake = 0;
  private gameOverShown = false;
  private phase: Phase = 'shmup';
  private phaseTime = 0;
  private messageTimer = 0;
  private paused = false;
  /** Mini-game tutorials already offered this game. */
  private readonly tutorialsOffered = new Set<TutorialId>();
  /** Last requested music cutoff, restored after pausing. */
  private musicCutoff = 20000;
  private prevBlend = 0;
  private plumeTimer = 0;
  /** Pending seconds (since death) of the player's explosion chain. */
  private deathBursts: number[] = [];
  private deathTime = 0;
  private deathSpread = 1;
  private readonly deathCenter = new Vector3();
  private base: AlienBase | null = null;
  /** Terrain-space y of the base (it moves with the ground). */
  private baseTerrainY = 0;
  private bossCore: Enemy | null = null;
  private readonly bossSentries: Enemy[] = [];
  private bossDefeated = false;
  private hangarTimer = 0;
  private hangarLaunches = 0;
  private bossBursts: number[] = [];
  /** Scroll speed multiplier: brakes to 0 at the alien base. */
  private scrollFactor = 1;
  /** Game-time multiplier (slow motion during the upgrade close-up). */
  private timeScale = 1;
  /** Real seconds into the upgrade close-up, or -1. */
  private upgradeTime = -1;
  private upgradeInstalled = false;
  /** Weapon levels currently mounted on the hull model. */
  private shownWeapons = '';
  private victoryTime = 0;
  private victoryMessageShown = false;
  /** The co-op wave being played in step with the squad, or null in solo play. */
  private net: NetWave | null = null;
  /** Wave asked of the server while in `sync`. */
  private netWanted = 0;
  /** Set by the testing shortcuts: the rest of this game is solo even when online. */
  private netSolo = false;
  /** Players in the squad when the server started this wave (more heavies for more players). */
  private netSquad = 1;
  /** Seconds of the current co-op wave simulated so far. */
  private netClock = 0;
  /** Enemies spawned this wave; numbers them identically on every client. */
  private spawnCount = 0;
  private hangarCount = 0;
  private netKills = new Set<number>();
  private netPicks = new Set<number>();
  /** Damage dealt to enemies since the last report to the squad. */
  private readonly netDamage = new Map<number, number>();
  private netDamageTimer = 0;
  /** Fast-forwarding to the squad's clock (enemy fire is silent). */
  private catchingUp = false;
  private readonly aimPoint = { x: 0, y: 0 };
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
    this.environment = new Environment(ui.container);
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
        miniGames: () => this.miniGameList(),
        jumpToMiniGame: (id, round) => this.jumpToMiniGame(id, round),
        jumpToBase: (planet) => this.jumpToBase(planet),
        jumpToVictory: () => this.jumpToVictory(),
        weaponLevel: (weapon) =>
          weapon === 'gun'
            ? { level: this.gunLevel, max: MAX_GUN_LEVEL }
            : { level: this.rocketLevel, max: MAX_ROCKET },
        setWeaponLevel: (weapon, level) => {
          if (weapon === 'gun') return (this.gunLevel = MathUtils.clamp(level, 1, MAX_GUN_LEVEL));
          return (this.rocketLevel = MathUtils.clamp(level, 0, MAX_ROCKET));
        },
        gunName: () => GUNS[this.gunType].name,
        cycleGun: () => {
          this.gunType = GUN_TYPES[(GUN_TYPES.indexOf(this.gunType) + 1) % GUN_TYPES.length]!;
          return GUNS[this.gunType].name;
        },
        toggleSound: () => audio.engine.toggleMuted(),
        toggleEffects: () => {
          fx.setQuality(fx.quality === 'high' ? 'low' : 'high');
          return fx.quality;
        },
        resetTutorials: () => this.tutorial.store.reset(),
        coopLabel: () => this.coopLabel(),
        toggleCoop: () => this.toggleCoop(),
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
    this.barrierMesh.renderOrder = 4;
    this.player.object.add(this.barrierMesh);
    this.scene.add(this.player.object, this.playerBullets.mesh, this.enemyBullets.mesh, this.rockets.mesh);
    this.scene.add(this.warp.object, this.interior.object, this.environment.object);
    cockpitOverlay.setInterior(this.interior.available);

    const callbacks: MiniGameCallbacks = {
      addScore: (points) => {
        this.score += points;
      },
      playerHit: () => this.damagePlayer(),
      blast: (position, strength) => this.blast(position, strength),
    };
    this.miniGames = new MiniGameLibrary({
      scene: this.scene,
      effects: this.effects,
      overlay: cockpitOverlay,
      sfx: audio.sfx,
      music: audio.music,
      callbacks,
    });
    cockpitOverlay.setOpacity(0);

    this.enemyContext = {
      playerX: 0,
      playerY: 0,
      top: 0,
      halfWidth: 0,
      difficulty: 0,
      bulletSpeed: ENEMY_BULLET.speedMin,
      shared: false,
      fire: (x, y, vx, vy, late) => {
        this.enemyBullets.spawn(x + vx * late, y + vy * late, vx, vy, ENEMY_BULLET.radius);
        if (!this.catchingUp) this.audio.sfx.enemyShot();
      },
      aim: (enemy, late) => this.aimFor(enemy, late),
    };

    this.unsubscribeTap = input.onTap(this.handleTap);
    this.unsubscribePress = input.onPress((x, y, time) => {
      if (this.frozen) return;
      if (this.state === 'playing' && this.phase === 'cockpit') this.cockpit?.tap(x, y, time);
    });
    this.unsubscribeMove = input.onPointerMove((x, y) => {
      if (!this.frozen) this.cockpit?.drag(x, y);
    });
    this.unsubscribeRelease = input.onRelease(() => this.cockpit?.release());
    this.coop.onChange = () => this.pauseMenu.refresh();
    this.coop.onGame = (e) => this.onCoopEvent(e);
    window.addEventListener('pagehide', () => this.coop.disconnect());
    const saved = loadCoop();
    const url = coopServerUrl();
    if (url && (saved.enabled || new URLSearchParams(location.search).has('coop'))) this.coop.connect(url);
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
    const halfWidth = this.playfield.halfWidth;
    this.playfield.setShared(this.coop.status !== 'off');
    if (this.playfield.halfWidth !== halfWidth && this.state === 'playing') this.clampPlayer();
    if (this.frozen) {
      this.cockpit?.onResume();
      this.input.consumeDrag(this.drag);
      this.director.update(0, this.camera, this.playfield.cameraDistance, this.player.x, this.player.y, 0);
      this.updateCoop(realDt);
      this.updateHud();
      return;
    }
    this.updateUpgradeCinematic(realDt);
    const dt = realDt * this.timeScale;
    const worldDt = this.worldDt(dt);
    this.stateTime += dt;

    const playing = this.state === 'playing';
    if (playing) {
      this.updatePhase(dt, worldDt);
    } else if (this.state === 'victory') {
      this.input.consumeDrag(this.drag);
      this.updateVictory(dt);
    } else {
      this.input.consumeDrag(this.drag);
      if (this.state === 'gameover' && !this.gameOverShown && this.stateTime > GAMEOVER_INPUT_DELAY) {
        this.showGameOverMessage();
      }
      if (this.state === 'title') this.player.y = this.startY() + Math.sin(this.stateTime * 2) * 0.25;
    }

    const lockstep = this.lockstep;
    this.updateBase(lockstep ? worldDt : dt);
    // In lockstep, before enemies fire, so new shots are only as far along as they were due.
    if (lockstep) this.updateEnemyBullets(worldDt);
    this.updateEnemies(worldDt);
    // After moving enemies, so new ones aren't also aged by this whole frame.
    if (playing && this.phase === 'shmup') this.spawner.update(worldDt, this.playfield.halfWidth, this.spawnEnemy);
    this.updateBullets(dt);
    if (!lockstep) this.updateEnemyBullets(dt);
    this.updatePowerups(worldDt);
    if (playing && this.phase !== 'toCockpit' && this.phase !== 'cockpit') this.checkCollisions();

    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.player.sync(dt, this.upgradeTime >= 0 ? 0 : this.invulnerable);
    if (this.state === 'victory') this.animateVictoryShip();
    this.updateBarrier(realDt);
    this.syncWeapons();
    this.player.weapons.update(realDt);
    this.updateCoop(realDt);
    this.updateEnginePlume(dt);
    this.updateDeathBursts(dt);
    this.effects.update(dt, this.camera);
    const blend = this.director.blend;
    this.cockpitFill.intensity = 2.6 * blend;
    const cruise = this.state === 'victory' ? 28 : playing ? MathUtils.lerp(SHMUP_CRUISE, 30, blend) : 5;
    const scrollSpeed = cruise * this.scrollFactor;
    this.starfield.update(dt, scrollSpeed);
    this.environment.setApproach(upcomingPlanet(this.spawner.wave), this.planetApproach());
    // A lockstep base fight sets the ground's scroll itself (updateBase).
    this.environment.update(dt, this.camera, lockstep && this.base ? 0 : scrollSpeed, blend);
    if (this.environment.heat > 0) this.shake = Math.max(this.shake, this.environment.heat * 0.7);
    this.starfield.setAtmosphere(this.environment.atmosphere);
    this.nebula.setIntensity(1 - this.environment.atmosphere);
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

  private updatePhase(dt: number, worldDt: number): void {
    this.phaseTime += dt;
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);

    switch (this.phase) {
      case 'sync':
        this.steerPlayer(dt);
        if (this.coop.status !== 'online' || this.phaseTime > NET_SYNC_TIMEOUT) {
          this.beginWave(null);
        } else if (this.phaseTime > 0.6 && this.messageTimer <= 0) {
          const others = this.coop.others;
          this.flashMessage('WAITING FOR SQUAD', `Wave ${this.netWanted} starts when everyone is ready${others ? ` · ${others + 1} online` : ''}`, 60);
        }
        break;

      case 'shmup':
        this.time += worldDt;
        this.updatePlayer(dt);
        if (this.spawner.done && this.enemies.length === 0 && this.isBaseWave && !this.bossDefeated) {
          const net = this.net;
          // In co-op the server picks one start time for the whole squad (see worldDt).
          if (!net) this.startBoss();
          else if (!net.bossAsked && !(net.bossAsked = this.coop.send({ t: 'boss', w: net.w }))) this.startBoss();
        } else if (this.spawner.done && this.enemies.length === 0) {
          this.setPhase('waveClear');
          this.popEnemyBullets();
          this.audio.sfx.waveClear();
          this.flashMessage(`WAVE ${this.spawner.wave} CLEAR`, this.waveClearNote(), 2.2);
        }
        break;

      case 'bossApproach':
      case 'boss':
        this.time += worldDt;
        this.updatePlayer(dt);
        this.updateBoss(worldDt, difficulty);
        break;

      case 'bossDown':
        this.steerPlayer(dt);
        this.scrollFactor = Math.min(1, this.scrollFactor + dt / 4);
        if (this.phaseTime > BASE_DOWN_TIME) {
          this.setPhase('waveClear');
          this.audio.sfx.waveClear();
          this.flashMessage(`WAVE ${this.spawner.wave} CLEAR`, this.waveClearNote(), 2.2);
        }
        break;

      case 'waveClear':
        this.scrollFactor = Math.min(1, this.scrollFactor + dt / 4);
        // Player can still steer to grab falling power-ups; no firing.
        this.steerPlayer(dt);
        if (this.phaseTime > WAVE_CLEAR_PAUSE) {
          const game = this.strikeGame();
          if (!this.isStrikeWave) this.startNextWave();
          else if (game) this.enterCockpit(game, this.spawner.wave / COCKPIT.everyWaves);
          else this.skipStrike();
        }
        break;

      case 'transit':
        this.scrollFactor = Math.min(1, this.scrollFactor + dt / 4);
        this.steerPlayer(dt);
        if (this.isFinalWave) this.environment.hurryDeparture(1.6);
        if (this.phaseTime < this.transitTime) break;
        if (!this.isFinalWave) this.startNextWave();
        else if (this.environment.departureDone) this.startVictory();
        break;

      case 'toCockpit':
      case 'hudBoot':
      case 'cockpit':
        this.input.consumeDrag(this.drag);
        if (this.phase === 'toCockpit' && this.director.inCockpit) this.bootHud();
        else if (this.phase === 'hudBoot' && this.phaseTime > COCKPIT.bootDuration) this.startCockpitFight();
        this.endSectionIfDone(this.updateCockpit(dt));
        break;

      case 'sectionEnd':
        this.input.consumeDrag(this.drag);
        this.updateCockpit(dt);
        if (this.phaseTime > SECTION_END_PAUSE) {
          this.setPhase('toShmup');
          this.director.exitCockpit();
          this.audio.sfx.flyOut(COCKPIT.exitDuration);
          this.changeEnvironment(environmentForWave(this.spawner.wave + 1));
          this.setMusicCutoff(500, COCKPIT.exitDuration * 0.5);
        }
        break;

      case 'toShmup':
        this.input.consumeDrag(this.drag);
        if (this.isFinalWave) this.environment.hurryDeparture(1.6);
        if (!this.director.transitioning) {
          this.cockpit?.clear();
          if (!this.isFinalWave) this.startNextWave();
          else if (this.environment.departureDone) this.startVictory();
        }
        break;
    }
  }

  /** The mini-game for this wave's strike (if it is a strike wave), or null if none fits. */
  private strikeGame(): MiniGameEntry | null {
    const environment = environmentForWave(this.spawner.wave);
    return pickMiniGame(worldOf(environment), this.spawner.wave / COCKPIT.everyWaves);
  }

  private enterCockpit(entry: MiniGameEntry, strike: number): void {
    this.removeBase();
    this.scrollFactor = 1;
    this.setPhase('toCockpit');
    this.director.enterCockpit();
    this.audio.sfx.flyIn(COCKPIT.enterDuration);
    this.setMusicCutoff(450, COCKPIT.enterDuration * 0.8);
    const pf = this.playfield;
    const environment = environmentForWave(this.spawner.wave);
    this.cockpitEntry = entry;
    this.cockpit = this.miniGames.get(entry);
    this.cockpit.start({
      strike,
      world: worldOf(environment),
      environment,
      shipX: this.player.x,
      shipY: this.player.y,
      aspect: pf.widthPx / pf.heightPx,
      squad: this.net ? this.netSquad : 1,
    });
  }

  private waveClearNote(): string {
    if (!this.isStrikeWave) return 'Next wave incoming';
    if (this.strikeGame()) return 'Enemy squadron ahead!\nSwitching to cockpit…';
    return this.isFinalWave ? 'Last base down!' : 'Moving on';
  }

  /** No mini-game fits this strike: fly straight on to the next world in the top-down view. */
  private skipStrike(): void {
    this.removeBase();
    this.scrollFactor = 1;
    this.setPhase('transit');
    this.transitTime = this.changeEnvironment(environmentForWave(this.spawner.wave + 1));
  }

  /** Testing (pause menu): the mini-games, and which have a test row. */
  private miniGameList(): { id: string; name: string; enabled: boolean }[] {
    return MINI_GAMES.map(({ id, name, enabled }) => ({ id, name, enabled }));
  }

  /**
   * Testing shortcut (pause menu): play mini-game `id` (enabled or not) at its `round`-th strike
   * in a world it fits, from the current game.
   */
  private jumpToMiniGame(id: string, round: number): void {
    const entry = MINI_GAMES.find((e) => e.id === id);
    if (!entry) return;
    const strike = nthStrikeIn(entry.worlds, round);
    this.goSolo();
    this.goSolo();
    this.closePause();
    this.tutorial.cancel();
    this.clearWorld();
    this.cockpit?.clear();
    this.director.reset();
    this.hud.hideMessage();
    this.messageTimer = 0;
    this.invulnerable = 1;
    this.spawner.wave = strike * COCKPIT.everyWaves;
    this.environment.set(environmentForWave(this.spawner.wave));
    this.placePlayerAtStart();
    this.enterCockpit(entry, strike);
  }

  /** Testing shortcut (pause menu): skip to the alien base at the end of planet `planet`. */
  private jumpToBase(planet: number): void {
    this.goSolo();
    this.closePause();
    this.tutorial.cancel();
    this.clearWorld();
    this.cockpit?.clear();
    this.director.reset();
    this.hud.hideMessage();
    this.messageTimer = 0;
    this.invulnerable = 1;
    // Planets sit on every other pair of waves: 3–4, 7–8, 11–12.
    this.spawner.wave = planet * 4 - 1;
    this.environment.set(environmentForWave(this.spawner.wave + 1));
    this.placePlayerAtStart();
    this.startNextWave();
    this.spawner.skipWave();
  }

  /** Flies into the next world (while the camera pulls out of the cockpit); returns the seconds it takes. */
  private changeEnvironment(next: EnvironmentId): number {
    const env = this.environment;
    const from = env.id;
    if (next === from) return 0;
    const seconds = from === 'space' ? COCKPIT.exitDuration + 2.4 : COCKPIT.exitDuration + 0.6;
    env.transitionTo(next, seconds);
    this.audio.sfx.atmosphere(seconds);
    // Spans the camera pull-out and settles shortly after control returns.
    const flourish = COCKPIT.exitDuration + 1.5;
    if (from === 'space') this.player.maneuver('dive', flourish);
    else if (next === 'space') this.player.maneuver('climb', flourish);
    const title = from === 'space' ? 'ENTERING ATMOSPHERE' : next === 'space' ? 'LEAVING ATMOSPHERE' : 'HYPERJUMP';
    this.flashMessage(title, next === 'space' ? 'Back to deep space' : env.nameOf(next), seconds);
    return seconds;
  }

  /** How close the next planet looms while in space: grows over the pair of waves before it. */
  private planetApproach(): number {
    if (this.state === 'title' || this.spawner.wave === 0) return 0;
    const inPair = (this.spawner.wave - 1) % 2;
    if (this.phase === 'shmup' || this.phase === 'waveClear' || this.phase === 'sync') {
      return ((inPair + this.spawner.progress) / 2) * 0.7;
    }
    return 0.75;
  }

  /** The strike after the last world's base ends the run. */
  private get isFinalWave(): boolean {
    return this.isStrikeWave && environmentForWave(this.spawner.wave) === 'lava';
  }

  // --- Upgrade close-up ------------------------------------------------------------------

  private startUpgradeCinematic(): void {
    // Co-op can't slow time for one player: just install the part.
    if (this.director.blend > 0 || this.state !== 'playing' || this.upgradeTime >= 0 || this.net) {
      this.syncWeapons(true);
      if (this.net) this.audio.sfx.install();
      return;
    }
    this.upgradeTime = 0;
    this.upgradeInstalled = false;
    this.audio.music.setCutoff(700, 0.3);
  }

  private updateUpgradeCinematic(realDt: number): void {
    if (this.upgradeTime < 0) {
      this.timeScale = 1;
      return;
    }
    const t = (this.upgradeTime += realDt);
    const out = Math.min(1, Math.max(0, (t - UPGRADE_HOLD_END) / UPGRADE_OUT));
    const slow = MathUtils.smoothstep(t, 0, UPGRADE_SLOW);
    this.timeScale = out > 0 ? MathUtils.lerp(UPGRADE_TIME_SCALE, 1, out * out) : MathUtils.lerp(1, UPGRADE_TIME_SCALE, slow);
    const zoomIn = Math.min(1, Math.max(0, (t - UPGRADE_ZOOM_AT) / UPGRADE_IN));
    this.director.focus = out > 0 ? 1 - out : zoomIn;
    this.director.focusAngle = MathUtils.lerp(
      -0.45,
      0.35,
      Math.min(1, Math.max(0, (t - UPGRADE_ZOOM_AT) / (UPGRADE_HOLD_END + UPGRADE_OUT - UPGRADE_ZOOM_AT))),
    );
    if (!this.upgradeInstalled && t >= UPGRADE_ZOOM_AT + UPGRADE_IN * 0.85) {
      this.upgradeInstalled = true;
      this.syncWeapons(true);
      this.audio.sfx.install();
    }
    if (t >= UPGRADE_HOLD_END + UPGRADE_OUT) {
      this.upgradeTime = -1;
      this.timeScale = 1;
      this.director.focus = 0;
      this.audio.music.setCutoff(this.musicCutoff, 0.4);
    }
  }

  /** Mounts the hull guns for the current levels (animated for the close-up). */
  private syncWeapons(animate = false): void {
    if (this.upgradeTime >= 0 && !this.upgradeInstalled) return;
    const key = `${this.gunType}${this.gunLevel}/${this.rocketLevel}`;
    if (key === this.shownWeapons) return;
    this.shownWeapons = key;
    this.player.weapons.set(this.gunType, this.gunLevel, this.rocketLevel, animate);
  }

  private cancelUpgradeCinematic(): void {
    this.upgradeTime = -1;
    this.timeScale = 1;
    this.director.focus = 0;
  }

  // --- Victory ---------------------------------------------------------------------------

  private startVictory(): void {
    this.leaveSquad();
    this.cancelUpgradeCinematic();
    this.state = 'victory';
    this.stateTime = 0;
    this.victoryTime = 0;
    this.victoryMessageShown = false;
    this.hud.hideMessage();
    this.messageTimer = 0;
    this.popEnemyBullets();
    this.director.victory = 0;
    this.environment.startVictory(this.player.x, this.player.y);
    this.audio.music.play(NOVA_DRIVE, 1);
    this.audio.engine.setMusicLevel(MUSIC_LEVEL, 1);
    this.setMusicCutoff(20000, 2);
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      saveHiScore(this.hiScore);
    }
  }

  private updateVictory(dt: number): void {
    this.victoryTime += dt;
    this.director.victory = this.victoryTime;
    if (!this.victoryMessageShown && this.victoryTime > VICTORY_MESSAGE_AT) {
      this.victoryMessageShown = true;
      this.audio.sfx.squadronCleared();
      this.hud.showMessage('MISSION COMPLETE', `Three worlds freed\nScore ${this.score.toLocaleString('en-US')}`);
    }
    if (this.victoryMessageShown && this.stateTime > VICTORY_INPUT_AT && this.stateTime - dt <= VICTORY_INPUT_AT) {
      const action = isTouchDevice() ? 'Tap to play again' : 'Click or press Space to play again';
      this.hud.showMessage('MISSION COMPLETE', `Three worlds freed\nScore ${this.score.toLocaleString('en-US')}\n${action}`);
    }
  }

  /** Cruising toward the camera with a gentle bob and one victory roll. */
  private animateVictoryShip(): void {
    const v = this.victoryTime;
    const obj = this.player.object;
    obj.position.z = Math.sin(v * 1.4) * 0.12;
    const roll = MathUtils.smoothstep(v, 5.2, 6.6);
    if (roll > 0 && roll < 1) obj.rotation.y = roll * Math.PI * 2;
    obj.rotation.x = Math.sin(v * 0.9) * 0.05;
  }

  /** Testing shortcut (pause menu): play the ending. */
  private jumpToVictory(): void {
    this.goSolo();
    this.closePause();
    this.tutorial.cancel();
    this.clearWorld();
    this.cockpit?.clear();
    this.director.reset();
    this.environment.set('space');
    this.placePlayerAtStart();
    this.startVictory();
  }

  /** The last wave on a planet ends at an alien base. */
  private get isBaseWave(): boolean {
    return this.isStrikeWave && environmentForWave(this.spawner.wave) !== 'space';
  }

  // --- Alien base boss -------------------------------------------------------------------

  private startBoss(): void {
    const env = this.environment;
    const startY = this.playfield.arenaTop + 14;
    this.baseTerrainY = startY + env.scrollOffset;
    const groundZ = env.setClearing(0, this.baseTerrainY, BASE_CLEARING);
    this.base = new AlienBase(groundZ);
    this.base.y = startY;
    this.base.update(0);
    this.scene.add(this.base.object);
    const hpScale = 1 + WAVES.hpGrowthPerWave * (this.spawner.wave - 1);
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
    let parts = 0;
    const part = (kind: EnemyKind, dx: number, dy: number): Enemy => {
      const netId = NET_BOSS_ID + parts++;
      const e = new Enemy(kind, dx, startY + dy, 0, difficulty, hpScale, 0, this.fireRng(netId));
      e.netId = netId;
      e.holdFire = true;
      this.enemies.push(e);
      this.scene.add(e.object);
      return e;
    };
    this.bossSentries.length = 0;
    for (const [dx, dy] of SENTRY_OFFSETS) this.bossSentries.push(part('sentry', dx, dy));
    this.bossCore = part('core', CORE_OFFSET[0], CORE_OFFSET[1]);
    this.bossCore.shielded = true;
    this.hangarTimer = 2.5;
    this.hangarLaunches = 0;
    this.setPhase('bossApproach');
    this.audio.sfx.bossAlarm();
    this.flashMessage('WARNING', 'Alien base ahead\nDestroy the sentries to drop the core shield', 3.2);
    // Joining a fight the squad is already in.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.net && this.netKills.has(this.enemies[i]!.netId)) this.killEnemy(i, 'remote');
    }
  }

  /** Keeps the base (and its turrets) locked to the scrolling ground. */
  private updateBase(dt: number): void {
    const base = this.base;
    if (!base) return;
    if (this.lockstep) {
      // Moved by the squad's clock (with the ground following), so it's in the same place on every screen.
      base.y -= SHMUP_CRUISE * TERRAIN_SCROLL_RATE * this.scrollFactor * dt;
      this.environment.alignScroll(this.baseTerrainY - base.y);
    } else {
      base.y = this.baseTerrainY - this.environment.scrollOffset;
    }
    base.update(dt);
    const pin = (e: Enemy | null, dx: number, dy: number): void => {
      if (!e) return;
      e.anchorX = base.x + dx;
      e.anchorY = base.y + dy;
    };
    this.bossSentries.forEach((e, i) => pin(e, SENTRY_OFFSETS[i]![0], SENTRY_OFFSETS[i]![1]));
    pin(this.bossCore, CORE_OFFSET[0], CORE_OFFSET[1]);
    if (this.bossBursts.length > 0) this.updateBossBursts(dt);
    if (base.y < this.playfield.bottom - 30) this.removeBase();
  }

  private updateBoss(dt: number, difficulty: number): void {
    const base = this.base;
    if (!base) return;
    const rest = this.playfield.arenaTop * BASE_REST;
    if (this.phase === 'bossApproach') {
      const d = Math.max(0, base.y - rest);
      this.scrollFactor = Math.min(1, Math.sqrt(d / BASE_BRAKE_DISTANCE));
      if (d < 0.03) {
        this.scrollFactor = 0;
        this.setPhase('boss');
        for (const e of this.bossSentries) e.holdFire = false;
        if (this.bossCore) this.bossCore.holdFire = false;
      }
      return;
    }
    const alive = this.bossSentries.some((e) => this.enemies.includes(e));
    const core = this.bossCore;
    if (core && core.shielded && !alive) {
      core.shielded = false;
      this.audio.sfx.shieldDown();
      this.effects.ring(core.x, core.y, 0.3, 0x57ffd8, 9, 0.6);
      this.blast(tmpVec.set(core.x, core.y, 0), 0.8);
      this.flashMessage('SHIELD DOWN', 'Hit the core!', 1.6);
    }
    this.hangarTimer -= dt;
    if (this.hangarTimer <= 0) {
      const next = MathUtils.lerp(4.8, 3.2, difficulty) * (alive ? 1 : 0.8);
      // Lockstep carries the overshoot, so launches don't drift with frame rate.
      this.hangarTimer = this.lockstep ? this.hangarTimer + next : next;
      this.launchFighters(difficulty);
    }
  }

  private launchFighters(difficulty: number): void {
    const base = this.base;
    if (!base) return;
    const kind: EnemyKind = this.hangarLaunches++ % 2 === 0 ? 'grunt' : 'weaver';
    const hpScale = 1 + WAVES.hpGrowthPerWave * (this.spawner.wave - 1);
    for (const [dx, dy] of HANGAR_OFFSETS) {
      const x = base.x + dx;
      const y = base.y + dy;
      const netId = NET_HANGAR_ID + this.hangarCount++;
      if (this.net && this.netKills.has(netId)) continue;
      const e = new Enemy(kind, x, y, (netId * 2.4) % (Math.PI * 2), difficulty, hpScale, 0, this.fireRng(netId));
      e.netId = netId;
      this.enemies.push(e);
      this.scene.add(e.object);
      this.effects.flash(x, y, 0, 0xffa040, 4, 0.35);
      this.effects.ring(x, y, 0.1, 0xffa040, 3, 0.4);
    }
    this.audio.sfx.launch();
  }

  private destroyBase(): void {
    const base = this.base;
    this.bossDefeated = true;
    this.bossCore = null;
    this.setPhase('bossDown');
    const bonus = 2500 * Math.round(this.spawner.wave / 2);
    this.score += bonus;
    this.flashMessage('BASE DESTROYED', `+${bonus.toLocaleString('en-US')}`, BASE_DOWN_TIME);
    this.popEnemyBullets();
    // Everything it launched goes down with it (on every screen, so no need to report it).
    for (let i = this.enemies.length - 1; i >= 0; i--) this.killEnemy(i, 'cascade');
    base?.wreck();
    this.bossBursts = [0, 0.2, 0.35, 0.55, 0.7, 0.9, 1.1, 1.35, 1.6, 1.9, 2.3, 2.8];
    this.shake = 1.2;
    this.fx.kickAberration(1.5);
    navigator.vibrate?.(300);
  }

  /** Explosion chain across the dying base. */
  private updateBossBursts(dt: number): void {
    const base = this.base;
    if (!base) {
      this.bossBursts = [];
      return;
    }
    this.bossBursts = this.bossBursts.map((t) => t - dt);
    while (this.bossBursts.length > 0 && this.bossBursts[0]! <= 0) {
      this.bossBursts.shift();
      const first = this.bossBursts.length === 11;
      const x = base.x + (first ? 0 : MathUtils.randFloatSpread(10));
      const y = base.y + (first ? CORE_OFFSET[1] : MathUtils.randFloatSpread(9));
      this.effects.explode(x, y, [0xff3df0, 0xffb443, 0xffffff, 0xff5a36], first ? 120 : 40, first ? 18 : 10, first ? 1.3 : 0.8);
      this.effects.flash(x, y, 0.2, 0xfff1c9, first ? 14 : 6, 0.5);
      this.effects.ring(x, y, 0.2, first ? 0x57ffd8 : 0xffb443, first ? 16 : 6, first ? 0.9 : 0.5);
      this.blast(tmpVec.set(x, y, 0), first ? 2 : 0.7);
      this.shake = Math.max(this.shake, first ? 1.3 : 0.5);
      this.audio.sfx.explosion('big');
    }
  }

  private removeBase(): void {
    if (this.base) {
      this.scene.remove(this.base.object);
      this.base.dispose();
      this.base = null;
    }
    this.bossSentries.length = 0;
    this.bossCore = null;
    this.bossBursts = [];
    this.environment.clearClearing();
  }

  private get isStrikeWave(): boolean {
    return this.spawner.wave % COCKPIT.everyWaves === 0;
  }

  private startCockpitFight(): void {
    this.setPhase('cockpit');
    const tutorial = this.cockpitEntry?.tutorial;
    if (!tutorial || this.tutorialsOffered.has(tutorial)) return;
    this.tutorialsOffered.add(tutorial);
    this.tutorial.showIfWanted(tutorial, () => this.input.consumeDrag(this.drag));
  }

  private bootHud(): void {
    this.setPhase('hudBoot');
    this.cockpitOverlay.powerOn(COCKPIT.bootDuration);
    this.audio.sfx.hudBoot(COCKPIT.bootDuration);
    if (this.cockpitEntry) this.audio.music.play(this.cockpitEntry.music, 0.4);
    // Duck the music a little so calls, taps and cues cut through.
    this.audio.engine.setMusicLevel(MUSIC_LEVEL * 0.7, 1);
    this.setMusicCutoff(20000, COCKPIT.bootDuration);
  }

  private updateCockpit(dt: number): MiniGameStatus {
    const pf = this.playfield;
    if (!this.cockpit) return 'cleared';
    return this.cockpit.update(dt, {
      camera: this.camera,
      eye: this.director.eye,
      active: this.phase === 'cockpit',
      widthPx: pf.widthPx,
      heightPx: pf.heightPx,
      drag: this.drag,
      axis: this.input.axis,
    });
  }

  private endSectionIfDone(status: MiniGameStatus): void {
    const game = this.cockpit;
    if (status === 'running' || this.state !== 'playing' || !game) return;
    game.clearIncoming();
    this.setPhase('sectionEnd');
    const accuracy = game.accuracy;
    const combo = game.maxCombo;
    const { title, stats } = game.result();
    const bonus =
      Math.round(COCKPIT.clearBonusPerWave * this.spawner.wave * accuracy) + combo * COCKPIT.maxComboBonus;
    this.score += bonus;
    this.cockpitOverlay.showCallout(
      `${title}\n${stats}\n+${bonus.toLocaleString('en-US')}`,
      SECTION_END_PAUSE,
    );
    this.audio.sfx.squadronCleared();
  }

  /** In co-op, waits for the server to start the wave for the whole squad. */
  private startNextWave(): void {
    if (this.coop.status !== 'online' || this.netSolo) {
      this.beginWave(null);
      return;
    }
    this.net = null;
    this.netWanted = this.spawner.wave + 1;
    this.setPhase('sync');
    this.scrollFactor = 1;
    if (!this.coop.send({ t: 'ready', w: this.netWanted })) this.beginWave(null);
  }

  /** `net` starts the squad's wave (which may be ahead of ours, joining late); null plays solo. */
  private beginWave(net: Extract<CoopGameEvent, { t: 'wave' }> | null): void {
    this.setPhase('shmup');
    this.bossDefeated = false;
    this.scrollFactor = 1;
    this.spawnCount = 0;
    this.hangarCount = 0;
    this.netDamage.clear();
    if (net) {
      if (net.w !== this.spawner.wave + 1) {
        this.spawner.wave = net.w - 1;
        this.environment.set(environmentForWave(net.w));
      }
      this.net = { w: net.w, at: net.at, seed: net.seed, segment: 'wave', bossAt: 0, bossAsked: false };
      this.netClock = 0;
      this.netKills = new Set(net.kills);
      this.netPicks = new Set(net.picks);
      this.time = (net.w - 1) * NET_WAVE_TIME;
      this.netSquad = Math.max(1, net.squad ?? 1);
      this.spawner.startWave(this.time, seededRng(net.seed), this.netSquad);
    } else {
      this.net = null;
      this.spawner.startWave(this.time);
    }
    this.fireTimer = 0;
    this.audio.music.play(NOVA_DRIVE, 0.8);
    this.audio.engine.setMusicLevel(MUSIC_LEVEL, 1);
    this.setMusicCutoff(20000, 1.2);
    this.flashMessage(`WAVE ${this.spawner.wave}`, this.environment.nameOf(this.environment.id), 1.4);
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
    this.leaveSquad();
    this.tutorial.cancel();
    this.clearWorld();
    this.cockpit?.clear();
    this.director.reset();
    this.environment.set('space');
    this.audio.music.stop(0.8);
    this.audio.engine.setMusicLevel(MUSIC_LEVEL, 1);
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
    this.coop.disconnect();
    this.remoteShips.clear();
    this.unsubscribeTap();
    this.unsubscribePress();
    this.unsubscribeMove();
    this.unsubscribeRelease();
    this.clearWorld();
    this.miniGames.dispose();
    this.warp.dispose();
    this.interior.dispose();
    this.starfield.dispose();
    this.playerBullets.dispose();
    this.rockets.dispose();
    this.enemyBullets.dispose();
    this.effects.dispose();
    this.nebula.dispose();
    this.environment.dispose();
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
    else if (this.state === 'victory' && this.stateTime > VICTORY_INPUT_AT) this.startGame();
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
    this.leaveSquad();
    this.netSolo = false;
    this.clearWorld();
    this.state = 'playing';
    this.stateTime = 0;
    this.time = 0;
    this.score = 0;
    this.lives = PLAYER.lives;
    this.gunType = 'pulse';
    this.gunLevel = 1;
    this.rocketLevel = 0;
    this.barrier = false;
    this.fireTimer = 0;
    this.rocketTimer = 0;
    this.drops = 0;
    this.invulnerable = 1;
    this.spawner.reset();
    this.environment.set(environmentForWave(1));
    this.director.reset();
    this.cockpit?.clear();
    this.tutorialsOffered.clear();
    this.placePlayerAtStart();
    this.input.consumeDrag(this.drag);
    this.hud.hideMessage();
    this.messageTimer = 0;
    this.startNextWave();
    this.tutorial.showIfWanted('flight', () => this.input.consumeDrag(this.drag));
  }

  private gameOver(): void {
    this.leaveSquad();
    this.state = 'gameover';
    this.stateTime = 0;
    this.player.object.visible = false;
    this.messageTimer = 0;
    this.cockpit?.clear();
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
    this.deathBursts = [];
    this.removeBase();
    this.scrollFactor = 1;
    this.cancelUpgradeCinematic();
    this.environment.stopVictory();
    this.player.object.position.z = 0;
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
      this.fireTimer += GUNS[this.gunType].levels[this.gunLevel]!.interval;
      this.fireGun();
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

  private fireGun(): void {
    this.audio.sfx.shot();
    const y = this.player.y + 0.9;
    const gun = GUNS[this.gunType];
    const level = gun.levels[this.gunLevel]!;
    for (const [dx, deg] of level.shots) {
      const a = MathUtils.degToRad(90 + deg);
      const b = this.playerBullets.spawn(
        this.player.x + dx,
        y,
        Math.cos(a) * level.speed,
        Math.sin(a) * level.speed,
        0.3,
        level.life,
        gun.color,
      );
      if (!b) continue;
      b.rotation = MathUtils.degToRad(deg);
      b.scale = BOLT_SCALE[this.gunType];
      b.damage = level.damage;
      b.pierce = level.pierce;
    }
  }

  private damagePlayer(): void {
    if (this.invulnerable > 0) return;
    const { x, y } = this.player;
    if (this.barrier) {
      this.barrier = false;
      this.shake = 0.3;
      navigator.vibrate?.(40);
      this.audio.sfx.hit();
      this.effects.ring(x, y, 0.2, 0x8fd0ff, 4, 0.45);
      this.effects.explode(x, y, [0x8fd0ff, 0xffffff], 24, 8, 0.5);
      if (this.director.blend > 0) this.cockpitOverlay.hitFlash();
      // Not in co-op: the squad shares enemy fire, and it would only vanish from our screen.
      if (!this.net) this.popEnemyBullets();
      this.cockpit?.clearIncoming();
      this.invulnerable = PLAYER.invulnerableTime;
      this.flashMessage('BARRIER DOWN', '', 0.8);
      return;
    }
    this.lives--;
    if (this.lives > 0 && this.gunLevel > 1) {
      // Losing power on a hit keeps orbs worth chasing all game.
      this.gunLevel--;
      this.flashMessage('POWER DOWN', `${GUNS[this.gunType].name} ${this.gunLevel}/${MAX_GUN_LEVEL}`, 1);
    }
    this.shake = 0.6;
    navigator.vibrate?.(this.lives > 0 ? 80 : 250);
    this.audio.sfx.playerHit();
    this.fx.kickAberration(1.2);
    if (this.lives <= 0) {
      this.explodePlayer();
    } else if (this.director.blend > 0) {
      this.cockpitOverlay.hitFlash();
    } else {
      this.effects.explode(x, y, PLAYER_COLORS, 40, 12, 0.9);
      this.effects.ring(x, y, 0.2, 0x6ff3ff, 5, 0.5);
      this.blast(tmpVec.set(x, y, 0), this.lives > 1 ? 0.6 : 1.3);
    }

    // Clearing enemy fire on hit gives the player a moment to recover (solo; co-op shares the fire).
    if (!this.net) this.popEnemyBullets();
    this.cockpit?.clearIncoming();

    if (this.lives <= 0) {
      this.gameOver();
      return;
    }
    this.invulnerable = PLAYER.invulnerableTime;
  }

  /** Final hit: the ship blows up in a chain of explosions (in view, in first person too). */
  private explodePlayer(): void {
    this.player.destroyed = true;
    this.player.object.visible = false;
    this.shake = 1.2;
    if (this.director.blend > 0) {
      this.cockpitOverlay.hitFlash();
      // Keep the first-person view: the blasts go off right in front of the canopy.
      const eye = this.director.eye;
      this.deathCenter.set(eye.x, eye.y + 6, eye.z - 0.4);
      this.deathSpread = 3;
    } else {
      this.deathCenter.set(this.player.x, this.player.y, 0);
      this.deathSpread = 1.4;
    }
    this.deathBursts = [0, 0.14, 0.3, 0.5, 0.75];
    this.deathTime = 0;
  }

  private updateDeathBursts(dt: number): void {
    if (this.deathBursts.length === 0) return;
    this.deathTime += dt;
    const firstPerson = this.director.blend > 0;
    while (this.deathBursts.length > 0 && this.deathTime >= this.deathBursts[0]!) {
      const first = this.deathBursts.shift() === 0;
      const s = first ? 0 : this.deathSpread;
      const x = this.deathCenter.x + MathUtils.randFloatSpread(s * 2);
      const y = this.deathCenter.y + (firstPerson ? MathUtils.randFloatSpread(s) : MathUtils.randFloatSpread(s * 2));
      const z = this.deathCenter.z + (firstPerson ? MathUtils.randFloatSpread(s * 1.2) : 0.2);
      const size = first ? 1 : 0.6;
      this.effects.explode(x, y, PLAYER_COLORS, first ? 90 : 36, (first ? 16 : 10) * size, first ? 1.2 : 0.8, firstPerson ? z : undefined);
      this.effects.explode(x, y, [0xffe14d, 0xff5a36, 0xffffff], first ? 40 : 16, 7, 0.7, firstPerson ? z : undefined);
      this.effects.flash(x, y, z, 0xfff1c9, first ? 9 : 5, 0.5);
      this.effects.ring(x, y, z, 0xffb443, first ? 10 : 5, first ? 0.8 : 0.5, firstPerson);
      if (first) this.effects.ring(x, y, z, 0x6ff3ff, 6, 0.5, firstPerson);
      this.blast(tmpVec.set(x, y, z), first ? 1.5 : 0.6);
      this.shake = Math.max(this.shake, first ? 1.2 : 0.5);
      if (!first) this.audio.sfx.explosion('big');
    }
  }

  // --- Enemies, bullets, power-ups -----------------------------------------------------

  private popEnemyBullets(): void {
    for (let i = 0; i < this.enemyBullets.count; i++) {
      const b = this.enemyBullets.items[i]!;
      this.effects.explode(b.x, b.y, [0xff4f8b], 2, 3, 0.3);
    }
    this.enemyBullets.clear();
  }

  private readonly spawnEnemy = (kind: EnemyKind, x: number, yOffset: number, phase: number, delay = 0): void => {
    const netId = ++this.spawnCount;
    // Already shot down by the squad (we're catching up).
    if (this.net && this.netKills.has(netId)) return;
    const pf = this.playfield;
    const hpScale = 1 + WAVES.hpGrowthPerWave * (this.spawner.wave - 1);
    const y = pf.arenaTop + 2 + yOffset + (pf.shared ? SHARED_SPAWN_LIFT : 0);
    const enemy = new Enemy(kind, x, y, phase, this.spawner.difficulty, hpScale, delay, this.fireRng(netId));
    enemy.netId = netId;
    this.enemies.push(enemy);
    this.scene.add(enemy.object);
  };

  private updateEnemies(dt: number): void {
    const ctx = this.enemyContext;
    const difficulty = Math.min(this.time / DIFFICULTY_RAMP_TIME, 1);
    ctx.playerX = this.player.x;
    ctx.playerY = this.state === 'playing' ? this.player.y : this.playfield.bottom - 10;
    ctx.top = this.playfield.arenaTop;
    ctx.halfWidth = this.playfield.halfWidth;
    ctx.difficulty = difficulty;
    ctx.bulletSpeed = MathUtils.lerp(ENEMY_BULLET.speedMin, ENEMY_BULLET.speedMax, difficulty);
    ctx.shared = this.lockstep;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (!enemy.update(dt, ctx)) this.removeEnemyAt(i);
    }
  }

  private updateBullets(dt: number): void {
    const pf = this.playfield;
    this.playerBullets.update(dt, (b) => !pf.isOutside(b.x, b.y, 1));
    this.updateRockets(dt);
  }

  private updateEnemyBullets(dt: number): void {
    const pf = this.playfield;
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
      if (!e.active || e.shielded || e.y < y - 1 || e.y > this.playfield.top + 0.5) continue;
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
      // Bounces off the sides and top while it sinks toward the bottom.
      p.vy += (-POWERUP.fallSpeed - p.vy) * Math.min(1, dt * 0.8);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const edge = this.playfield.halfWidth - 0.7;
      if (Math.abs(p.x) > edge) {
        p.x = Math.sign(p.x) * edge;
        p.vx = -p.vx;
      }
      if (p.y > this.playfield.arenaTop - 1.2) {
        p.y = this.playfield.arenaTop - 1.2;
        p.vy = -Math.abs(p.vy);
      }
      p.cycleTimer -= dt;
      if (p.cycleTimer <= 0) {
        p.cycleTimer += POWERUP.cycle;
        this.setPowerupKind(p, (p.kindIndex + 1) % POWERUP_KINDS.length);
      }
      // A quick flicker warns that the colour is about to change.
      const warn = p.cycleTimer < 0.3 ? 0.85 + 0.15 * Math.cos(p.cycleTimer * 60) : 1;
      p.model.object.scale.setScalar(warn);
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
        if (!e.active || e === b.lastHit || !circlesOverlap(b.x, b.y, b.radius, e.x, e.y, e.radius)) continue;
        b.lastHit = e;
        const spent = --b.pierce <= 0 || e.shielded;
        this.effects.explode(b.x, b.y + 0.3, [GUNS[this.gunType].color, 0xffffff], 3, 5, 0.25);
        if (spent) this.playerBullets.remove(i);
        this.damageEnemy(j, b.damage);
        break;
      }
    }

    // Rockets vs enemies.
    for (let i = this.rockets.count - 1; i >= 0; i--) {
      const r = this.rockets.items[i]!;
      const j = this.enemies.findIndex((e) => e.active && circlesOverlap(r.x, r.y, r.radius, e.x, e.y, e.radius));
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
      const e = this.enemies[j];
      if (!e?.active || !circlesOverlap(e.x, e.y, e.radius * 0.8, px, py, PLAYER.hitRadius)) continue;
      if (this.invulnerable > 0) continue;
      this.damageEnemy(j, 6, false);
      this.damagePlayer();
      if (this.state !== 'playing') return;
    }

    // Power-up pickup.
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i]!;
      if (!circlesOverlap(p.x, p.y, 0.45, px, py, PLAYER.pickupRadius)) continue;
      const kind = POWERUP_KINDS[p.kindIndex]!;
      if (this.net) {
        this.netPicks.add(p.netId);
        this.coop.send({ t: 'pick', w: this.net.w, id: p.netId });
      }
      this.audio.sfx.powerup();
      if (this.applyPowerup(kind)) this.startUpgradeCinematic();
      this.effects.explode(p.x, p.y, [POWERUP_COLORS[kind], 0xffffff], 16, 6, 0.4);
      this.effects.ring(p.x, p.y, 0.2, POWERUP_COLORS[kind], 3.5, 0.4);
      navigator.vibrate?.(20);
      this.removePowerupObject(p);
      this.powerups.splice(i, 1);
    }
  }

  /** Our hit on an enemy; in co-op the damage is shared with the squad. */
  private damageEnemy(index: number, damage: number, sound = true): void {
    const e = this.enemies[index]!;
    if (e.hit(damage)) {
      this.killEnemy(index);
      return;
    }
    if (sound) this.audio.sfx.hit();
    if (this.net && !e.shielded) this.netDamage.set(e.netId, (this.netDamage.get(e.netId) ?? 0) + damage);
  }

  /**
   * `local`: we shot it (scores, and tells the squad). `remote`: a squadmate did. `cascade`: it
   * went down with the base, on every screen at once.
   */
  private killEnemy(index: number, source: 'local' | 'remote' | 'cascade' = 'local'): void {
    const e = this.enemies[index]!;
    if (source !== 'remote') this.score += e.score;
    if (this.net) {
      this.netKills.add(e.netId);
      this.netDamage.delete(e.netId);
      if (source === 'local') this.coop.send({ t: 'kill', w: this.net.w, id: e.netId });
    }
    if (e.kind === 'core' && e === this.bossCore) {
      if (source !== 'remote') this.score += e.score;
      this.removeEnemyAt(index);
      this.destroyBase();
      return;
    }
    const big = e.kind === 'tank' || e.kind === 'sprayer' || e.kind === 'sentry';
    this.effects.explode(e.x, e.y, EXPLOSION_COLORS[e.kind], big ? 60 : 22, big ? 11 : 8, big ? 0.9 : 0.55);
    this.effects.ring(e.x, e.y, 0.3, big ? 0xffb443 : 0xff5a36, big ? 8 : 3.2, big ? 0.6 : 0.35);
    if (big) {
      this.shake = Math.max(this.shake, 0.35);
      this.blast(tmpVec.set(e.x, e.y, 0), 1);
    }
    this.audio.sfx.explosion(big ? 'big' : 'small');
    if (e.kind === 'tank') this.spawnPowerup(e.x, e.y, e.netId);
    this.removeEnemyAt(index);
  }

  private rocketImpact(x: number, y: number, hitIndex: number): void {
    const splash = ROCKET_LEVELS[this.rocketLevel]!.splash;
    this.effects.explode(x, y, [0xffa040, 0xffe14d, 0xffffff], splash > 0 ? 18 : 10, splash > 0 ? 9 : 6, 0.35);
    if (splash > 0) this.effects.ring(x, y, 0.3, 0xffa040, splash * 2, 0.3);
    const target = this.enemies[hitIndex]!;
    const victims = new Set<Enemy>([target]);
    if (splash > 0) {
      for (const e of this.enemies) if (e.active && circlesOverlap(x, y, splash, e.x, e.y, e.radius)) victims.add(e);
    }
    for (const e of victims) {
      const index = this.enemies.indexOf(e);
      if (index >= 0) this.damageEnemy(index, e === target ? ROCKET.damage : ROCKET.splashDamage);
    }
  }

  /**
   * Catching the current gun's colour upgrades it; another gun's colour switches to that gun at
   * the same level (a side-grade, never both). Rockets upgrade rockets. A maxed weapon's colour
   * raises a barrier instead (or scores, if one is already up). Returns true if the hull
   * guns changed.
   */
  private applyPowerup(kind: PowerupKind): boolean {
    if (kind === 'rocket') {
      if (this.rocketLevel >= MAX_ROCKET) return this.overflowPowerup();
      this.rocketLevel++;
      const extra = ROCKET_LEVELS[this.rocketLevel]!;
      const note = this.rocketLevel === 1 ? 'Rockets online' : extra.splash > 0 ? 'Splash damage' : extra.homing ? 'Homing' : '';
      this.flashMessage('ROCKETS UP', `Level ${this.rocketLevel}/${MAX_ROCKET}${note ? ` · ${note}` : ''}`, 1.1);
      return true;
    }
    const gun = GUNS[kind];
    if (kind !== this.gunType) {
      this.gunType = kind;
      this.flashMessage(gun.name, `${gun.note} · Level ${this.gunLevel}/${MAX_GUN_LEVEL}`, 1.3);
      return true;
    }
    if (this.gunLevel >= MAX_GUN_LEVEL) return this.overflowPowerup();
    this.gunLevel++;
    this.flashMessage(`${gun.name} UP`, `Level ${this.gunLevel}/${MAX_GUN_LEVEL}`, 1.1);
    return true;
  }

  private overflowPowerup(): false {
    if (!this.barrier) {
      this.barrier = true;
      this.flashMessage('BARRIER', 'Absorbs the next hit', 1.1);
    } else {
      this.score += POWERUP.maxedScore;
      this.flashMessage('MAXED', `+${POWERUP.maxedScore}`, 0.9);
    }
    return false;
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

  /** Orbs start on the current gun's colour or rockets, alternately, then cycle. */
  private spawnPowerup(x: number, y: number, netId: number): void {
    if (this.net && this.netPicks.has(netId)) return;
    const model = createPowerup();
    model.object.position.set(x, y, 0);
    this.scene.add(model.object);
    if (this.drops === 0) this.flashMessage('POWER ORB', 'Its colour cycles · match your gun to upgrade', 2);
    // The squad's orbs start on the same colour everywhere.
    const first = this.net ? POWERUP_KINDS[netId % POWERUP_KINDS.length]! : this.drops % 2 === 0 ? 'rocket' : this.gunType;
    this.drops++;
    const p: Powerup = {
      netId,
      kindIndex: -1,
      model,
      x,
      y,
      vx: (x > 0 ? -1 : 1) * POWERUP.driftSpeed,
      vy: 2.5,
      cycleTimer: POWERUP.cycle,
    };
    this.setPowerupKind(p, POWERUP_KINDS.indexOf(first));
    this.powerups.push(p);
  }

  private setPowerupKind(p: Powerup, index: number): void {
    if (p.kindIndex >= 0) p.model.looks[POWERUP_KINDS[p.kindIndex]!].visible = false;
    p.kindIndex = index;
    p.model.looks[POWERUP_KINDS[index]!].visible = true;
  }

  /** Pulsing bubble around the ship while the barrier is up. */
  private updateBarrier(realDt: number): void {
    const material = this.barrierMesh.material;
    const target = this.barrier ? 0.16 + 0.06 * Math.sin(this.time * 5) : 0;
    material.opacity = MathUtils.damp(material.opacity, target, 10, realDt);
    this.barrierMesh.visible = material.opacity > 0.005;
  }

  private removePowerupObject(p: Powerup): void {
    this.scene.remove(p.model.object);
    disposeModel(p.model);
  }

  // --- Co-op ---------------------------------------------------------------------------

  /** The world runs on the squad's clock right now (see worldDt). */
  private get lockstep(): boolean {
    const net = this.net;
    if (!net || this.state !== 'playing') return false;
    return net.segment === 'wave' ? this.phase === 'shmup' : this.phase === 'bossApproach' || this.phase === 'boss';
  }

  /**
   * Seconds the world (spawns, enemies, their fire, orbs, the alien base) advances this frame.
   * In co-op it follows the server clock from the wave's start (and then the base fight's), so
   * every client sees the same enemies and shots in the same place; after a pause or a late
   * join it fast-forwards.
   */
  private worldDt(dt: number): number {
    const net = this.net;
    if (!net || !this.lockstep) return dt;
    const now = this.coop.serverNow();
    if (net.segment === 'wave' && net.bossAt > 0 && now >= net.bossAt) {
      const until = (net.bossAt - net.at) / 1000;
      if (until - this.netClock > NET_STEP) this.catchUp(until - this.netClock);
      this.startNetBoss(net);
    }
    const target = (now - net.at) / 1000;
    if (target - this.netClock > NET_CATCH_UP) this.catchUp(target - this.netClock - dt);
    // Real elapsed time, not the engine's capped frame dt, so slow devices don't fall behind.
    const step = Math.max(0, target - this.netClock);
    this.netClock += step;
    return step;
  }

  /** The squad's base fight begins (at the time the server set), on its own lockstep clock. */
  private startNetBoss(net: NetWave): void {
    // Stragglers here are ones the squad has shot down whose kills haven't reached us yet.
    this.spawner.skipWave();
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemyAt(i);
    net.segment = 'boss';
    net.at = net.bossAt;
    this.netClock = 0;
    this.startBoss();
  }

  private catchUp(seconds: number): void {
    this.catchingUp = true;
    for (let left = seconds; left > NET_STEP && this.lockstep; left -= NET_STEP) {
      this.netClock += NET_STEP;
      this.time += NET_STEP;
      if (this.phase !== 'shmup') this.updateBoss(NET_STEP, Math.min(this.time / DIFFICULTY_RAMP_TIME, 1));
      this.updateBase(NET_STEP);
      this.updateEnemyBullets(NET_STEP);
      this.updateEnemies(NET_STEP);
      if (this.phase === 'shmup') this.spawner.update(NET_STEP, this.playfield.halfWidth, this.spawnEnemy);
      this.updatePowerups(NET_STEP);
    }
    this.catchingUp = false;
    this.invulnerable = Math.max(this.invulnerable, NET_CATCH_UP_GRACE);
  }

  /** Seeds an enemy's fire timing in co-op, so it shoots at the same moments on every client. */
  private fireRng(netId: number): Rng | undefined {
    return this.net ? seededRng((this.net.seed ^ Math.imul(netId, 0x9e3779b1)) >>> 0) : undefined;
  }

  /**
   * Who `enemy` shoots and dives at. Solo: us. In lockstep co-op: a squad member picked by the
   * enemy's id, where they were NET_AIM_DELAY_MS before the shot was due, from the ship states
   * everyone sent, so every client aims the same way.
   */
  private aimFor(enemy: Enemy, late: number): { x: number; y: number } | null {
    const aim = this.aimPoint;
    const ctx = this.enemyContext;
    const net = this.net;
    if (!net || !ctx.shared) {
      aim.x = ctx.playerX;
      aim.y = ctx.playerY;
      return aim;
    }
    const at = net.at + (this.netClock - late) * 1000 - NET_AIM_DELAY_MS;
    const pilots = this.coop
      .pilotsAt(at)
      .filter((p) => p.flags & COOP_ALIVE && !(p.flags & COOP_COCKPIT) && (p.wave === net.w || p.wave === net.w - 1));
    const pick = pilots[enemy.netId % pilots.length];
    if (!pick) return null;
    aim.x = pick.x * this.playfield.halfWidth;
    aim.y = pick.y * this.playfield.arenaTop;
    return aim;
  }

  private onCoopEvent(e: CoopGameEvent): void {
    if (this.state !== 'playing') return;
    if (e.t === 'wave') {
      if (this.phase === 'sync' && e.w >= this.netWanted) this.beginWave(e);
      return;
    }
    if (e.t === 'out') {
      this.squadmateOut(e.id, e.quit === true);
      return;
    }
    const net = this.net;
    if (!net || e.w !== net.w) return;
    switch (e.t) {
      case 'boss':
        net.bossAt = e.at;
        break;
      case 'kill': {
        this.netKills.add(e.id);
        const index = this.enemies.findIndex((en) => en.netId === e.id);
        if (index >= 0) this.killEnemy(index, 'remote');
        break;
      }
      case 'dmg':
        for (const [id, damage] of e.h) {
          const index = this.enemies.findIndex((en) => en.netId === id);
          const enemy = this.enemies[index];
          if (enemy?.active && typeof damage === 'number' && enemy.hit(damage)) this.killEnemy(index, 'remote');
        }
        break;
      case 'pick': {
        this.netPicks.add(e.id);
        const index = this.powerups.findIndex((p) => p.netId === e.id);
        const p = this.powerups[index];
        if (!p) break;
        this.effects.explode(p.x, p.y, [POWERUP_COLORS[POWERUP_KINDS[p.kindIndex]!], 0xffffff], 10, 5, 0.35);
        this.removePowerupObject(p);
        this.powerups.splice(index, 1);
        break;
      }
    }
  }

  private squadmateOut(id: number, quit: boolean): void {
    const at = this.remoteShips.positionOf(id);
    if (!quit && at && this.director.blend < 0.3) {
      this.effects.explode(at.x, at.y, [0xffffff, 0xffb443, 0xff5a36], 60, 12, 1);
      this.effects.ring(at.x, at.y, 0.2, 0xffb443, 6, 0.6);
      this.audio.sfx.explosion('big');
    }
    if (this.phase !== 'cockpit' && this.phase !== 'hudBoot') {
      this.flashMessage(quit ? 'WINGMATE LEFT' : 'WINGMATE DOWN', 'Fight on!', 1.6);
    }
  }

  /** Tells the server we're out of the squad's run (game over, quit, solo testing). */
  private leaveSquad(): void {
    if (this.net || this.phase === 'sync' || this.state === 'playing') this.coop.send({ t: 'out' });
    this.net = null;
    this.netDamage.clear();
  }

  private goSolo(): void {
    this.leaveSquad();
    this.netSolo = true;
  }

  /** Reports damage to the squad in batches; kills are reported as they happen. */
  private flushNetDamage(realDt: number): void {
    this.netDamageTimer -= realDt;
    if (this.netDamageTimer > 0) return;
    this.netDamageTimer = NET_DAMAGE_INTERVAL;
    if (!this.net || this.netDamage.size === 0) return;
    const h: [number, number][] = [];
    for (const [id, damage] of this.netDamage) h.push([id, Math.round(damage * 100) / 100]);
    this.netDamage.clear();
    this.coop.send({ t: 'dmg', w: this.net.w, h });
  }

  /** Shares our ship with the server and draws everybody else's. */
  private updateCoop(realDt: number): void {
    const pf = this.playfield;
    if (this.coop.status === 'online') {
      const playing = this.state === 'playing';
      const firing = playing && !this.frozen && (this.phase === 'shmup' || this.phase === 'bossApproach' || this.phase === 'boss');
      this.flushNetDamage(realDt);
      this.coop.sendState({
        x: this.player.x / pf.halfWidth,
        y: this.player.y / pf.arenaTop,
        flags:
          (playing && !this.player.destroyed ? COOP_ALIVE : 0) |
          (firing ? COOP_FIRING : 0) |
          (this.director.blend > 0.5 ? COOP_COCKPIT : 0) |
          (playing && this.invulnerable > 0 ? COOP_HURT : 0),
        gun: GUN_TYPES.indexOf(this.gunType),
        gunLevel: this.gunLevel,
        rocketLevel: this.rocketLevel,
        wave: this.spawner.wave,
      });
    }
    const players = this.coop.status === 'online' ? this.coop.remotes() : [];
    this.remoteShips.update(realDt, players, pf, this.director.blend < 0.3 && this.director.victory < 0);
  }

  private coopLabel(): string {
    const c = this.coop;
    switch (c.status) {
      case 'off':
        return 'Co-op: Off';
      case 'connecting':
        return 'Co-op: Connecting…';
      case 'error':
        return `Co-op: ${c.error || 'error'} (retrying)`;
      case 'online':
        return `Co-op: On · ${c.others + 1} online${c.rttMs ? ` · ${c.rttMs} ms` : ''}`;
    }
  }

  private toggleCoop(): void {
    if (this.coop.status !== 'off') {
      this.coop.disconnect();
      saveCoop(coopServerUrl(), false);
      return;
    }
    const url = coopServerUrl();
    saveCoop(url, true);
    this.coop.connect(url);
  }

  // --- Presentation ----------------------------------------------------------------------

  /** Screen shockwave (and a little aberration) at a world position. */
  private blast(position: Vector3, strength: number): void {
    tmpVec.copy(position).project(this.camera);
    if (tmpVec.z > 1) return;
    this.fx.shockwave((tmpVec.x + 1) / 2, (tmpVec.y + 1) / 2, strength);
    this.fx.kickAberration(0.5 * strength);
  }

  /** Zoom blur while the camera swoops between views. */
  private updateFx(realDt: number): void {
    const blend = this.director.blend;
    const speed = realDt > 0 ? Math.abs(blend - this.prevBlend) / realDt : 0;
    this.prevBlend = blend;
    const transition = this.director.transitioning ? speed * COCKPIT.enterDuration * 0.45 : 0;
    this.fx.zoomBlur = MathUtils.damp(this.fx.zoomBlur, transition + blend * 0.06, 8, realDt);
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
    this.hud.setCoop(this.coop.status === 'online' ? `CO-OP · ${this.coop.others + 1}` : this.coop.status === 'connecting' ? 'CO-OP …' : '');
    this.hud.setWeapons(GUNS[this.gunType], this.gunLevel, MAX_GUN_LEVEL, this.rocketLevel, MAX_ROCKET, this.barrier);
  }
}

const tmpVec = new Vector3();

/** The `round`-th (1-based) strike that happens over one of `worlds`. */
function nthStrikeIn(worlds: readonly MiniGameWorld[], round: number): number {
  for (let strike = 1, seen = 0; strike < 100; strike++) {
    if (worlds.includes(worldOf(environmentForWave(strike * COCKPIT.everyWaves))) && ++seen === round) return strike;
  }
  return 1;
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
