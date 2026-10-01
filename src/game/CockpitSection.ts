import { AdditiveBlending, Color, CylinderGeometry, MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { Music } from '../audio/Music.ts';
import type { Sfx } from '../audio/Sfx.ts';
import type { Vec2 } from '../input/Input.ts';
import type { BeamGuide, CockpitOverlay, Grade, LaneNote, NoteMarker, PhraseMode } from '../ui/CockpitOverlay.ts';
import { COCKPIT } from './constants.ts';
import type { Effects } from './Effects.ts';
import { ENEMY_STATS, EXPLOSION_COLORS } from './Enemy.ts';
import type { EnemyKind } from './Enemy.ts';
import { replyDelayBeats } from './replyDelay.ts';
import { createGlowMaterial, glowGeometry } from './glow.ts';
import { disposeModel, sharedGeometries } from './models.ts';
import type { Model } from './models.ts';

interface Fighter {
  kind: EnemyKind;
  model: Model;
  baseEmissive: number[];
  position: Vector3;
  radius: number;
  hp: number;
  /** Heavies take several hits and stay for the next call. */
  heavy: boolean;
  /** Screen position from the last overlay update (null when off screen). */
  screen: { x: number; y: number; r: number } | null;
  /** Rockets in flight at this fighter. */
  inFlight: number;
  alive: boolean;
  start: Vector3;
  hover: Vector3;
  /** Beat its warp exit starts; it flashes into view on `arriveBeat`. */
  warpStartBeat: number;
  arriveBeat: number;
  visible: boolean;
  warpedIn: boolean;
  /** Warping back out (missed, or the strike is over); seconds since it started leaving. */
  leaving: number | null;
  phase: number;
  flash: number;
  /** Speed streak shown while dropping out of warp. */
  streak: Mesh | null;
}

/** One enemy in a phrase: it calls on `callBeat`, and must be tapped on `callBeat + phrase.reply`. */
interface Note {
  /** The target; for a laser row, its first ship. */
  fighter: Fighter;
  /** A laser row: ships lined up on one call, cut with one swipe (first to last). */
  chain: Fighter[] | null;
  callBeat: number;
  beat: number;
  order: number;
  phrase: Phrase;
  callSounded: boolean;
  called: boolean;
  judged: boolean;
  missed: boolean;
  /** Screen position from the last overlay update, used to hit-test taps. */
  sx: number;
  sy: number;
  sr: number;
  onScreen: boolean;
}

/** The call bar from `start`, a pause, the response bar, then a rest. */
interface Phrase {
  start: number;
  /** Beats from each call to its reply; the swoosh ends on the first reply. */
  reply: number;
  notes: Note[];
  resolved: boolean;
  /** The "your turn" cue at the start of the response bar. */
  cueSounded: boolean;
  cueShown: boolean;
}

/** A laser swipe in progress over a row's ships. */
interface Swipe {
  note: Note;
  grade: 'perfect' | 'great' | 'good';
  startBeat: number;
  x: number;
  y: number;
}

/** A short-lived laser beam from the cockpit to a ship it cut. */
interface Beam {
  mesh: Mesh;
  age: number;
}

/** Return fire from enemies that weren't hit; lands on `hitBeat`. */
interface Volley {
  bolts: { mesh: Mesh; from: Vector3 }[];
  fireBeat: number;
  hitBeat: number;
}

interface Rocket {
  mesh: Mesh;
  target: Fighter;
  from: Vector3;
  ctrl: Vector3;
  launchBeat: number;
  impactBeat: number;
  gold: boolean;
  /** No music clock to pre-schedule on: play the impact sound when it lands. */
  soundOnImpact: boolean;
  lethal: boolean;
}

export type SectionStatus = 'running' | 'cleared';

export interface CockpitFrame {
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

/** A first-person mini-game played between waves. */
export interface CockpitGame {
  readonly accuracy: number;
  readonly maxCombo: number;
  /** Prepares strike number `strike` (1-based) ahead of the ship at (`shipX`, `shipY`). */
  start(shipX: number, shipY: number, strike: number, aspect: number): void;
  tap(x: number, y: number, perfMs: number): void;
  drag(x: number, y: number): void;
  release(): void;
  /** Cancels incoming fire (used when the player takes a hit). */
  popOrbs(): void;
  update(dt: number, frame: CockpitFrame): SectionStatus;
  /** Results card text once cleared. */
  result(): { title: string; stats: string };
  /** Call when the simulation resumes after being frozen. */
  resync(): void;
  clear(): void;
  dispose(): void;
}

export interface CockpitCallbacks {
  addScore: (points: number) => void;
  playerHit: () => void;
  /** Big explosion at a world position (screen shockwave etc.), strength ~0..1.5. */
  blast: (position: Vector3, strength: number) => void;
}

const COCKPIT_SCORE: Record<EnemyKind, number> = {
  grunt: 200,
  weaver: 250,
  tank: 1200,
  diver: 150,
  sprayer: 1200,
  swooper: 250,
  sentry: 800,
  core: 5000,
};
const NOTE_SCORE: Record<'perfect' | 'great' | 'good', number> = { perfect: 100, great: 70, good: 40 };
const GRADE_LABEL: Record<Exclude<Grade, 'call'>, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  miss: 'MISS',
};
/**
 * Call rhythms per bar in 8th notes ('x' = an enemy calls), by difficulty level. The
 * level rises with each strike and again halfway through a strike. Calls stay early in the
 * bar so there is a clear gap before the response.
 */
const PATTERNS: readonly (readonly string[])[] = [
  ['x...x...', 'x.x.x...', 'x.x.....', 'x...xx..'],
  ['x.x.x...', 'x..x.x..', 'xx..x...', 'x.xx....', 'x.x.xx..'],
  ['x.xxx...', 'xx.x.x..', 'x.x.xx..', 'x..xxx..', 'xx.xx...'],
  ['x.xxxx..', 'xx.xxx..', 'xxx.xx..', 'xxxx.x..', 'x.xxx.x.'],
];
/** Beats the swoosh builds before cutting off on the first reply. */
const CUE_RISE_BEATS = 2;
/** Beats per phrase (call, pause, response, rest), kept on bar lines. */
function phraseBeats(reply: number): number {
  return Math.ceil((reply + 7) / 4) * 4;
}
/** After taking a hit, at least this many beats pass before the next phrase (on a bar line). */
const HIT_PAUSE_BEATS = 7;
/** Beats a laser swipe may take from its first touch to cutting the last ship. */
const SWIPE_BEATS = 1;
/** Seconds a laser beam stays visible. */
const BEAM_LIFE = 0.22;
/** Height of the laser row's centre line (tap targets sit below it). */
const LASER_ROW_Z = 3.6;
/** Regular targets, cycled through in call order. */
const SMALL_KINDS: readonly EnemyKind[] = ['grunt', 'weaver', 'swooper'];
/** Hits a heavy takes; it stays and joins one call per phrase until destroyed. */
const HEAVY_HP = 2;
/** Fallback tempo when there is no music clock (no Web Audio). Matches LOCK_ON. */
const FALLBACK_BPM = 146;
/** Rockets fly at least this many beats, then land on the next 8th note. */
const MIN_FLIGHT_BEATS = 0.45;
/** Beats of warp exit before a fighter flashes into view on its call, and after. */
const WARP_LEAD_BEATS = 0.75;
const WARP_BEATS = 1.6;
/** Beats return fire takes to reach the cockpit. */
const VOLLEY_BEATS = 1.5;
const FIGHTER_SCALE = 1.4;
/** Pitch toward the cockpit so the ships show their top silhouette while facing you. */
const FIGHTER_PITCH = 0.95;
/** How far ahead fighters start their warp exit. */
const WARP_IN_DISTANCE = 80;
const FIGHTER_DEPTH = 20;
const HEAVY_DEPTH = 27;
const WARP_FLASH_COLORS = [0x9fe8ff, 0xffffff, 0x6ff3ff];
const BOLT_COLORS = [0xff4f8b, 0xffffff];
const GOLD_COLORS = [0xffd23d, 0xffffff, 0xff8a3d];
const UP = new Vector3(0, 1, 0);
const beamGeometry = new CylinderGeometry(0.07, 0.16, 1, 8, 1, true).translate(0, 0.5, 0);
const tmp = new Vector3();
const tmp2 = new Vector3();

/**
 * First-person "strike" fight between waves: a call-and-response rhythm game locked to
 * the cockpit music. Each phrase is two bars. In the call bar, enemies drop out of warp
 * one by one on a rhythm, each with its own tone. In the response bar the player taps
 * them back in the same order and rhythm (numbered circles and a ring on the next one
 * help). Each hit fires a rocket that lands and explodes on a following 8th note.
 * Enemies that weren't hit fire back at the end of the phrase (draining the shield,
 * then lives) and warp away. Heavies stay and join the next call until destroyed.
 */
export class CockpitSection implements CockpitGame {
  private readonly fighters: Fighter[] = [];
  private readonly phrases: Phrase[] = [];
  private readonly volleys: Volley[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly markers: NoteMarker[] = [];
  private readonly lane: LaneNote[] = [];
  private readonly boltMaterial = createGlowMaterial({ size: 1.4, intensity: 1.45, core: 0.35, color: [1, 0.3, 0.55] });
  private readonly rocketMaterial = new MeshBasicMaterial({ color: new Color(0xfff1c9).multiplyScalar(1.4) });
  private readonly goldMaterial = new MeshBasicMaterial({ color: new Color(0xffd23d).multiplyScalar(1.8) });
  private readonly beams: Beam[] = [];
  private readonly beamGuides: BeamGuide[] = [];
  private swipe: Swipe | null = null;
  /** Laser rows introduced with a callout so far (only the first few get one). */
  private laserIntros = 0;
  private readonly beamMaterial = new MeshBasicMaterial({
    color: new Color(0x57ff9a).multiplyScalar(2),
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  private readonly streakMaterial = new MeshBasicMaterial({
    color: new Color(0x9fe8ff).multiplyScalar(1.3),
    transparent: true,
    opacity: 0.85,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  private readonly anchor = new Vector3();
  private readonly eye = new Vector3();
  private strike = 1;
  private aspect = 1;
  private running = false;
  private active = false;
  private widthPx = 1;
  private heightPx = 1;
  /** Song position in beats as heard now. */
  private beat = 0;
  private fallbackOrigin = 0;
  private resyncPending = false;
  /** Start beat of the next phrase to plan, or NaN before the first one. */
  private nextPhrase = Number.NaN;
  private phraseCount = 0;
  private totalPhrases = 0;
  private launchSide = 1;
  private shield: number = COCKPIT.shield;
  private notesTotal = 0;
  private notesHit = 0;
  private lastFrame: CockpitFrame | null = null;
  combo = 0;
  maxCombo = 0;

  constructor(
    private readonly scene: Scene,
    private readonly effects: Effects,
    private readonly overlay: CockpitOverlay,
    private readonly sfx: Sfx,
    private readonly music: Music,
    private readonly callbacks: CockpitCallbacks,
  ) {}

  get overdrive(): boolean {
    return this.combo >= COCKPIT.overdriveCombo;
  }

  /** Fraction of notes hit this strike (1 when there were none). */
  get accuracy(): number {
    return this.notesTotal > 0 ? this.notesHit / this.notesTotal : 1;
  }

  private get multiplier(): number {
    return this.overdrive ? 2 : 1 + Math.floor(this.combo / COCKPIT.comboStep) * 0.5;
  }

  private get beatMs(): number {
    return 60000 / (this.music.playing?.bpm ?? FALLBACK_BPM);
  }

  /** Prepares strike number `strike` (1-based) ahead of the ship at (`shipX`, `shipY`). */
  start(shipX: number, shipY: number, strike: number, aspect: number): void {
    this.clear();
    this.running = true;
    this.anchor.set(shipX, shipY, 0);
    this.strike = strike;
    this.aspect = aspect;
    this.totalPhrases = COCKPIT.phrases + COCKPIT.phrasesPerStrike * (strike - 1);
    this.shield = COCKPIT.shield;
    this.fallbackOrigin = performance.now();
    this.beat = this.rawBeat(performance.now());
    this.overlay.setMode('rhythm');
  }

  result(): { title: string; stats: string } {
    return {
      title: this.accuracy >= 1 ? 'FLAWLESS STRIKE!' : 'STRIKE COMPLETE',
      stats: `ACCURACY ${Math.round(this.accuracy * 100)}% · MAX COMBO ${this.maxCombo}`,
    };
  }

  /** Handles a press at CSS pixel (`x`, `y`) at time `perfMs` (performance.now() time base). */
  tap(x: number, y: number, perfMs: number): void {
    if (!this.running || !this.active) return;
    const tapBeat = this.rawBeat(perfMs + COCKPIT.inputOffsetMs);
    const beatMs = this.beatMs;
    const minRadius = COCKPIT.hitRadius * Math.min(this.widthPx, this.heightPx);
    let best: Note | null = null;
    let bestError = Infinity;
    for (const n of this.pendingNotes()) {
      if (!n.onScreen || n === this.swipe?.note) continue;
      const error = (tapBeat - n.beat) * beatMs;
      if (error < -COCKPIT.earlyMissMs || error > COCKPIT.goodMs) continue;
      if (n.chain) {
        // A laser row can be started anywhere along (or just off) its line of ships.
        if (this.distanceToChain(n.chain, x, y) > minRadius * 1.6) continue;
      } else {
        const r = Math.max(n.sr * 1.3, minRadius);
        if ((x - n.sx) ** 2 + (y - n.sy) ** 2 > r * r) continue;
      }
      if (Math.abs(error) < Math.abs(bestError)) {
        best = n;
        bestError = error;
      }
    }
    if (!best) return;
    const off = Math.abs(bestError);
    if (off > COCKPIT.goodMs) {
      this.missNote(best, 'EARLY');
      return;
    }
    const grade = off <= COCKPIT.perfectMs ? 'perfect' : off <= COCKPIT.greatMs ? 'great' : 'good';
    if (best.chain) {
      this.startSwipe(best, grade, tapBeat, x, y);
      return;
    }
    this.hitNote(best, grade, tapBeat);
  }

  /** Pointer moved to CSS pixel (`x`, `y`) while pressed: the laser follows the finger. */
  drag(x: number, y: number): void {
    const s = this.swipe;
    if (!s || !this.running) return;
    this.cutAlong(s, s.x, s.y, x, y);
    s.x = x;
    s.y = y;
  }

  /** Pointer lifted: a laser swipe that didn't cut every ship fails. */
  release(): void {
    if (this.swipe) this.endSwipe(false);
  }

  /** Cancels return fire in flight (used when the player takes a hit). */
  popOrbs(): void {
    for (const v of this.volleys) {
      for (const b of v.bolts) {
        const p = b.mesh.position;
        this.effects.explode(p.x, p.y, BOLT_COLORS, 6, 4, 0.35, p.z);
        this.scene.remove(b.mesh);
      }
    }
    this.volleys.length = 0;
  }

  update(dt: number, frame: CockpitFrame): SectionStatus {
    if (!this.running) return 'running';
    this.active = frame.active;
    this.eye.copy(frame.eye);
    this.widthPx = frame.widthPx;
    this.heightPx = frame.heightPx;
    this.advanceClock();

    if (frame.active) this.planPhrases();
    this.updateCalls();
    this.updateFighters(dt);
    this.updateNotes();
    this.resolvePhrases();
    this.updateVolleys();
    // Return fire may end the game, which clears this section.
    if (!this.running) return 'running';
    this.updateRockets();
    this.updateSwipe();
    this.updateBeams(dt);
    this.updateOverlay(frame);

    const done =
      this.phraseCount >= this.totalPhrases &&
      this.phrases.length === 0 &&
      this.fighters.length === 0 &&
      this.rockets.length === 0 &&
      this.volleys.length === 0 &&
      this.swipe === null;
    if (done) {
      this.running = false;
      return 'cleared';
    }
    return 'running';
  }

  clear(): void {
    for (const f of this.fighters) this.removeFighterModel(f);
    for (const r of this.rockets) this.scene.remove(r.mesh);
    for (const b of this.beams) this.scene.remove(b.mesh);
    this.beams.length = 0;
    this.swipe = null;
    this.popOrbs();
    this.fighters.length = 0;
    this.phrases.length = 0;
    this.rockets.length = 0;
    this.running = false;
    this.active = false;
    this.nextPhrase = Number.NaN;
    this.phraseCount = 0;
    this.notesTotal = 0;
    this.notesHit = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.overlay.reset();
  }

  dispose(): void {
    this.clear();
    this.boltMaterial.dispose();
    this.rocketMaterial.dispose();
    this.goldMaterial.dispose();
    this.streakMaterial.dispose();
    this.beamMaterial.dispose();
  }

  // --- Beat clock ----------------------------------------------------------------------

  /** Song beat heard at `perfMs`; a steady internal clock when there is no music. */
  private rawBeat(perfMs: number): number {
    return this.music.beatAt(perfMs) ?? ((perfMs - this.fallbackOrigin) / 1000) * (FALLBACK_BPM / 60);
  }

  /**
   * Call when the simulation resumes after being frozen (pause menu, tutorial). The music
   * keeps playing meanwhile, so the chart is pushed back by whole phrases on the next
   * update: nothing is missed and it stays on the music's grid.
   */
  resync(): void {
    this.resyncPending = true;
  }

  private advanceClock(): void {
    const now = this.rawBeat(performance.now());
    const gap = now - this.beat;
    if (this.resyncPending && gap > 0.5 && !Number.isNaN(this.nextPhrase)) this.shiftChart(Math.ceil(gap / 4) * 4);
    this.resyncPending = false;
    this.beat = now;
  }

  private shiftChart(beats: number): void {
    this.nextPhrase += beats;
    for (const p of this.phrases) {
      p.start += beats;
      for (const n of p.notes) {
        n.callBeat += beats;
        n.beat += beats;
      }
    }
    for (const f of this.fighters) {
      f.warpStartBeat += beats;
      f.arriveBeat += beats;
    }
    for (const v of this.volleys) {
      v.fireBeat += beats;
      v.hitBeat += beats;
    }
    for (const r of this.rockets) {
      r.launchBeat += beats;
      r.impactBeat += beats;
    }
  }

  // --- Phrases -------------------------------------------------------------------------

  /** Plans each phrase a little ahead, so fighters can start their warp exit in time. */
  private planPhrases(): void {
    if (Number.isNaN(this.nextPhrase)) this.nextPhrase = Math.ceil((this.beat + 1.5) / 4) * 4;
    // After a miss, nothing new warps in until the return fire has landed and been dealt with.
    if (this.volleys.length > 0 || this.phrases.some((p) => p.notes.some((n) => n.missed))) return;
    while (this.phraseCount < this.totalPhrases && this.beat >= this.nextPhrase - 2) {
      this.nextPhrase += phraseBeats(this.planPhrase(this.nextPhrase).reply);
    }
  }

  private planPhrase(start: number): Phrase {
    const index = this.phraseCount++;
    const level = Math.min(PATTERNS.length - 1, this.strike - 1 + (index >= this.totalPhrases / 2 ? 1 : 0));
    const options = PATTERNS[level]!;
    const pattern = options[MathUtils.randInt(0, options.length - 1)]!;
    const slots = [...pattern].flatMap((c, i) => (c === 'x' ? [i] : []));
    const phrase: Phrase = { start, reply: replyDelayBeats(), notes: [], resolved: false, cueSounded: false, cueShown: false };

    // A heavy already on the field joins this call; from the 2nd strike new ones show up.
    let heavy = this.fighters.find((f) => f.alive && f.heavy && f.leaving === null) ?? null;
    const phrasesLeft = this.totalPhrases - index;
    const heavyDue = this.strike >= 2 && index % 3 === 1 && phrasesLeft >= HEAVY_HP;
    const heavySlot = heavy || heavyDue ? MathUtils.randInt(0, slots.length - 1) : -1;
    // Laser rows: from the third phrase of the first strike, more often later on.
    const laserChance = index < 2 ? 0 : this.strike === 1 ? 0.4 : 0.6;
    const laserSlot =
      heavySlot < 0 && slots.length >= 2 && Math.random() < laserChance ? MathUtils.randInt(0, slots.length - 1) : -1;
    const smallCount = slots.length - (heavySlot >= 0 ? 1 : 0) - (laserSlot >= 0 ? 1 : 0);
    const spots = this.layoutSpots(smallCount, heavySlot >= 0, laserSlot >= 0);
    // Early on the sequence reads left to right; later it jumps around.
    if (level >= 2) shuffle(spots);

    let spot = 0;
    let small = 0;
    slots.forEach((slot, order) => {
      const callBeat = start + slot * 0.5;
      let fighter: Fighter;
      let chain: Fighter[] | null = null;
      if (order === heavySlot) {
        const kind = this.strike >= 3 && Math.random() < 0.5 ? 'sprayer' : 'tank';
        heavy ??= this.spawnFighter(kind, this.heavySpot(), callBeat);
        fighter = heavy;
      } else if (order === laserSlot) {
        const size = this.strike >= 3 ? 4 : 3;
        chain = this.laserRowSpots(size).map((p) => this.spawnFighter('diver', p, callBeat));
        fighter = chain[0]!;
      } else {
        const kind = SMALL_KINDS[small++ % SMALL_KINDS.length]!;
        fighter = this.spawnFighter(kind, spots[spot++]!, callBeat);
      }
      phrase.notes.push({
        fighter,
        chain,
        callBeat,
        beat: callBeat + phrase.reply,
        order,
        phrase,
        callSounded: false,
        called: false,
        judged: false,
        missed: false,
        sx: 0,
        sy: 0,
        sr: 0,
        onScreen: false,
      });
    });
    this.notesTotal += phrase.notes.length;
    this.phrases.push(phrase);
    return phrase;
  }

  /** A slanted row of ships across the upper part of the view, listed in swipe order. */
  private laserRowSpots(count: number): Vector3[] {
    const halfW = FIGHTER_DEPTH * Math.tan(MathUtils.degToRad(COCKPIT.fov / 2)) * this.aspect;
    const rangeX = Math.max(2.4, Math.min(halfW * 0.78 - 1.2, 8));
    const tilt = MathUtils.randFloatSpread(1.6);
    const fromLeft = Math.random() < 0.5;
    const spots: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const u = fromLeft ? t : 1 - t;
      spots.push(new Vector3(
        this.anchor.x + MathUtils.lerp(-rangeX, rangeX, u),
        this.anchor.y + FIGHTER_DEPTH,
        LASER_ROW_Z + tilt * (u - 0.5) * 2,
      ));
    }
    return spots;
  }

  /** Hover spots in one or two rows that keep targets apart on screen. */
  private layoutSpots(count: number, withHeavy: boolean, withLaserRow: boolean): Vector3[] {
    const tanHalfFov = Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    const halfH = FIGHTER_DEPTH * tanHalfFov;
    const halfW = halfH * this.aspect;
    const rangeX = Math.max(1.2, Math.min(halfW * 0.78 - 1.4, 8));
    const minGap = 3;
    const rows = count > 1 && (2 * rangeX) / (count - 1) < minGap ? 2 : 1;
    // A laser row takes the top of the view, so tap targets move down.
    const rowZ = withLaserRow
      ? rows === 1 ? [-0.8] : [0.4, -2.6]
      : rows === 1 ? [withHeavy ? -0.6 : 0.8] : withHeavy ? [0.4, -3] : [2.6, -1.2];
    const spots: Vector3[] = [];
    for (let r = 0; r < rows; r++) {
      const inRow = rows === 1 ? count : r === 0 ? Math.ceil(count / 2) : Math.floor(count / 2);
      for (let i = 0; i < inRow; i++) {
        const t = inRow === 1 ? 0.5 : i / (inRow - 1);
        // Stagger the second row so no target sits right below another.
        const x = inRow === 1 ? (rows === 2 ? (r === 0 ? -0.35 : 0.35) * rangeX : 0) : MathUtils.lerp(-rangeX, rangeX, t) * (r === 1 ? 0.75 : 1);
        spots.push(new Vector3(
          this.anchor.x + x + MathUtils.randFloatSpread(0.4),
          this.anchor.y + FIGHTER_DEPTH + MathUtils.randFloatSpread(2),
          rowZ[r]! + MathUtils.randFloatSpread(0.5),
        ));
      }
    }
    return spots;
  }

  private heavySpot(): Vector3 {
    const halfH = HEAVY_DEPTH * Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    return new Vector3(this.anchor.x, this.anchor.y + HEAVY_DEPTH, Math.min(halfH * 0.42, 6.5));
  }

  /** Schedules call sounds on the music clock and shows each call as it happens. */
  private updateCalls(): void {
    for (const p of this.phrases) {
      const turn = p.start + p.reply;
      if (!p.cueSounded && this.beat >= turn - CUE_RISE_BEATS - 0.5) {
        p.cueSounded = true;
        const riseStart = this.music.timeOfBeat(turn - CUE_RISE_BEATS) ?? undefined;
        this.sfx.responseCue(riseStart, this.music.timeOfBeat(turn) ?? undefined);
      }
      if (!p.cueShown && this.beat >= turn) {
        p.cueShown = true;
        this.overlay.cueResponse();
      }
      for (const n of p.notes) {
        if (!n.judged && !members(n).some((f) => f.alive)) {
          // A heavy destroyed before its next call: that note is dropped.
          n.judged = n.called = n.callSounded = true;
          this.notesTotal--;
          continue;
        }
        if (!n.callSounded && this.beat >= n.callBeat - 0.5) {
          n.callSounded = true;
          const time = this.music.timeOfBeat(n.callBeat) ?? undefined;
          if (n.chain) this.sfx.laserCall(this.toneFor(n.order, n.callBeat), time);
          else this.sfx.call(this.toneFor(n.order, n.callBeat), time);
          if (!n.fighter.warpedIn && n.fighter.arriveBeat === n.callBeat) this.sfx.warpIn(time);
        }
        if (!n.called && this.beat >= n.callBeat) {
          n.called = true;
          const f = n.fighter;
          if (f.warpedIn) {
            // Already on the field (a heavy): it pulses instead of warping in.
            f.flash = 0.12;
            this.effects.ring(f.position.x, f.position.y, f.position.z, 0x9fe8ff, 5, 0.35, true);
          }
          const s = this.projectFighter(f);
          if (s) this.overlay.judgement(String(n.order + 1), 'call', s.x, s.y - s.r - 12);
          if (n.chain && this.laserIntros < 2) {
            this.laserIntros++;
            this.overlay.showCallout('LASER ROW · SWIPE IT!', 1.2);
          }
        }
      }
    }
  }

  private *pendingNotes(): Generator<Note> {
    for (const p of this.phrases) for (const n of p.notes) if (!n.judged && members(n).some((f) => f.alive)) yield n;
  }

  /** Misses notes whose window has passed. */
  private updateNotes(): void {
    const lateBeats = COCKPIT.goodMs / this.beatMs;
    for (const n of this.pendingNotes()) {
      if (n !== this.swipe?.note && this.beat > n.beat + lateBeats) this.missNote(n, 'MISS');
    }
  }

  /** At the end of a phrase, enemies that weren't hit fire back and warp away. */
  private resolvePhrases(): void {
    for (let i = this.phrases.length - 1; i >= 0; i--) {
      const p = this.phrases[i]!;
      const end = p.start + p.reply + 4;
      if (this.beat < end) continue;
      if (!p.resolved) {
        p.resolved = true;
        const standing = (f: Fighter): boolean => f.alive && f.hp - f.inFlight > 0;
        const shooters = unique(p.notes.filter((n) => n.missed).flatMap(members)).filter(standing);
        if (shooters.length > 0) this.fireVolley(shooters, end);
        for (const f of unique(p.notes.flatMap(members)).filter(standing)) {
          // Heavies stay for the next call (unless the strike is over or they just shot at you).
          const staysForNext = f.heavy && this.phraseCount < this.totalPhrases && !shooters.includes(f);
          if (!staysForNext) this.leave(f);
        }
      }
      this.phrases.splice(i, 1);
    }
  }

  private hitNote(note: Note, grade: 'perfect' | 'great' | 'good', tapBeat: number): void {
    this.scoreNote(note, grade);
    this.launchRocket(note.fighter, tapBeat);
  }

  private scoreNote(note: Note, grade: 'perfect' | 'great' | 'good'): void {
    note.judged = true;
    this.notesHit++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    if (this.combo === COCKPIT.overdriveCombo) {
      this.overlay.showCallout('OVERDRIVE!', 1);
      this.sfx.overdrive();
    }
    this.callbacks.addScore(Math.round(NOTE_SCORE[grade] * this.multiplier));
    this.overlay.judgement(GRADE_LABEL[grade], grade, note.sx, note.sy - note.sr - 14);
    this.sfx.noteHit(this.toneFor(note.order, note.beat), grade === 'perfect');
    navigator.vibrate?.(grade === 'perfect' ? 12 : 6);
  }

  private missNote(note: Note, label: string): void {
    note.judged = true;
    note.missed = true;
    if (this.combo >= 4) this.sfx.miss();
    this.combo = 0;
    this.overlay.judgement(label, 'miss', note.sx, note.sy - note.sr - 14);
  }

  /** Tone for the n-th enemy of a phrase: climbs the chord under `beat`, so calls and replies sing. */
  private toneFor(order: number, beat: number): number {
    const chord = this.music.chordAt(beat) ?? [62, 65, 69];
    const tones = [...chord, ...chord.map((n) => n + 12), chord[0]! + 24];
    return tones[order % tones.length]! + 12;
  }

  // --- Fighters and return fire --------------------------------------------------------

  private spawnFighter(kind: EnemyKind, hover: Vector3, arriveBeat: number): Fighter {
    const model = ENEMY_STATS[kind].create();
    model.object.scale.setScalar(FIGHTER_SCALE);
    model.object.rotation.x = FIGHTER_PITCH;
    // Placed on the line of sight when the warp exit begins (see beginWarpIn).
    const start = hover.clone();
    model.object.position.copy(start);
    model.object.visible = false;
    this.scene.add(model.object);
    const fighter: Fighter = {
      kind,
      model,
      baseEmissive: model.flashMaterials.map((m) => m.emissive.getHex()),
      position: model.object.position,
      radius: ENEMY_STATS[kind].radius * FIGHTER_SCALE,
      hp: kind === 'tank' || kind === 'sprayer' ? HEAVY_HP : 1,
      heavy: kind === 'tank' || kind === 'sprayer',
      screen: null,
      inFlight: 0,
      alive: true,
      start,
      hover,
      warpStartBeat: arriveBeat - WARP_LEAD_BEATS,
      arriveBeat,
      visible: false,
      warpedIn: false,
      leaving: null,
      phase: Math.random() * Math.PI * 2,
      flash: 0,
      streak: null,
    };
    this.fighters.push(fighter);
    return fighter;
  }

  private leave(f: Fighter): void {
    // Not out of warp yet: it simply never arrives.
    if (!f.visible) this.removeFighter(f);
    else f.leaving ??= 0;
  }

  private updateFighters(dt: number): void {
    const beatSec = this.beatMs / 1000;
    for (let i = this.fighters.length - 1; i >= 0; i--) {
      const f = this.fighters[i]!;
      if (this.beat < f.warpStartBeat && f.leaving === null) continue;
      if (!f.visible) this.beginWarpIn(f);
      const age = (this.beat - f.warpStartBeat) * beatSec;

      if (f.leaving !== null) {
        // Warp back out: accelerate away along the line of sight, staying put on screen.
        f.leaving += dt;
        tmp.subVectors(f.position, this.eye);
        f.position.addScaledVector(tmp, ((6 + 260 * f.leaving * f.leaving) * dt) / Math.max(1, tmp.y));
        f.model.object.scale.set(FIGHTER_SCALE, FIGHTER_SCALE * (1 + f.leaving * 8), FIGHTER_SCALE);
        if (f.leaving > 0.9 || !f.alive) {
          this.removeFighter(f);
          continue;
        }
      } else {
        const arrive = MathUtils.clamp((this.beat - f.warpStartBeat) / WARP_BEATS, 0, 1);
        // Very steep ease-out: huge speed at first, then an abrupt stop — a "drop out of warp".
        const eased = 1 - (1 - arrive) ** 5;
        const settle = MathUtils.smoothstep(arrive, 0.9, 1);
        const t = age * 0.6 + f.phase;
        // Only a gentle drift, so targets stay put and easy to tap.
        tmp.set(Math.sin(t) * 0.5, Math.sin(t * 0.7) * 0.4, Math.cos(t) * 0.35);
        f.position.lerpVectors(f.start, f.hover, eased).addScaledVector(tmp, settle);
        this.updateWarpIn(f, arrive);
      }

      const obj = f.model.object;
      obj.rotation.y = Math.sin(age * 1.4 + f.phase) * 0.25;
      if (f.flash > 0) {
        f.flash -= dt;
        const on = f.flash > 0;
        f.model.flashMaterials.forEach((m, j) => m.emissive.setHex(on ? 0xffffff : f.baseEmissive[j]!));
      }
    }
  }

  private beginWarpIn(f: Fighter): void {
    f.visible = true;
    f.model.object.visible = true;
    // Straight out of depth along the line of sight through its hover spot, so it already
    // sits where it will end up on screen.
    tmp.subVectors(f.hover, this.eye);
    f.start.copy(f.hover).addScaledVector(tmp, WARP_IN_DISTANCE / Math.max(1, tmp.y));
    f.position.copy(f.start);
    this.effects.flash(f.hover.x, f.hover.y, f.hover.z, 0x9fe8ff, f.heavy ? 4 : 2.6, 0.35);
    f.streak = new Mesh(sharedGeometries.warpStreak, this.streakMaterial);
    f.streak.quaternion.setFromUnitVectors(tmp2.set(0, 1, 0), tmp.normalize());
    this.scene.add(f.streak);
  }

  /** Stretches the fighter and its streak along the flight path while it decelerates. */
  private updateWarpIn(f: Fighter, arrive: number): void {
    const speed = (1 - arrive) ** 4;
    // Stretch along the ship's nose axis, which points (mostly) down the line of sight.
    f.model.object.scale.set(FIGHTER_SCALE, FIGHTER_SCALE * (1 + speed * 10), FIGHTER_SCALE);

    if (!f.warpedIn && this.beat >= f.arriveBeat) {
      f.warpedIn = true;
      const p = f.position;
      const big = f.heavy ? 1.6 : 1;
      this.effects.explode(p.x, p.y, WARP_FLASH_COLORS, 30, 9, 0.5, p.z);
      this.effects.flash(p.x, p.y, p.z, 0xffffff, 7 * big, 0.45);
      this.effects.ring(p.x, p.y, p.z, 0xffffff, 3 * big, 0.3, true);
      this.effects.ring(p.x, p.y, p.z, 0x9fe8ff, 6.5 * big, 0.6, true);
    }

    if (!f.streak) return;
    const length = speed * 45 + (1 - arrive) * 4;
    if (arrive >= 1 || length < 0.05) {
      this.scene.remove(f.streak);
      f.streak = null;
      return;
    }
    tmp.subVectors(f.position, this.eye).normalize();
    f.streak.position.copy(f.position).addScaledVector(tmp, length / 2);
    const width = FIGHTER_SCALE * (0.6 + speed);
    f.streak.scale.set(width, length, width);
  }

  private fireVolley(shooters: Fighter[], fireBeat: number): void {
    this.sfx.orbFire();
    const bolts = shooters.map((f) => {
      const mesh = new Mesh(glowGeometry, this.boltMaterial);
      mesh.position.copy(f.position);
      this.scene.add(mesh);
      return { mesh, from: f.position.clone() };
    });
    this.volleys.push({ bolts, fireBeat, hitBeat: fireBeat + VOLLEY_BEATS });
  }

  /** Moves return fire; a volley reaching the cockpit costs a shield pip (or a life). */
  private updateVolleys(): void {
    for (let i = this.volleys.length - 1; i >= 0; i--) {
      const v = this.volleys[i]!;
      const t = MathUtils.clamp((this.beat - v.fireBeat) / (v.hitBeat - v.fireBeat), 0, 1);
      for (const b of v.bolts) {
        b.mesh.position.lerpVectors(b.from, tmp.copy(this.eye).add(tmp2.set(0, 1.2, -0.2)), t * t);
        b.mesh.scale.setScalar(1 + t * 0.6);
      }
      if (t < 1) continue;
      for (const b of v.bolts) this.scene.remove(b.mesh);
      this.volleys.splice(i, 1);
      if (this.shield > 0) {
        this.shield--;
        this.sfx.shieldHit();
        this.overlay.hitFlash();
        this.overlay.showCallout(this.shield > 0 ? 'SHIELD HIT' : 'SHIELD DOWN!', 1.2);
        this.callbacks.blast(tmp.copy(this.eye).add(tmp2.set(0, 4, 0)), 0.3);
      } else {
        this.callbacks.playerHit();
        if (!this.running) return;
      }
      this.interruptSequence();
      // A hit may also have cleared the remaining volleys.
      return;
    }
  }

  /**
   * After taking a hit, the sequence stops: the ships on the field fly away, and a fresh
   * phrase starts once the current bar is over. Phrases that were cut before any reply
   * are replayed, and their notes don't count against accuracy.
   */
  private interruptSequence(): void {
    for (const p of this.phrases) {
      if (p.resolved) continue;
      const pending = p.notes.filter((n) => !n.judged);
      this.notesTotal -= pending.length;
      if (pending.length === p.notes.length) this.phraseCount--;
      for (const n of pending) n.judged = n.called = n.callSounded = true;
    }
    this.phrases.length = 0;
    for (const f of [...this.fighters]) {
      if (f.alive && f.hp - f.inFlight > 0) this.leave(f);
    }
    this.swipe = null;
    this.nextPhrase = Math.ceil((this.beat + HIT_PAUSE_BEATS) / 4) * 4;
  }

  // --- Laser rows ----------------------------------------------------------------------

  private startSwipe(note: Note, grade: 'perfect' | 'great' | 'good', tapBeat: number, x: number, y: number): void {
    const s: Swipe = { note, grade, startBeat: Math.max(tapBeat, this.beat), x, y };
    this.swipe = s;
    this.sfx.laserCharge();
    this.cutAlong(s, x, y, x, y);
  }

  /** Cuts every ship of the row near the swiped segment (x1, y1)–(x2, y2). */
  private cutAlong(s: Swipe, x1: number, y1: number, x2: number, y2: number): void {
    const minRadius = COCKPIT.hitRadius * Math.min(this.widthPx, this.heightPx);
    for (const f of s.note.chain!) {
      if (!f.alive || !f.screen) continue;
      const r = Math.max(f.screen.r * 1.4, minRadius * 0.9);
      if (distanceToSegment(f.screen.x, f.screen.y, x1, y1, x2, y2) > r) continue;
      this.fireBeam(f);
      f.inFlight++;
      this.sfx.explosion('small');
      this.damage(f, this.overdrive);
    }
    if (s.note.chain!.every((f) => !f.alive)) this.endSwipe(true);
  }

  private endSwipe(cleared: boolean): void {
    const s = this.swipe;
    if (!s) return;
    this.swipe = null;
    if (cleared) {
      this.scoreNote(s.note, s.grade);
      const last = s.note.chain![s.note.chain!.length - 1]!;
      if (last.screen) this.overlay.judgement('LASER!', s.grade, last.screen.x, last.screen.y - 40);
      return;
    }
    this.missNote(s.note, 'MISS');
  }

  private updateSwipe(): void {
    if (this.swipe && this.beat > this.swipe.startBeat + SWIPE_BEATS) this.endSwipe(false);
  }

  private fireBeam(target: Fighter): void {
    const from = tmp.set(this.eye.x, this.eye.y + 0.8, this.eye.z - 0.7);
    const mesh = new Mesh(beamGeometry, this.beamMaterial);
    mesh.position.copy(from);
    const dir = tmp2.subVectors(target.position, from);
    mesh.scale.set(1, dir.length(), 1);
    mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
    this.scene.add(mesh);
    this.beams.push({ mesh, age: 0 });
    const p = target.position;
    this.effects.flash(p.x, p.y, p.z, 0x57ff9a, 5, 0.3);
  }

  private updateBeams(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]!;
      b.age += dt;
      const w = Math.max(0, 1 - b.age / BEAM_LIFE);
      b.mesh.scale.x = b.mesh.scale.z = w * 1.6;
      if (b.age < BEAM_LIFE) continue;
      this.scene.remove(b.mesh);
      this.beams.splice(i, 1);
    }
  }

  /** Pixel distance from (`x`, `y`) to the on-screen line through a row's ships. */
  private distanceToChain(chain: Fighter[], x: number, y: number): number {
    const pts = chain.filter((f) => f.alive && f.screen).map((f) => f.screen!);
    if (pts.length === 0) return Infinity;
    if (pts.length === 1) return Math.hypot(x - pts[0]!.x, y - pts[0]!.y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      best = Math.min(best, distanceToSegment(x, y, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y));
    }
    return best;
  }

  // --- Rockets -------------------------------------------------------------------------

  /** Fires at `target`; the rocket lands on the first 8th note after a short flight. */
  private launchRocket(target: Fighter, tapBeat: number): void {
    const launchBeat = Math.max(tapBeat, this.beat);
    const impactBeat = Math.ceil((launchBeat + MIN_FLIGHT_BEATS) * 2) / 2;
    const gold = this.overdrive;
    this.launchSide = -this.launchSide;
    const from = new Vector3(this.eye.x + this.launchSide * 1.3, this.eye.y + 0.6, this.eye.z - 0.6);
    const ctrl = from.clone().add(tmp.set(this.launchSide * 3.5, 6, MathUtils.randFloat(2, 4)));
    const mesh = new Mesh(sharedGeometries.rocket, gold ? this.goldMaterial : this.rocketMaterial);
    if (gold) mesh.scale.setScalar(1.4);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.sfx.rocket();

    // Rockets always connect, so the impact sound can be put on the beat right away.
    const lethal = target.hp - target.inFlight <= 1;
    target.inFlight++;
    const time = this.music.timeOfBeat(impactBeat);
    if (time !== null) this.impactSound(target, lethal, time);
    this.rockets.push({ mesh, target, from, ctrl, launchBeat, impactBeat, gold, soundOnImpact: time === null, lethal });
  }

  private impactSound(target: Fighter, lethal: boolean, time?: number): void {
    if (lethal) this.sfx.explosion(target.heavy ? 'big' : 'small', time);
    else this.sfx.hit(time);
  }

  private updateRockets(): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]!;
      const pos = r.mesh.position;
      const t = MathUtils.clamp((this.beat - r.launchBeat) / (r.impactBeat - r.launchBeat), 0, 1);
      const e = t * t * (1.6 - 0.6 * t);
      tmp2.copy(pos);
      // Quadratic Bézier from the launch rail, curving out and in onto the (moving) target.
      pos.copy(r.from).multiplyScalar((1 - e) ** 2)
        .addScaledVector(r.ctrl, 2 * (1 - e) * e)
        .addScaledVector(r.target.position, e * e);
      if (pos.distanceToSquared(tmp2) > 1e-6) r.mesh.quaternion.setFromUnitVectors(UP, tmp2.subVectors(pos, tmp2).normalize());
      this.effects.trail(pos.x, pos.y, pos.z, t < 0.15 ? 0xffffff : r.gold ? 0xffd23d : 0xffa040);

      if (t < 1) continue;
      this.scene.remove(r.mesh);
      this.rockets.splice(i, 1);
      if (r.soundOnImpact) this.impactSound(r.target, r.lethal);
      this.damage(r.target, r.gold);
    }
  }

  private damage(f: Fighter, gold: boolean): void {
    f.inFlight = Math.max(0, f.inFlight - 1);
    if (!f.alive) return;
    f.hp--;
    const p = f.position;
    if (gold) this.effects.explode(p.x, p.y, GOLD_COLORS, 14, 8, 0.4, p.z);

    if (f.hp > 0) {
      f.flash = 0.1;
      this.effects.explode(p.x, p.y, [0xffffff, 0xffa040], 14, 6, 0.35, p.z);
      this.effects.ring(p.x, p.y, p.z, 0xffa040, 4, 0.3, true);
      return;
    }

    f.alive = false;
    this.callbacks.addScore(Math.round(COCKPIT_SCORE[f.kind] * this.multiplier));
    const big = f.heavy;
    this.effects.explode(p.x, p.y, EXPLOSION_COLORS[f.kind], big ? 70 : 28, big ? 12 : 8, big ? 1 : 0.7, p.z);
    this.effects.ring(p.x, p.y, p.z, gold ? 0xffd23d : big ? 0xffb443 : 0xff5a36, big ? 9 : 4.5, big ? 0.6 : 0.4, true);
    if (big || gold) this.callbacks.blast(p, big ? 1 : 0.35);
    navigator.vibrate?.(big ? 40 : 15);
    this.removeFighter(f);
  }

  // --- Presentation ----------------------------------------------------------------------

  private projectFighter(f: Fighter): { x: number; y: number; r: number } | null {
    return this.lastFrame ? this.project(f.position, f.radius, this.lastFrame) : null;
  }

  private project(position: Vector3, radius: number, frame: CockpitFrame): { x: number; y: number; r: number } | null {
    const cam = frame.camera;
    tmp.copy(position).project(cam);
    if (tmp.z < -1 || tmp.z > 1 || Math.abs(tmp.x) > 1.1 || Math.abs(tmp.y) > 1.1) return null;
    const distance = cam.position.distanceTo(position);
    const pxPerUnit = frame.heightPx / 2 / (distance * Math.tan(MathUtils.degToRad(cam.fov / 2)));
    return {
      x: ((tmp.x + 1) / 2) * frame.widthPx,
      y: ((1 - tmp.y) / 2) * frame.heightPx,
      r: radius * pxPerUnit,
    };
  }

  private updateOverlay(frame: CockpitFrame): void {
    this.lastFrame = frame;
    this.markers.length = 0;
    this.lane.length = 0;
    this.beamGuides.length = 0;
    for (const f of this.fighters) f.screen = f.warpedIn && f.alive ? this.project(f.position, f.radius, frame) : null;
    let next: Note | null = null;
    for (const n of this.pendingNotes()) if (!next || n.beat < next.beat) next = n;
    const maxSize = 0.09 * Math.min(frame.widthPx, frame.heightPx) + 12;

    for (const p of this.phrases) {
      for (const n of p.notes) {
        const style = n.chain ? 'laser' : n.fighter.heavy ? 'heavy' : 'strike';
        if (!n.called) this.lane.push({ beats: n.callBeat - this.beat, style: 'call' });
        if (n.judged) continue;
        this.lane.push({ beats: n.beat - this.beat, style });
        const lead = members(n).find((f) => f.screen) ?? null;
        const screen = lead?.screen ?? null;
        n.onScreen = screen !== null;
        if (!screen) continue;
        n.sx = screen.x;
        n.sy = screen.y;
        n.sr = screen.r;
        // Targets get their numbered circle once their call is done and the reply is near.
        const until = n.beat - this.beat;
        if (!n.called || this.beat < p.start + p.reply - COCKPIT.approachBeats) continue;
        const isNext = n === next;
        const approach = isNext && until <= COCKPIT.approachBeats && n !== this.swipe?.note ? until / COCKPIT.approachBeats : null;
        if (n.chain) {
          this.pushLaserRow(n.chain, isNext, approach, String(n.order + 1), maxSize);
          continue;
        }
        this.markers.push({
          x: screen.x,
          y: screen.y,
          size: MathUtils.clamp(screen.r * 1.1, 24, maxSize),
          approach,
          style,
          label: String(n.order + 1),
          next: isNext,
        });
      }
    }
    this.overlay.setBeams(this.beamGuides);
    this.overlay.setNotes(this.markers);
    this.overlay.setBeat(this.beat, this.lane);
    this.overlay.setCombo(this.combo, this.multiplier, this.overdrive);
    this.overlay.setShield(this.shield, COCKPIT.shield);
    this.overlay.setTimer(1 - this.phraseCount / Math.max(1, this.totalPhrases));

    const current = this.phrases.find((p) => this.beat >= p.start && this.beat < p.start + p.reply + 4);
    const inPhrase = current ? this.beat - current.start : 0;
    const replying = current !== undefined && inPhrase >= current.reply;
    const mode: PhraseMode = !current ? null : replying ? 'repeat' : 'watch';
    const pip = Math.floor(replying ? inPhrase - current.reply : inPhrase);
    this.overlay.setPhase(mode, pip);
    this.overlay.setHintVisible(frame.active && this.phraseCount <= 2 && this.strike <= 1);
  }

  /** Circles on each ship of a laser row, and a guide line to swipe along (first to last). */
  private pushLaserRow(chain: Fighter[], next: boolean, approach: number | null, label: string, maxSize: number): void {
    const pts = chain.filter((f) => f.alive && f.screen).map((f) => f.screen!);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return;
    pts.forEach((pt, i) => {
      this.markers.push({
        x: pt.x,
        y: pt.y,
        size: MathUtils.clamp(pt.r * 1.1, 20, maxSize * 0.8),
        approach: i === 0 ? approach : null,
        style: 'laser',
        label: i === 0 ? label : '',
        next,
      });
    });
    // Extend the guide a little past both ends so the arrow clears the last ship.
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const len = Math.hypot(dx, dy) || 1;
    const ext = 34;
    this.beamGuides.push({
      x1: first.x - (dx / len) * ext,
      y1: first.y - (dy / len) * ext,
      x2: last.x + (dx / len) * ext,
      y2: last.y + (dy / len) * ext,
      next,
    });
  }

  private removeFighter(f: Fighter): void {
    f.alive = false;
    this.removeFighterModel(f);
    const index = this.fighters.indexOf(f);
    if (index >= 0) this.fighters.splice(index, 1);
  }

  private removeFighterModel(f: Fighter): void {
    if (f.streak) this.scene.remove(f.streak);
    this.scene.remove(f.model.object);
    disposeModel(f.model);
  }
}

function members(n: Note): Fighter[] {
  return n.chain ?? [n.fighter];
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? MathUtils.clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = MathUtils.randInt(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
