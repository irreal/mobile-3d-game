import { AdditiveBlending, Color, MathUtils, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { Music } from '../audio/Music.ts';
import type { Sfx } from '../audio/Sfx.ts';
import type { CockpitOverlay, Grade, LaneNote, NoteMarker, NoteStyle } from '../ui/CockpitOverlay.ts';
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
  /** Notes waiting to be tapped plus rockets in flight at this fighter. */
  allocated: number;
  alive: boolean;
  start: Vector3;
  hover: Vector3;
  /** Seconds before it starts flying in. */
  delay: number;
  /** Reinforcement round (0-based) this fighter warps in with. */
  round: number;
  age: number;
  phase: number;
  flash: number;
  /** Speed streak shown while dropping out of warp. */
  streak: Mesh | null;
  warpedIn: boolean;
  /** Sideways dodge after a missed note: seconds left and direction. */
  jink: number;
  jinkDir: number;
}

interface Orb {
  mesh: Mesh;
  from: Vector3;
  /** Point in front of the canopy the orb reaches on its note beat. */
  judge: Vector3;
  fireBeat: number;
  beat: number;
  /** Not shot down in time: it keeps coming and hits the cockpit. */
  missed: boolean;
}

interface Note {
  kind: 'strike' | 'orb';
  beat: number;
  /** Strike: the target. Orb: the shooter. */
  fighter: Fighter;
  /** Orb notes: beat the orb launches, and the orb once launched. */
  fireBeat: number;
  orb: Orb | null;
  /** Screen position from the last overlay update, used to hit-test taps. */
  sx: number;
  sy: number;
  sr: number;
  onScreen: boolean;
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

export type SectionStatus = 'running' | 'cleared' | 'escaped';

export interface CockpitFrame {
  camera: PerspectiveCamera;
  /** Unshaken eye position; orbs aim here. */
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
const NOTE_SCORE: Record<Exclude<Grade, 'miss'>, number> = { perfect: 100, great: 70, good: 40 };
const GRADE_LABEL: Record<Grade, string> = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
/** Notes (hits) each kind takes to destroy. */
const FIGHTER_HP: Record<EnemyKind, number> = { grunt: 1, weaver: 2, tank: 4 };
/**
 * Rhythm per bar in 8th notes ('x' = note), by difficulty level. Levels rise with each
 * strike and again for the final reinforcement round.
 */
const PATTERNS: readonly (readonly string[])[] = [
  ['x...x...', 'x...x.x.', 'x...x...', 'x.x.x...'],
  ['x.x.x...', 'x...x.x.', 'x.x...x.', 'x...x.xx'],
  ['x.x.x.x.', 'x.x.xx..', 'x..xx.x.', 'x.xx.xx.'],
  ['x.xxx.x.', 'x.x.x.xx', 'xx.xx.x.', 'x.xxx.xx'],
];
/** Fallback tempo when there is no music clock (no Web Audio). Matches LOCK_ON. */
const FALLBACK_BPM = 146;
/** Rockets fly at least this many beats, then land on the next 8th note. */
const MIN_FLIGHT_BEATS = 0.45;
/** Beats a missed orb takes from its judge point to the canopy. */
const ORB_HIT_BEATS = 0.6;
const JINK_TIME = 0.45;
const FIGHTER_SCALE = 1.4;
/** Pitch toward the cockpit so the ships show their top silhouette while facing you. */
const FIGHTER_PITCH = 0.95;
/** Seconds a fighter takes to drop out of warp into its hover spot. */
const WARP_IN_TIME = 0.8;
/** How far ahead fighters start their warp exit. */
const WARP_IN_DISTANCE = 80;
const WARP_FLASH_COLORS = [0x9fe8ff, 0xffffff, 0x6ff3ff];
const ORB_RADIUS = 0.32;
const ORB_COLORS = [0xff4f8b, 0xffffff];
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
 * First-person "strike" fight between waves, played as a rhythm game locked to the
 * cockpit music. Targets get notes on an 8th-note grid; an approach ring closes onto the
 * target and the player taps it on the beat. Each hit fires a rocket that lands (and
 * explodes) exactly on a following 8th note. Heavies take several notes. Fighters fire
 * plasma orbs that arrive on a beat and must be tapped too; a missed note makes the
 * fighter dodge and shoot back. Consecutive hits build a combo up to Overdrive.
 */
export class CockpitSection {
  private readonly fighters: Fighter[] = [];
  private readonly orbs: Orb[] = [];
  private readonly notes: Note[] = [];
  private readonly rockets: Rocket[] = [];
  private readonly markers: NoteMarker[] = [];
  private readonly lane: LaneNote[] = [];
  private readonly orbMaterial = createGlowMaterial({ size: 1.5, intensity: 1.8, core: 0.35, color: [1, 0.3, 0.55] });
  private readonly rocketMaterial = new MeshBasicMaterial({ color: new Color(0xfff1c9).multiplyScalar(1.4) });
  private readonly goldMaterial = new MeshBasicMaterial({ color: new Color(0xffd23d).multiplyScalar(1.8) });
  private readonly streakMaterial = new MeshBasicMaterial({
    color: new Color(0x9fe8ff).multiplyScalar(1.3),
    transparent: true,
    opacity: 0.85,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  private anchor = new Vector3();
  private readonly eye = new Vector3();
  private wave = 1;
  private activeTime = 0;
  private fleeing = false;
  private round = 0;
  private roundStart = 0;
  private roundSizes: number[] = [];
  private running = false;
  private active = false;
  private alarmPlayed = false;
  private widthPx = 1;
  private heightPx = 1;
  /** Song position in beats as heard now. */
  private beat = 0;
  private fallbackOrigin = 0;
  private resyncPending = false;
  /** Start beat of the next bar to chart, or NaN before the first one. */
  private nextBar = Number.NaN;
  private barCount = 0;
  private lastTarget: Fighter | null = null;
  private launchSide = 1;
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

  get timeLeft(): number {
    return Math.max(0, COCKPIT.timeLimit - this.activeTime);
  }

  get overdrive(): boolean {
    return this.combo >= COCKPIT.overdriveCombo;
  }

  private get multiplier(): number {
    return this.overdrive ? 2 : 1 + Math.floor(this.combo / COCKPIT.comboStep) * 0.5;
  }

  private get beatMs(): number {
    return 60000 / (this.music.playing?.bpm ?? FALLBACK_BPM);
  }

  /** Spawns the squadron ahead of the ship at (`shipX`, `shipY`). */
  /** `strike` is the 1-based count of cockpit strikes this game (drives squadron size and rhythm). */
  start(shipX: number, shipY: number, strike: number, aspect: number): void {
    this.clear();
    this.running = true;
    this.anchor.set(shipX, shipY, 0);
    this.wave = strike;
    this.round = 0;
    this.roundStart = 0;
    this.activeTime = 0;
    this.fleeing = false;
    this.alarmPlayed = false;
    this.fallbackOrigin = performance.now();
    this.beat = this.rawBeat(performance.now());

    const rounds: EnemyKind[][] = [];
    for (let r = 0; r < COCKPIT.rounds; r++) {
      const kinds: EnemyKind[] = [];
      const small = Math.min(3 + strike + r, 8);
      for (let i = 0; i < small; i++) kinds.push(i % 3 === 2 ? 'weaver' : 'grunt');
      // Heavies join in later rounds, and in every round from the third strike on.
      const tanks = r === COCKPIT.rounds - 1 ? Math.min(strike, 2) : strike >= 3 && r > 0 ? 1 : 0;
      for (let i = 0; i < tanks; i++) kinds.splice(MathUtils.randInt(0, kinds.length), 0, 'tank');
      rounds.push(kinds);
    }
    this.roundSizes = rounds.map((k) => k.length);

    const tanHalfFov = Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    rounds.forEach((kinds, round) => kinds.forEach((kind, i) => {
      const depth = MathUtils.randFloat(15, 30);
      // Keep hover spots inside the view at that depth; portrait screens are narrow.
      const halfH = depth * tanHalfFov;
      const rangeX = Math.min(7, halfH * aspect * 0.7 - 1.5);
      const rangeZ = Math.min(5, halfH * 0.5 - 1);
      const hover = new Vector3(
        shipX + MathUtils.randFloatSpread(2 * Math.max(rangeX, 0.5)),
        shipY + depth,
        MathUtils.randFloatSpread(2 * Math.max(rangeZ, 0.5)) + 0.8,
      );
      // Straight down the line of sight, so the warp exit reads as coming from the vanishing point.
      const start = hover.clone().add(tmp.set(0, WARP_IN_DISTANCE, 0));
      // Later rounds get their warp-in time when the round is triggered.
      this.spawnFighter(kind, start, hover, round === 0 ? 0.15 + i * 0.16 : Infinity, round);
    }));
  }

  /** Handles a press at CSS pixel (`x`, `y`) at time `perfMs` (performance.now() time base). */
  tap(x: number, y: number, perfMs: number): void {
    if (!this.running || !this.active || this.fleeing) return;
    const tapBeat = this.rawBeat(perfMs + COCKPIT.inputOffsetMs);
    const beatMs = this.beatMs;
    const minRadius = COCKPIT.hitRadius * Math.min(this.widthPx, this.heightPx);
    let best: Note | null = null;
    let bestError = Infinity;
    for (const n of this.notes) {
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
    const grade: Grade = off <= COCKPIT.perfectMs ? 'perfect' : off <= COCKPIT.greatMs ? 'great' : 'good';
    this.hitNote(best, grade, tapBeat);
  }

  /** Destroys all orbs in flight and cancels queued ones (used when the player takes a hit). */
  popOrbs(): void {
    for (const orb of this.orbs) {
      const p = orb.mesh.position;
      this.effects.explode(p.x, p.y, ORB_COLORS, 6, 4, 0.35, p.z);
      this.scene.remove(orb.mesh);
    }
    this.orbs.length = 0;
    this.removeNotes((n) => n.kind === 'orb');
  }

  update(dt: number, frame: CockpitFrame): SectionStatus {
    if (!this.running) return 'running';
    this.active = frame.active;
    this.eye.copy(frame.eye);
    this.widthPx = frame.widthPx;
    this.heightPx = frame.heightPx;
    this.advanceClock();

    if (frame.active) this.activeTime += dt;
    if (!this.fleeing && this.activeTime >= COCKPIT.timeLimit) this.flee();
    if (!this.fleeing && !this.alarmPlayed && this.timeLeft < 5) {
      this.alarmPlayed = true;
      this.sfx.alarm();
    }

    if (frame.active) {
      this.updateRounds();
      this.updateChart();
    }
    this.updateFighters(dt);
    this.updateNotes();
    if (this.updateOrbs()) {
      // May end the game, which clears this section.
      this.callbacks.playerHit();
      if (!this.running) return 'running';
    }
    this.updateRockets();
    this.updateOverlay(frame);

    if (this.fighters.length === 0 && this.rockets.length === 0) {
      this.running = false;
      return this.fleeing ? 'escaped' : 'cleared';
    }
    return 'running';
  }

  clear(): void {
    for (const f of this.fighters) this.removeFighterModel(f);
    for (const o of this.orbs) this.scene.remove(o.mesh);
    for (const r of this.rockets) this.scene.remove(r.mesh);
    this.fighters.length = 0;
    this.orbs.length = 0;
    this.notes.length = 0;
    this.rockets.length = 0;
    this.running = false;
    this.active = false;
    this.nextBar = Number.NaN;
    this.barCount = 0;
    this.lastTarget = null;
    this.combo = 0;
    this.maxCombo = 0;
    this.overlay.reset();
  }

  dispose(): void {
    this.clear();
    this.orbMaterial.dispose();
    this.rocketMaterial.dispose();
    this.goldMaterial.dispose();
    this.streakMaterial.dispose();
  }

  // --- Beat clock and chart ------------------------------------------------------------

  /** Song beat heard at `perfMs`; a steady internal clock when there is no music. */
  private rawBeat(perfMs: number): number {
    return this.music.beatAt(perfMs) ?? ((perfMs - this.fallbackOrigin) / 1000) * (FALLBACK_BPM / 60);
  }

  /**
   * Call when the simulation resumes after being frozen (pause menu, tutorial). The music
   * keeps playing meanwhile, so the chart is pushed back by whole bars on the next update:
   * nothing is missed and it stays on the music's grid.
   */
  resync(): void {
    this.resyncPending = true;
  }

  private advanceClock(): void {
    const now = this.rawBeat(performance.now());
    const gap = now - this.beat;
    if (this.resyncPending && gap > 0.5 && !Number.isNaN(this.nextBar)) this.shiftChart(Math.ceil(gap / 4) * 4);
    this.resyncPending = false;
    this.beat = now;
  }

  private shiftChart(beats: number): void {
    this.nextBar += beats;
    for (const n of this.notes) {
      n.beat += beats;
      n.fireBeat += beats;
    }
    for (const o of this.orbs) {
      o.fireBeat += beats;
      o.beat += beats;
    }
    for (const r of this.rockets) {
      r.launchBeat += beats;
      r.impactBeat += beats;
    }
  }

  /** Charts upcoming bars about a bar ahead, so notes show up on the lane in time. */
  private updateChart(): void {
    if (this.fleeing) return;
    if (Number.isNaN(this.nextBar)) this.nextBar = Math.ceil((this.beat + COCKPIT.approachBeats + 0.5) / 4) * 4;
    while (this.beat >= this.nextBar - 4) {
      this.chartBar(this.nextBar);
      this.nextBar += 4;
    }
  }

  private chartBar(start: number): void {
    const level = Math.min(PATTERNS.length - 1, this.wave - 1 + (this.round >= COCKPIT.rounds - 1 ? 1 : 0));
    const options = PATTERNS[level]!;
    const pattern = options[this.barCount++ % options.length]!;

    // Most bars also carry one incoming orb on a rest, more often later on.
    const orbChance = Math.min(0.25 + 0.15 * (this.wave - 1) + 0.1 * this.round, 0.75);
    const rests = [...pattern].flatMap((c, i) => (c === '.' ? [i] : []));
    const orbSlot = this.barCount > 1 && rests.length > 0 && Math.random() < orbChance
      ? rests[MathUtils.randInt(0, rests.length - 1)]!
      : -1;

    let prev = this.lastTarget;
    for (let i = 0; i < pattern.length; i++) {
      const beat = start + i * 0.5;
      if (this.slotTaken(beat)) continue;
      if (i === orbSlot) {
        const shooter = this.notes.some((n) => n.kind === 'orb') ? null : this.randomShooter();
        if (shooter) this.addOrbNote(shooter, beat);
        continue;
      }
      if (pattern[i] !== 'x') continue;
      const target = this.pickTarget(prev);
      if (!target) continue;
      target.allocated++;
      this.notes.push(this.makeNote('strike', beat, target));
      prev = target;
    }
    this.lastTarget = prev;
  }

  /** Keeps hitting the same target until it has enough notes, then moves to the nearest. */
  private pickTarget(prev: Fighter | null): Fighter | null {
    let best: Fighter | null = null;
    let bestDist = Infinity;
    for (const f of this.fighters) {
      if (!f.alive || !f.warpedIn || f.hp - f.allocated <= 0) continue;
      if (f === prev) return f;
      const d = prev ? f.hover.distanceToSquared(prev.hover) : Math.random();
      if (d < bestDist) {
        best = f;
        bestDist = d;
      }
    }
    return best;
  }

  private randomShooter(): Fighter | null {
    const ready = this.fighters.filter((f) => f.alive && f.warpedIn && f.age > WARP_IN_TIME);
    return ready.length > 0 ? ready[MathUtils.randInt(0, ready.length - 1)]! : null;
  }

  private slotTaken(beat: number): boolean {
    return this.notes.some((n) => Math.abs(n.beat - beat) < 0.26);
  }

  private makeNote(kind: Note['kind'], beat: number, fighter: Fighter): Note {
    return { kind, beat, fighter, fireBeat: beat, orb: null, sx: 0, sy: 0, sr: 0, onScreen: false };
  }

  /** Schedules an orb from `shooter` that has to be shot down on `beat`. */
  private addOrbNote(shooter: Fighter, beat: number): void {
    const note = this.makeNote('orb', beat, shooter);
    note.fireBeat = Math.max(beat - COCKPIT.orbBeats, this.beat);
    this.notes.push(note);
  }

  /** First free 8th-note slot at or after `beat`. */
  private freeSlot(beat: number): number {
    let slot = Math.ceil(beat * 2) / 2;
    while (this.slotTaken(slot)) slot += 0.5;
    return slot;
  }

  // --- Notes ---------------------------------------------------------------------------

  /** Launches due orbs and misses notes whose window has passed. */
  private updateNotes(): void {
    const lateBeats = COCKPIT.goodMs / this.beatMs;
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]!;
      if (n.kind === 'orb' && !n.orb && this.beat >= n.fireBeat) {
        if (!n.fighter.alive) {
          this.notes.splice(i, 1);
          continue;
        }
        n.orb = this.launchOrb(n);
      }
      if (this.beat > n.beat + lateBeats) this.missNote(n, 'MISS');
    }
  }

  private hitNote(note: Note, grade: Exclude<Grade, 'miss'>, tapBeat: number): void {
    this.removeNote(note);
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    if (this.combo === COCKPIT.overdriveCombo) {
      this.overlay.showCallout('OVERDRIVE!', 1);
      this.sfx.overdrive();
    }
    this.callbacks.addScore(Math.round(NOTE_SCORE[grade] * this.multiplier));
    this.overlay.judgement(GRADE_LABEL[grade], grade, note.sx, note.sy - note.sr - 14);
    this.sfx.noteHit(this.comboTone(tapBeat), grade === 'perfect');
    navigator.vibrate?.(grade === 'perfect' ? 12 : 6);

    if (note.kind === 'strike') {
      this.launchRocket(note.fighter, tapBeat);
    } else if (note.orb) {
      const p = note.orb.mesh.position;
      this.effects.explode(p.x, p.y, ORB_COLORS, 12, 5, 0.4, p.z);
      this.effects.ring(p.x, p.y, p.z, 0xff4f8b, 1.6, 0.3, true);
      this.sfx.orbPop();
      this.removeOrb(note.orb);
    }
  }

  private missNote(note: Note, label: string): void {
    this.removeNote(note);
    if (this.combo >= 4) this.sfx.miss();
    this.combo = 0;
    this.overlay.judgement(label, 'miss', note.sx, note.sy - note.sr - 14);
    if (note.kind === 'orb') {
      if (note.orb) note.orb.missed = true;
      return;
    }
    const f = note.fighter;
    f.allocated--;
    if (!f.alive || this.fleeing) return;
    // The target dodges and shoots back (one incoming orb at a time, so misses don't snowball).
    f.jink = JINK_TIME;
    f.jinkDir = Math.random() < 0.5 ? -1 : 1;
    const orbPending = this.notes.some((n) => n.kind === 'orb') || this.orbs.some((o) => o.missed);
    if (!orbPending) this.addOrbNote(f, this.freeSlot(this.beat + COCKPIT.orbBeats));
  }

  private removeNote(note: Note): void {
    const index = this.notes.indexOf(note);
    if (index >= 0) this.notes.splice(index, 1);
  }

  private removeNotes(match: (n: Note) => boolean): void {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]!;
      if (!match(n)) continue;
      if (n.kind === 'strike') n.fighter.allocated--;
      this.notes.splice(i, 1);
    }
  }

