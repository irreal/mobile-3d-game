import type { Scene } from 'three';
import type { Music } from '../../audio/Music.ts';
import type { Sfx } from '../../audio/Sfx.ts';
import { LOCK_ON } from '../../audio/songs.ts';
import type { Song } from '../../audio/songs.ts';
import type { CockpitOverlay } from '../../ui/CockpitOverlay.ts';
import type { TutorialId } from '../../ui/Tutorial.ts';
import type { Effects } from '../Effects.ts';
import type { EnvironmentId } from '../Environment.ts';
import { AsteroidRun } from './AsteroidRun.ts';
import type { MiniGame, MiniGameCallbacks, MiniGameWorld } from './MiniGame.ts';
import { RhythmStrike } from './RhythmStrike.ts';

/** What a mini-game gets to build itself with. */
export interface MiniGameDeps {
  scene: Scene;
  effects: Effects;
  overlay: CockpitOverlay;
  sfx: Sfx;
  music: Music;
  callbacks: MiniGameCallbacks;
}

export interface MiniGameEntry {
  id: string;
  /** Shown in the pause-menu test row. */
  name: string;
  /** Off: never picked between waves (the pause-menu test can still start it). */
  enabled: boolean;
  /** Where it can be played; a strike with no enabled game for its world is skipped. */
  worlds: readonly MiniGameWorld[];
  /** Cockpit music while it runs. */
  music: Song;
  /** Shown before its first strike each game, if the player hasn't dismissed it for good. */
  tutorial?: TutorialId;
  create: (deps: MiniGameDeps) => MiniGame;
}

export const MINI_GAMES: readonly MiniGameEntry[] = [
  {
    id: 'asteroids',
    name: 'Asteroids',
    enabled: true,
    worlds: ['space'],
    music: LOCK_ON,
    create: (d) => new AsteroidRun(d.scene, d.effects, d.overlay, d.sfx, d.callbacks),
  },
  {
    id: 'rhythm',
    name: 'Rhythm',
    // Not fun enough yet; flip back on to have it over planets again.
    enabled: false,
    worlds: ['planet'],
    music: LOCK_ON,
    tutorial: 'cockpit',
    create: (d) => new RhythmStrike(d.scene, d.effects, d.overlay, d.sfx, d.music, d.callbacks),
  },
];

export function worldOf(environment: EnvironmentId): MiniGameWorld {
  return environment === 'space' ? 'space' : 'planet';
}

/**
 * The game for strike `strike` over `world`: the enabled ones that fit take turns. It depends on
 * nothing but the strike, so every player in a co-op squad gets the same one. Null: no strike.
 */
export function pickMiniGame(world: MiniGameWorld, strike: number, entries = MINI_GAMES): MiniGameEntry | null {
  const fits = entries.filter((e) => e.enabled && e.worlds.includes(world));
  return fits.length > 0 ? fits[(Math.max(1, strike) - 1) % fits.length]! : null;
}

/** Builds each mini-game the first time it's needed and keeps it for later strikes. */
export class MiniGameLibrary {
  private readonly games = new Map<string, MiniGame>();

  constructor(private readonly deps: MiniGameDeps) {}

  get(entry: MiniGameEntry): MiniGame {
    let game = this.games.get(entry.id);
    if (!game) this.games.set(entry.id, (game = entry.create(this.deps)));
    return game;
  }

  dispose(): void {
    for (const game of this.games.values()) game.dispose();
    this.games.clear();
  }
}
