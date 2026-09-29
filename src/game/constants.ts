export const GAME_TITLE = 'NOVA STRIKE';

export const PLAYFIELD = {
  /** Vertical FOV of the top-down camera. */
  fov: 60,
  /** Visible height in world units when the screen is wide enough. */
  height: 24,
  /** Minimum visible width; narrow portrait screens pull the camera back to keep this. */
  minWidth: 13,
  /** Playable width cap, so landscape screens don't get an absurdly wide arena. */
  maxWidth: 22,
};

export const PLAYER = {
  lives: 3,
  /** Hitbox is much smaller than the model, as is traditional (and fair on small screens). */
  hitRadius: 0.35,
  /** Radius for collecting power-ups. */
  pickupRadius: 1.1,
  keyboardSpeed: 14,
  dragSensitivity: 1.3,
  bulletSpeed: 30,
  invulnerableTime: 2,
};

/**
 * Laser levels (index = level, 1-based): seconds between volleys and the shots per volley as
 * [x offset, angle in degrees]. Lasers do 1 damage per bolt.
 */
export const LASER_LEVELS: readonly { interval: number; shots: readonly (readonly [number, number])[] }[] = [
  { interval: 1, shots: [] },
  { interval: 0.12, shots: [[-0.3, 0], [0.3, 0]] },
  { interval: 0.12, shots: [[0, 0], [-0.4, 0], [0.4, 0]] },
  { interval: 0.11, shots: [[0, 0], [-0.4, 0], [0.4, 0], [-0.65, 9], [0.65, -9]] },
  { interval: 0.1, shots: [[-0.2, 0], [0.2, 0], [-0.5, 0], [0.5, 0], [-0.7, 8], [0.7, -8]] },
  {
    interval: 0.09,
    shots: [[0, 0], [-0.3, 0], [0.3, 0], [-0.6, 0], [0.6, 0], [-0.75, 10], [0.75, -10], [-0.85, 20], [0.85, -20]],
  },
];

/**
 * Rocket levels (0 = no rockets): seconds between salvos, launch x offsets, whether rockets
 * home in on the nearest enemy, and splash radius (0 = none).
 */
export const ROCKET_LEVELS: readonly { interval: number; offsets: readonly number[]; homing: boolean; splash: number }[] = [
  { interval: 1, offsets: [], homing: false, splash: 0 },
  { interval: 0.85, offsets: [0], homing: false, splash: 0 },
  { interval: 0.8, offsets: [-0.7, 0.7], homing: false, splash: 0 },
  { interval: 0.65, offsets: [-0.7, 0.7], homing: true, splash: 0 },
  { interval: 0.55, offsets: [-0.8, 0, 0.8], homing: true, splash: 2 },
];

export const ROCKET = {
  damage: 6,
  splashDamage: 3,
  launchSpeed: 6,
  maxSpeed: 26,
  acceleration: 45,
  /** Turn rate toward the target for homing rockets (higher = tighter). */
  steer: 5,
  radius: 0.3,
};

export const ENEMY_BULLET = {
  radius: 0.22,
  speedMin: 6.5,
  speedMax: 9.5,
};

/** Seconds of play until difficulty ramps to its maximum. */
export const DIFFICULTY_RAMP_TIME = 150;

/** Power-ups only come from heavies (tanks), alternating rocket/laser, skipping maxed weapons. */
export const POWERUP = {
  fallSpeed: 2.5,
  maxedScore: 500,
};

export const HISCORE_STORAGE_KEY = 'nova-strike:hiscore';

export const WAVES = {
  /** Formations in wave n (1-based) = base + perWave * (n - 1), capped. */
  baseFormations: 7,
  formationsPerWave: 2,
  maxFormations: 18,
  /** Enemy HP grows by this fraction of base HP each wave. */
  hpGrowthPerWave: 0.15,
  /**
   * Heavies come on a fixed schedule: at these fractions of the wave's formations.
   * Waves before `twoTanksFromWave` get only the first one.
   */
  tankSlots: [0.35, 0.75],
  singleTankSlot: 0.55,
  twoTanksFromWave: 3,
};

export const COCKPIT = {
  fov: 72,
  /** Seconds for the camera to fly into / out of the cockpit. */
  enterDuration: 4.2,
  exitDuration: 3.2,
  /** Seconds of HUD power-on animation before the fight starts. */
  bootDuration: 1.8,
  /** A cockpit strike happens after every this many waves. */
  everyWaves: 2,
  /**
   * Call-and-response phrases per strike (base + per strike). Each phrase is two bars:
   * enemies warp in on a rhythm (call), then the player taps them back in order (response).
   */
  phrases: 6,
  phrasesPerStrike: 1,
  /** Phrases with misses cost a shield pip (refilled each strike); with none left, a life. */
  shield: 3,
  /** Beats an approach ring takes to close onto its target. */
  approachBeats: 1,
  /** Timing windows (ms either side of the beat) for each judgement. */
  perfectMs: 70,
  greatMs: 130,
  goodMs: 200,
  /** Tapping a target earlier than `goodMs` but within this is a MISS (no spamming). */
  earlyMissMs: 350,
  /** Added to tap times to compensate for touch latency; raise if hits feel late. */
  inputOffsetMs: 0,
  /** Minimum touch radius in CSS pixels, as a fraction of the shorter screen side. */
  hitRadius: 0.13,
  /** Combo needed for Overdrive (gold rockets, double points). */
  overdriveCombo: 16,
  /** Combo steps that each add +0.5 to the score multiplier (before Overdrive). */
  comboStep: 8,
  clearBonusPerWave: 1000,
  maxComboBonus: 25,
};