  /** Chord tone for a hit; climbs the current chord's arpeggio as the combo grows. */
  private comboTone(beat: number): number {
    const chord = this.music.chordAt(beat) ?? [62, 65, 69];
    const tones = [...chord, ...chord.map((n) => n + 12)];
    return tones[(this.combo - 1) % tones.length]! + 12;
  }

  // --- Fighters and orbs -------------------------------------------------------------

  private spawnFighter(kind: EnemyKind, start: Vector3, hover: Vector3, delay: number, round: number): void {
    const model = ENEMY_STATS[kind].create();
    model.object.scale.setScalar(FIGHTER_SCALE);
    model.object.rotation.x = FIGHTER_PITCH;
    model.object.position.copy(start);
    model.object.visible = false;
    this.scene.add(model.object);
    this.fighters.push({
      kind,
      model,
      baseEmissive: model.flashMaterials.map((m) => m.emissive.getHex()),
      position: model.object.position,
      radius: ENEMY_STATS[kind].radius * FIGHTER_SCALE,
      hp: FIGHTER_HP[kind],
      allocated: 0,
      alive: true,
      start,
      hover,
      delay,
      round,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      flash: 0,
      streak: null,
      warpedIn: false,
      jink: 0,
      jinkDir: 1,
    });
  }

  /** Warps in the next reinforcement round once the current one is mostly cleared (or stale). */
  private updateRounds(): void {
    if (this.fleeing || this.round >= this.roundSizes.length - 1) return;
    const left = this.fighters.filter((f) => f.round === this.round).length;
    const stale = this.activeTime - this.roundStart > COCKPIT.roundTime;
    if (left > COCKPIT.nextRoundWhenLeft && !stale) return;

    this.round++;
    this.roundStart = this.activeTime;
    let i = 0;
    for (const f of this.fighters) {
      if (f.round === this.round) f.delay = this.activeTime + 0.5 + i++ * 0.16;
    }
    this.overlay.showCallout(this.round === this.roundSizes.length - 1 ? 'FINAL WAVE!' : 'REINFORCEMENTS!', 1.2);
    this.sfx.alarm();
  }

