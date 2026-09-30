import { AdditiveBlending, Color, MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { Music } from '../audio/Music.ts';
import type { Sfx } from '../audio/Sfx.ts';
import type { CockpitOverlay, Grade, LaneNote, NoteMarker, PhraseMode } from '../ui/CockpitOverlay.ts';
import { COCKPIT } from './constants.ts';
import type { Effects } from './Effects.ts';
import { ENEMY_STATS } from './Enemy.ts';
import type { EnemyKind } from './Enemy.ts';
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

/** One enemy in a phrase: it calls on `callBeat`, and must be tapped on `callBeat + RESPONSE_OFFSET`. */
interface Note {
  fighter: Fighter;
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

/** The call bar from `start`, the response bar, then a rest (PHRASE_BEATS in all). */
interface Phrase {
  start: number;
  notes: Note[];
  resolved: boolean;
  /** The "your turn" cue at the start of the response bar. */
  cueSounded: boolean;
  cueShown: boolean;
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
}

export interface CockpitCallbacks {
  addScore: (points: number) => void;
  playerHit: () => void;
  /** Big explosion at a world position (screen shockwave etc.), strength ~0..1.5. */
  blast: (position: Vector3, strength: number) => void;
}

const COCKPIT_SCORE: Record<EnemyKind, number> = { grunt: 200, weaver: 250, tank: 1200 };
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
/** Beats from a call to its reply: a pause of a bar and a half after the call starts. */
const RESPONSE_OFFSET = 6;
/** Beat (from the phrase start) where the swoosh ends: right on the first reply. */
const CUE_BEAT = RESPONSE_OFFSET;
/** Beats per phrase: call, pause, response, then a rest before the next call (bar aligned). */
const PHRASE_BEATS = 16;
/** After taking a hit, at least this many beats pass before the next phrase (on a bar line). */
const HIT_PAUSE_BEATS = 7;
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
const EXPLOSION_COLORS: Record<EnemyKind, readonly number[]> = {
  grunt: [0xff5a36, 0xffb443, 0xffffff, 0xff2d55],
  weaver: [0xff2d55, 0xffb443, 0xffffff],
  tank: [0xff5a36, 0xffe14d, 0xff2d55, 0xffffff, 0x9fe8ff],
};
const UP = new Vector3(0, 1, 0);
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
export class CockpitSection {
  private readonly fighters: Fighter[] = [];
  private readonly phrases: Phrase[] = [];
  private readonly volleys: Volley[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly markers: NoteMarker[] = [];
  private readonly lane: LaneNote[] = [];
  private readonly boltMaterial = createGlowMaterial({ size: 1.5, intensity: 1.8, core: 0.35, color: [1, 0.3, 0.55] });
  private readonly rocketMaterial = new MeshBasicMaterial({ color: new Color(0xfff1c9).multiplyScalar(1.4) });
  private readonly goldMaterial = new MeshBasicMaterial({ color: new Color(0xffd23d).multiplyScalar(1.8) });
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
      if (!n.onScreen) continue;
      const error = (tapBeat - n.beat) * beatMs;
      if (error < -COCKPIT.earlyMissMs || error > COCKPIT.goodMs) continue;
      const r = Math.max(n.sr * 1.3, minRadius);
      if ((x - n.sx) ** 2 + (y - n.sy) ** 2 > r * r) continue;
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
    this.hitNote(best, grade, tapBeat);
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
    this.updateOverlay(frame);

    const done =
      this.phraseCount >= this.totalPhrases &&
      this.phrases.length === 0 &&
      this.fighters.length === 0 &&
      this.rockets.length === 0 &&
      this.volleys.length === 0;
    if (done) {
      this.running = false;
      return 'cleared';
    }
    return 'running';
  }

  clear(): void {
    for (const f of this.fighters) this.removeFighterModel(f);
    for (const r of this.rockets) this.scene.remove(r.mesh);
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
      this.planPhrase(this.nextPhrase);
      this.nextPhrase += PHRASE_BEATS;
    }
  }

  private planPhrase(start: number): void {
    const index = this.phraseCount++;
    const level = Math.min(PATTERNS.length - 1, this.strike - 1 + (index >= this.totalPhrases / 2 ? 1 : 0));
    const options = PATTERNS[level]!;
    const pattern = options[MathUtils.randInt(0, options.length - 1)]!;
    const slots = [...pattern].flatMap((c, i) => (c === 'x' ? [i] : []));
    const phrase: Phrase = { start, notes: [], resolved: false, cueSounded: false, cueShown: false };

    // A heavy already on the field joins this call; from the 2nd strike new ones show up.
    let heavy = this.fighters.find((f) => f.alive && f.kind === 'tank' && f.leaving === null) ?? null;
    const phrasesLeft = this.totalPhrases - index;
    const heavyDue = this.strike >= 2 && index % 3 === 1 && phrasesLeft >= HEAVY_HP;
    const heavySlot = heavy || heavyDue ? MathUtils.randInt(0, slots.length - 1) : -1;
    const smallCount = slots.length - (heavySlot >= 0 ? 1 : 0);
    const spots = this.layoutSpots(smallCount, heavySlot >= 0);
    // Early on the sequence reads left to right; later it jumps around.
    if (level >= 2) shuffle(spots);

    let spot = 0;
    slots.forEach((slot, order) => {
      const callBeat = start + slot * 0.5;
      let fighter: Fighter;
      if (order === heavySlot) {
        heavy ??= this.spawnFighter('tank', this.heavySpot(), callBeat);
        fighter = heavy;
      } else {
        fighter = this.spawnFighter(order % 3 === 2 ? 'weaver' : 'grunt', spots[spot++]!, callBeat);
      }
      phrase.notes.push({
        fighter,
        callBeat,
        beat: callBeat + RESPONSE_OFFSET,
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
  }

  /** Hover spots in one or two rows that keep targets apart on screen. */
  private layoutSpots(count: number, withHeavy: boolean): Vector3[] {
    const tanHalfFov = Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    const halfH = FIGHTER_DEPTH * tanHalfFov;
    const halfW = halfH * this.aspect;
    const rangeX = Math.max(1.2, Math.min(halfW * 0.78 - 1.4, 8));
    const minGap = 3;
    const rows = count > 1 && (2 * rangeX) / (count - 1) < minGap ? 2 : 1;
    const rowZ = rows === 1 ? [withHeavy ? -0.6 : 0.8] : withHeavy ? [0.4, -3] : [2.6, -1.2];
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
      const turn = p.start + CUE_BEAT;
      if (!p.cueSounded && this.beat >= turn - 1.5) {
        p.cueSounded = true;
        const riseStart = this.music.timeOfBeat(turn - 1) ?? undefined;
        this.sfx.responseCue(riseStart, this.music.timeOfBeat(turn) ?? undefined);
      }
      if (!p.cueShown && this.beat >= turn) {
        p.cueShown = true;
        this.overlay.cueResponse();
      }
      for (const n of p.notes) {
        if (!n.fighter.alive && !n.judged) {
          // A heavy destroyed before its next call: that note is dropped.
          n.judged = n.called = n.callSounded = true;
          this.notesTotal--;
          continue;
        }
        if (!n.callSounded && this.beat >= n.callBeat - 0.5) {
          n.callSounded = true;
          const time = this.music.timeOfBeat(n.callBeat) ?? undefined;
          this.sfx.call(this.toneFor(n.order, n.callBeat), time);
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
        }
      }
    }
  }

  private *pendingNotes(): Generator<Note> {
    for (const p of this.phrases) for (const n of p.notes) if (!n.judged && n.fighter.alive) yield n;
  }

  /** Misses notes whose window has passed. */
  private updateNotes(): void {
    const lateBeats = COCKPIT.goodMs / this.beatMs;
    for (const n of this.pendingNotes()) {
      if (this.beat > n.beat + lateBeats) this.missNote(n, 'MISS');
    }
  }

  /** At the end of a phrase, enemies that weren't hit fire back and warp away. */
  private resolvePhrases(): void {
    for (let i = this.phrases.length - 1; i >= 0; i--) {
      const p = this.phrases[i]!;
      const end = p.start + RESPONSE_OFFSET + 4;
      if (this.beat < end) continue;
      if (!p.resolved) {
        p.resolved = true;
        const standing = (f: Fighter): boolean => f.alive && f.hp - f.inFlight > 0;
        const shooters = unique(p.notes.filter((n) => n.missed).map((n) => n.fighter)).filter(standing);
        if (shooters.length > 0) this.fireVolley(shooters, end);
        for (const f of unique(p.notes.map((n) => n.fighter)).filter(standing)) {
          // Heavies stay for the next call (unless the strike is over or they just shot at you).
          const staysForNext = f.kind === 'tank' && this.phraseCount < this.totalPhrases && !shooters.includes(f);
          if (!staysForNext) this.leave(f);
        }
      }
      this.phrases.splice(i, 1);
    }
  }

  private hitNote(note: Note, grade: 'perfect' | 'great' | 'good', tapBeat: number): void {
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
    this.launchRocket(note.fighter, tapBeat);
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
    // Straight down the line of sight, so the warp exit reads as coming from the vanishing point.
    const start = hover.clone().add(tmp.set(0, WARP_IN_DISTANCE, 0));
    model.object.position.copy(start);
    model.object.visible = false;
    this.scene.add(model.object);
    const fighter: Fighter = {
      kind,
      model,
      baseEmissive: model.flashMaterials.map((m) => m.emissive.getHex()),
      position: model.object.position,
      radius: ENEMY_STATS[kind].radius * FIGHTER_SCALE,
      hp: kind === 'tank' ? HEAVY_HP : 1,
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
        // Warp back out: accelerate away down the line of sight.
        f.leaving += dt;
        f.position.y += (6 + 260 * f.leaving * f.leaving) * dt;
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
    f.streak = new Mesh(sharedGeometries.warpStreak, this.streakMaterial);
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
      this.effects.explode(p.x, p.y, WARP_FLASH_COLORS, 18, 7, 0.4, p.z);
      this.effects.ring(p.x, p.y, p.z, 0x9fe8ff, f.kind === 'tank' ? 6 : 3.2, 0.4, true);
    }

    if (!f.streak) return;
    const length = speed * 45 + (1 - arrive) * 4;
    if (arrive >= 1 || length < 0.05) {
      this.scene.remove(f.streak);
      f.streak = null;
      return;
    }
    f.streak.position.set(f.position.x, f.position.y + length / 2, f.position.z);
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
    this.nextPhrase = Math.ceil((this.beat + HIT_PAUSE_BEATS) / 4) * 4;
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
    if (lethal) this.sfx.explosion(target.kind === 'tank' ? 'big' : 'small', time);
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
    const big = f.kind === 'tank';
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
    let next: Note | null = null;
    for (const n of this.pendingNotes()) if (!next || n.beat < next.beat) next = n;

    for (const p of this.phrases) {
      for (const n of p.notes) {
        const style = n.fighter.kind === 'tank' ? 'heavy' : 'strike';
        if (!n.called) this.lane.push({ beats: n.callBeat - this.beat, style: 'call' });
        if (n.judged) continue;
        this.lane.push({ beats: n.beat - this.beat, style });
        const screen = n.fighter.warpedIn ? this.project(n.fighter.position, n.fighter.radius, frame) : null;
        n.onScreen = screen !== null;
        if (!screen) continue;
        n.sx = screen.x;
        n.sy = screen.y;
        n.sr = screen.r;
        // Targets get their numbered circle once their call is done and the reply is near.
        const until = n.beat - this.beat;
        if (!n.called || this.beat < p.start + RESPONSE_OFFSET - COCKPIT.approachBeats) continue;
        const isNext = n === next;
        this.markers.push({
          x: screen.x,
          y: screen.y,
          size: MathUtils.clamp(screen.r * 1.1, 24, 0.09 * Math.min(frame.widthPx, frame.heightPx) + 12),
          approach: isNext && until <= COCKPIT.approachBeats ? until / COCKPIT.approachBeats : null,
          style,
          label: String(n.order + 1),
          next: isNext,
        });
      }
    }
    this.overlay.setNotes(this.markers);
    this.overlay.setBeat(this.beat, this.lane);
    this.overlay.setCombo(this.combo, this.multiplier, this.overdrive);
    this.overlay.setShield(this.shield, COCKPIT.shield);
    this.overlay.setTimer(1 - this.phraseCount / Math.max(1, this.totalPhrases));

    const current = this.phrases.find((p) => this.beat >= p.start && this.beat < p.start + RESPONSE_OFFSET + 4);
    const inPhrase = current ? this.beat - current.start : 0;
    const mode: PhraseMode = !current ? null : inPhrase < CUE_BEAT ? 'watch' : 'repeat';
    // REPEAT shows from the cue; its beat pips start with the response itself.
    const pip = inPhrase < CUE_BEAT ? Math.floor(inPhrase) : Math.floor(inPhrase - RESPONSE_OFFSET);
    this.overlay.setPhase(mode, pip);
    this.overlay.setHintVisible(frame.active && this.phraseCount <= 2 && this.strike <= 1);
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

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = MathUtils.randInt(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
