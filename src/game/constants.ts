export const GAME_TITLE = 'NOVA STRIKE';

export const PLAYFIELD = {
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