  private updateFighters(dt: number): void {
    for (let i = this.fighters.length - 1; i >= 0; i--) {
      const f = this.fighters[i]!;
      // Nobody shows up until the HUD has finished booting (the section is "active").
      if (this.activeTime < f.delay) continue;
      if (f.age === 0) this.beginWarpIn(f);
      f.age += dt;

      if (this.fleeing) {
        f.position.y += (20 + f.age) * dt;
        f.position.z += 8 * dt;
        if (f.position.y > this.anchor.y + 90) {
          f.alive = false;
          this.removeFighterModel(f);
          this.fighters.splice(i, 1);
          continue;
        }
      } else {
        const arrive = Math.min(1, f.age / WARP_IN_TIME);
        // Very steep ease-out: huge speed at first, then an abrupt stop — a "drop out of warp".
        const eased = 1 - (1 - arrive) ** 5;
        const settle = MathUtils.smoothstep(f.age, WARP_IN_TIME, WARP_IN_TIME + 1);
        const t = f.age * (f.kind === 'weaver' ? 1.2 : 0.7) + f.phase;
        // Gentle drift: targets must stay easy to tap on the beat.
        tmp.set(Math.sin(t) * 1.1, Math.sin(t * 0.7) * 0.8, Math.cos(t) * 0.7);
        if (f.jink > 0) {
          f.jink = Math.max(0, f.jink - dt);
          tmp.x += f.jinkDir * Math.sin((1 - f.jink / JINK_TIME) * Math.PI) * 2.4;
        }
        f.position.lerpVectors(f.start, f.hover, eased).addScaledVector(tmp, settle);
        this.updateWarpIn(f, arrive);
      }

      const obj = f.model.object;
      const jinkBank = f.jink > 0 ? -f.jinkDir * Math.sin((1 - f.jink / JINK_TIME) * Math.PI) * 0.9 : 0;
      obj.rotation.y = Math.sin(f.age * (f.kind === 'weaver' ? 2.4 : 1.6) + f.phase) * 0.35 + jinkBank;

      if (f.flash > 0) {
        f.flash -= dt;
        const on = f.flash > 0;
        f.model.flashMaterials.forEach((m, j) => m.emissive.setHex(on ? 0xffffff : f.baseEmissive[j]!));
      }
    }
  }

