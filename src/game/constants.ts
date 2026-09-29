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
  fireInterval: 0.12,
  bulletSpeed: 30,
  invulnerableTime: 2,
  maxWeaponLevel: 3,
};

export const ENEMY_BULLET = {
  radius: 0.22,
  speedMin: 6.5,
  speedMax: 9.5,
};

/** Seconds of play until difficulty ramps to its maximum. */
export const DIFFICULTY_RAMP_TIME = 150;

export const POWERUP = {
  fallSpeed: 2.5,
  /** Drop chance for enemies that don't always drop one. */
  dropChance: 0.03,
  maxedScore: 500,
};

export const HISCORE_STORAGE_KEY = 'nova-strike:hiscore';

export const WAVES = {
  /** Formations in wave n (1-based) = base + perWave * (n - 1), capped. */
  baseFormations: 7,
  formationsPerWave: 2,
  maxFormations: 18,
  /** Enemy HP grows by this fraction of base HP each wave. */
  hpGrowthPerWave: 0.2,
};

export const COCKPIT = {
  fov: 72,
  /** Seconds for the camera to fly into / out of the cockpit. */
  enterDuration: 4.2,
  exitDuration: 3.2,
  /** Seconds of HUD power-on animation before the fight starts. */
  bootDuration: 1.8,
  /** Section ends (remaining enemies flee) after this many seconds. */
  timeLimit: 24,
  maxLocks: 8,
  /** Minimum seconds between two locks on the same target while swiping. */
  relockDelay: 0.2,
  /** Minimum touch radius in CSS pixels for locking; small targets get this much slack. */
  minLockRadiusPx: 34,
  rocketSpeed: 34,
  orbSpeed: 7,
  orbSpeedPerWave: 0.8,
  clearBonusPerWave: 1000,
  timeBonusPerSecond: 50,
};
