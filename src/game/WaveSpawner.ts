import { MathUtils } from 'three';
import { DIFFICULTY_RAMP_TIME, WAVES } from './constants.ts';
import type { EnemyKind } from './Enemy.ts';
import { randFloat, randInt } from './rng.ts';
import type { Rng } from './rng.ts';

export type SpawnFn = (kind: EnemyKind, x: number, yOffset: number, phase: number, delay?: number) => void;

type Formation = 'line' | 'snake' | 'vee' | 'tank' | 'swoop' | 'dive' | 'spray' | 'pincer';

interface FormationRule {
  formation: Formation;
  /** Seconds of play before this formation can appear. */
  from: number;
  weight: number;
}

const RULES: readonly FormationRule[] = [
  { formation: 'line', from: 0, weight: 3 },
  { formation: 'snake', from: 8, weight: 2 },
  { formation: 'swoop', from: 12, weight: 2 },
  { formation: 'dive', from: 24, weight: 2 },
  { formation: 'vee', from: 40, weight: 2 },
  { formation: 'spray', from: 55, weight: 1 },
  { formation: 'pincer', from: 70, weight: 1 },
];

/**
 * Spawns a wave as a fixed number of formations picked over time; spawns get denser and
 * more varied as play goes on. Heavies (which drop power-ups) come at fixed points in each
 * wave, so upgrades are deterministic. `done` turns true once the wave's last formation is out.
 */
export class WaveSpawner {
  wave = 0;
  private timer = 1.2;
  private formationsLeft = 0;
  private formationTotal = 0;
  private formationIndex = 0;
  private tankIndices: number[] = [];
  private rng: Rng = Math.random;
  /**
   * Play time at which the next formation is due. Picks follow this schedule rather than the
   * frame clock, so seeded co-op clients make identical choices whatever their frame rate.
   */
  private clock = 0;

  reset(): void {
    this.wave = 0;
    this.formationsLeft = 0;
  }

  /** `time` is play time so far; `rng` drives every random choice in the wave (seeded in co-op). */
  startWave(time: number, rng: Rng = Math.random): void {
    this.rng = rng;
    this.wave++;
    this.timer = 1.5;
    this.clock = time + this.timer;
    const total = Math.min(WAVES.baseFormations + WAVES.formationsPerWave * (this.wave - 1), WAVES.maxFormations);
    this.formationsLeft = total;
    this.formationTotal = total;
    this.formationIndex = 0;
    const slots = this.wave >= WAVES.twoTanksFromWave ? WAVES.tankSlots : [WAVES.singleTankSlot];
    this.tankIndices = slots.map((f) => Math.floor(total * f));
  }

  /** Testing: mark the current wave's formations as all sent. */
  skipWave(): void {
    this.formationsLeft = 0;
  }

  /** 0..1 share of this wave's formations already sent. */
  get progress(): number {
    return this.formationTotal > 0 ? 1 - this.formationsLeft / this.formationTotal : 0;
  }

  /** 0..1 ramp from the scheduled play time; enemies spawned now get this. */
  get difficulty(): number {
    return Math.min(this.clock / DIFFICULTY_RAMP_TIME, 1);
  }

  get done(): boolean {
    return this.formationsLeft <= 0;
  }

  update(dt: number, halfWidth: number, spawnAt: SpawnFn): void {
    if (this.done) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.formationsLeft--;
    // Spawned partway into a frame: start them that much into their entry.
    const late = -this.timer;
    const spawn: SpawnFn = (kind, x, yOffset, phase, delay = 0) => spawnAt(kind, x, yOffset, phase, delay - late);

    const difficulty = this.difficulty;
    const formation = this.tankIndices.includes(this.formationIndex++) ? 'tank' : this.pick(this.clock);
    const span = halfWidth - 1.2;
    const before = this.timer;
    this.timer = MathUtils.lerp(2.2, 0.8, difficulty);

    switch (formation) {
      case 'line': {
        const n = randInt(this.rng, 3, difficulty > 0.5 ? 6 : 4);
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? 0 : MathUtils.lerp(-span, span, i / (n - 1)) * 0.85;
          spawn('grunt', x, 0, i * 0.7);
        }
        break;
      }
      case 'snake': {
        const x = randFloat(this.rng, -span * 0.5, span * 0.5);
        const n = randInt(this.rng, 4, 6);
        for (let i = 0; i < n; i++) spawn('weaver', x, i * 1.5, -i * 0.55);
        this.timer += 0.8;
        break;
      }
      case 'vee': {
        const cx = randFloat(this.rng, -span * 0.3, span * 0.3);
        for (let i = -2; i <= 2; i++) spawn('grunt', cx + i * 1.8, Math.abs(i) * 1.2, i);
        break;
      }
      case 'swoop': {
        // A train of fighters arcing across from one side.
        const side = this.rng() < 0.5 ? -1 : 1;
        const n = randInt(this.rng, 4, difficulty > 0.5 ? 6 : 5);
        const row = randFloat(this.rng, 0, 2);
        for (let i = 0; i < n; i++) spawn('swooper', side, 0, row, i * 0.32);
        this.timer += 0.6;
        break;
      }
      case 'dive': {
        // Divers drop in, lock on one after another, then dash at the player.
        const n = difficulty > 0.5 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const x = MathUtils.lerp(-span, span, i / (n - 1)) * 0.7;
          spawn('diver', x, 0, i % 2, i * 0.45);
        }
        this.timer += 0.8;
        break;
      }
      case 'spray': {
        spawn('sprayer', randFloat(this.rng, -span * 0.3, span * 0.3), 0, this.rng() * Math.PI * 2);
        spawn('weaver', -span * 0.7, 2, 0, 1.2);
        spawn('weaver', span * 0.7, 2, Math.PI, 1.2);
        this.timer += 2.5;
        break;
      }
      case 'pincer': {
        // Swoopers from both sides at once, crossing in the middle.
        for (let i = 0; i < 3; i++) {
          spawn('swooper', -1, 0, 0.4, i * 0.35);
          spawn('swooper', 1, 0, 2.2, i * 0.35);
        }
        this.timer += 1;
        break;
      }
      case 'tank': {
        const x = randFloat(this.rng, -span * 0.4, span * 0.4);
        spawn('tank', x, 0, this.rng() * Math.PI * 2);
        spawn('grunt', MathUtils.clamp(x - 3, -span, span), 1.5, 0);
        spawn('grunt', MathUtils.clamp(x + 3, -span, span), 1.5, Math.PI);
        this.timer += 2;
        break;
      }
    }
    this.clock += this.timer;
    // Carry the overshoot so spawn times don't drift with the frame rate.
    this.timer += before;
  }

  private pick(time: number): Formation {
    const available = RULES.filter((r) => time >= r.from);
    const total = available.reduce((sum, r) => sum + r.weight, 0);
    let roll = this.rng() * total;
    for (const rule of available) {
      roll -= rule.weight;
      if (roll <= 0) return rule.formation;
    }
    return 'line';
  }
}
