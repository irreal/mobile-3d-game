import type { PerspectiveCamera, Vector3 } from 'three';
import type { Vec2 } from '../../input/Input.ts';
import type { EnvironmentId } from '../Environment.ts';

/**
 * A first-person mini-game played from the cockpit between waves (a "strike"). The scene owns
 * everything around it: the fly-in, HUD power-on, results card, clear bonus and fly-out. A
 * mini-game only plays its part in between. See docs/MINI_GAMES.md.
 */
export interface MiniGame {
  /** 0..1 performance this strike (notes hit, rings flown through…); scales the clear bonus. */
  readonly accuracy: number;
  /** Best combo this strike; adds to the clear bonus. */
  readonly maxCombo: number;
  /** Set up a new strike. Called as the camera starts flying in; `frame.active` turns true on arrival. */
  start(context: MiniGameContext): void;
  /** Runs every frame from `start` until it returns 'cleared', and on through the results card. */
  update(dt: number, frame: MiniGameFrame): MiniGameStatus;
  /** Press, pointer move and release, in CSS pixels (y down). `perfMs` is the event's performance.now(). */
  tap(x: number, y: number, perfMs: number): void;
  drag(x: number, y: number): void;
  release(): void;
  /** Remove incoming fire: the player was just hit (a moment to recover), or the strike is over. */
  clearIncoming(): void;
  /** The simulation resumes after being frozen (pause menu, tutorial). */
  onResume(): void;
  /** Results card text once cleared. */
  result(): { title: string; stats: string };
  /** Stop and hide everything (strike over, game over, quit). Must be safe to call any time. */
  clear(): void;
  dispose(): void;
}

/** Which kind of place a strike happens over. */
export type MiniGameWorld = 'space' | 'planet';

export interface MiniGameContext {
  /** 1-based strike number this game (one strike every `COCKPIT.everyWaves` waves). */
  strike: number;
  world: MiniGameWorld;
  environment: EnvironmentId;
  /** Ship position in the top-down view when the strike began. */
  shipX: number;
  shipY: number;
  /** Screen width / height. */
  aspect: number;
  /** Players in the co-op squad (1 solo). Each plays their own strike; the squad regroups at the next wave. */
  squad: number;
}

export type MiniGameStatus = 'running' | 'cleared';

export interface MiniGameFrame {
  camera: PerspectiveCamera;
  /** Unshaken eye position; return fire aims here. */
  eye: Vector3;
  /** True once the camera has fully arrived in the cockpit. */
  active: boolean;
  widthPx: number;
  heightPx: number;
  /** Steering this frame: drag in CSS pixels (y up), and the keyboard axis. */
  drag: Vec2;
  axis: Vec2;
}

/** What a mini-game can do to the rest of the game. */
export interface MiniGameCallbacks {
  addScore: (points: number) => void;
  /** The player is hit; the scene takes the barrier, or a life and a gun level. */
  playerHit: () => void;
  /** Big explosion at a world position (screen shockwave etc.), strength ~0..1.5. */
  blast: (position: Vector3, strength: number) => void;
}