  private beginWarpIn(f: Fighter): void {
    f.model.object.visible = true;
    f.streak = new Mesh(sharedGeometries.warpStreak, this.streakMaterial);
    this.scene.add(f.streak);
  }

  /** Stretches the fighter and its streak along the flight path while it decelerates. */
  private updateWarpIn(f: Fighter, arrive: number): void {
    const speed = (1 - arrive) ** 4;
    // Stretch along the ship's nose axis, which points (mostly) down the line of sight.
    f.model.object.scale.set(FIGHTER_SCALE, FIGHTER_SCALE * (1 + speed * 10), FIGHTER_SCALE);

    if (!f.warpedIn && arrive > 0.55) {
      f.warpedIn = true;
      const p = f.position;
      this.effects.explode(p.x, p.y, WARP_FLASH_COLORS, 16, 7, 0.4, p.z);
      this.effects.ring(p.x, p.y, p.z, 0x9fe8ff, 2.6, 0.4, true);
      this.sfx.warpIn();
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

  private launchOrb(note: Note): Orb {
    this.sfx.orbFire();
    const mesh = new Mesh(glowGeometry, this.orbMaterial);
    mesh.position.copy(note.fighter.position);
    this.scene.add(mesh);
    // Spread judge points across the view so orbs don't all end up dead center.
    const tanHalfFov = Math.tan(MathUtils.degToRad(COCKPIT.fov / 2));
    const ahead = 6;
    const spreadX = Math.min(2.2, ahead * tanHalfFov * (this.widthPx / this.heightPx) * 0.6);
    const judge = new Vector3(
      this.eye.x + MathUtils.randFloatSpread(2 * spreadX),
      this.eye.y + ahead,
      this.eye.z + MathUtils.randFloatSpread(ahead * tanHalfFov * 0.8) + 0.3,
    );
    const orb: Orb = {
      mesh,
      from: note.fighter.position.clone(),
      judge,
      fireBeat: note.fireBeat,
      beat: note.beat,
      missed: false,
    };
    this.orbs.push(orb);
    return orb;
  }

  /** Moves orbs along their beat-timed paths; returns true if one reached the cockpit. */
  private updateOrbs(): boolean {
    let hit = false;
    const pulse = (1 - (this.beat - Math.floor(this.beat))) ** 2;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i]!;
      const pos = orb.mesh.position;
      if (orb.missed) {
        const t = (this.beat - orb.beat) / ORB_HIT_BEATS;
        pos.lerpVectors(orb.judge, this.eye, Math.min(1, Math.max(0, t)));
        if (t >= 1) {
          hit = true;
          this.removeOrb(orb);
          continue;
        }
      } else {
        const span = Math.max(0.01, orb.beat - orb.fireBeat);
        const t = MathUtils.clamp((this.beat - orb.fireBeat) / span, 0, 1);
        pos.lerpVectors(orb.from, orb.judge, t ** 1.4);
      }
      orb.mesh.scale.setScalar(1 + pulse * 0.35);
    }
    return hit;
  }

  private removeOrb(orb: Orb): void {
    this.scene.remove(orb.mesh);
    const index = this.orbs.indexOf(orb);
    if (index >= 0) this.orbs.splice(index, 1);
  }

  private flee(): void {
    this.fleeing = true;
    // Reinforcements that never arrived simply don't come.
    for (let i = this.fighters.length - 1; i >= 0; i--) {
      const f = this.fighters[i]!;
      if (f.age > 0) continue;
      f.alive = false;
      this.removeFighterModel(f);
      this.fighters.splice(i, 1);
    }
    this.removeNotes(() => true);
    for (const orb of [...this.orbs]) if (!orb.missed) this.removeOrb(orb);
    this.overlay.showCallout('THEY GOT AWAY', 1.5);
    this.sfx.escaped();
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
    const earlier = this.rockets.filter((r) => r.target === target).length;
    const lethal = target.hp - earlier <= 1;
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
    f.allocated = Math.max(0, f.allocated - 1);
    if (!f.alive) return;
    f.hp--;
    const p = f.position;
    if (gold) this.effects.explode(p.x, p.y, GOLD_COLORS, 14, 8, 0.4, p.z);

    if (f.hp > 0) {
      f.flash = 0.08;
      this.effects.explode(p.x, p.y, [0xffffff, 0xffa040], 10, 5, 0.3, p.z);
      this.effects.ring(p.x, p.y, p.z, 0xffa040, 2.2, 0.25, true);
      return;
    }

    f.alive = false;
    this.callbacks.addScore(Math.round(COCKPIT_SCORE[f.kind] * this.multiplier));
    const big = f.kind === 'tank';
    this.effects.explode(p.x, p.y, EXPLOSION_COLORS[f.kind], big ? 70 : 28, big ? 12 : 8, big ? 1 : 0.7, p.z);
    this.effects.ring(p.x, p.y, p.z, gold ? 0xffd23d : big ? 0xffb443 : 0xff5a36, big ? 9 : 4.5, big ? 0.6 : 0.4, true);
    if (big || gold) this.callbacks.blast(p, big ? 1 : 0.35);
    navigator.vibrate?.(big ? 40 : 15);
    // Orbs it hadn't fired yet are cancelled with it.
    this.removeNotes((n) => n.kind === 'orb' && n.fighter === f && !n.orb);
    this.removeFighterModel(f);
    this.fighters.splice(this.fighters.indexOf(f), 1);
  }

  // --- Presentation ----------------------------------------------------------------------

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
    this.markers.length = 0;
    this.lane.length = 0;
    for (const n of this.notes) {
      const style: NoteStyle = n.kind === 'orb' ? 'orb' : n.fighter.kind === 'tank' ? 'heavy' : 'strike';
      const until = n.beat - this.beat;
      this.lane.push({ beats: until, style });
      const target = n.kind === 'strike' ? n.fighter.position : n.orb?.mesh.position;
      const screen = target ? this.project(target, n.kind === 'orb' ? ORB_RADIUS * 2 : n.fighter.radius, frame) : null;
      n.onScreen = screen !== null;
      if (!screen) continue;
      n.sx = screen.x;
      n.sy = screen.y;
      n.sr = screen.r;
      if (until > COCKPIT.approachBeats) continue;
      this.markers.push({
        x: screen.x,
        y: screen.y,
        size: MathUtils.clamp(screen.r * 1.1, 24, 0.09 * Math.min(frame.widthPx, frame.heightPx) + 12),
        approach: until / COCKPIT.approachBeats,
        style,
      });
    }
    this.overlay.setNotes(this.markers);
    this.overlay.setBeat(this.beat, this.lane);
    this.overlay.setCombo(this.combo, this.multiplier, this.overdrive);
    this.overlay.setTimer(this.timeLeft / COCKPIT.timeLimit);
    this.overlay.setHintVisible(frame.active && this.activeTime < 5 && this.wave <= 2);
  }

  private removeFighterModel(f: Fighter): void {
    if (f.streak) this.scene.remove(f.streak);
    this.scene.remove(f.model.object);
    disposeModel(f.model);
  }
}
