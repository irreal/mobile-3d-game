import { MathUtils } from 'three';
import { WAVES } from './constants.ts';
import type { EnemyKind } from './Enemy.ts';

export type SpawnFn = (kind: EnemyKind, x: number, yOffset: number, phase: number) => void;

type Formation = 'line' | 'snake' | 'vee' | 'tank';

interface FormationRule {
  formation: Formation;
  /** Seconds of play before this formation can appear. */
  from: number;
  weight: number;
}

const RULES: readonly FormationRule[] = [
  { formation: 'line', from: 0, weight: 3 },
  { formation: 'snake', from: 8, weight: 2 },
  { formation: 'vee', from: 40, weight: 2 },
  { formation: 'tank', from: 25, weight: 1 },
];

/**
 * Spawns a wave as a fixed number of formations picked over time; spawns get denser and
 * more varied as play goes on. `done` turns true once the wave's last formation is out.
 */
export class WaveSpawner {
  wave = 0;
  private timer = 1.2;
  private sinceTank = 0;
  private formationsLeft = 0;

  reset(): void {
    this.wave = 0;
    this.sinceTank = 0;
    this.formationsLeft = 0;
  }

  startWave(): void {
    this.wave++;
    this.timer = 1.5;
    this.formationsLeft = Math.min(
      WAVES.baseFormations + WAVES.formationsPerWave * (this.wave - 1),
      WAVES.maxFormations,
    );
  }

  get done(): boolean {
    return this.formationsLeft <= 0;
  }

  update(dt: number, time: number, difficulty: number, halfWidth: number, spawn: SpawnFn): void {
    if (this.done) return;
    this.sinceTank += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.formationsLeft--;

    const formation = this.pick(time);
    const span = halfWidth - 1.2;
    this.timer = MathUtils.lerp(2.2, 0.8, difficulty);

    switch (formation) {
      case 'line': {
        const n = MathUtils.randInt(3, difficulty > 0.5 ? 6 : 4);
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? 0 : MathUtils.lerp(-span, span, i / (n - 1)) * 0.85;
          spawn('grunt', x, 0, i * 0.7);
        }
        break;
      }
      case 'snake': {
        const x = MathUtils.randFloat(-span * 0.5, span * 0.5);
        const n = MathUtils.randInt(4, 6);
        for (let i = 0; i < n; i++) spawn('weaver', x, i * 1.5, -i * 0.55);
        this.timer += 0.8;
        break;
      }
      case 'vee': {
        const cx = MathUtils.randFloat(-span * 0.3, span * 0.3);
        for (let i = -2; i <= 2; i++) spawn('grunt', cx + i * 1.8, Math.abs(i) * 1.2, i);
        break;
      }
      case 'tank': {
        this.sinceTank = 0;
        const x = MathUtils.randFloat(-span * 0.4, span * 0.4);
        spawn('tank', x, 0, Math.random() * Math.PI * 2);
        spawn('grunt', MathUtils.clamp(x - 3, -span, span), 1.5, 0);
        spawn('grunt', MathUtils.clamp(x + 3, -span, span), 1.5, Math.PI);
        this.timer += 2;
        break;
      }
    }
  }

  private pick(time: number): Formation {
    // Guarantee a tank (and its power-up) roughly every 30 s once they're unlocked.
    if (time > 25 && this.sinceTank > 30) return 'tank';
    const available = RULES.filter((r) => time >= r.from && !(r.formation === 'tank' && this.sinceTank < 12));
    const total = available.reduce((sum, r) => sum + r.weight, 0);
    let roll = Math.random() * total;
    for (const rule of available) {
      roll -= rule.weight;
      if (roll <= 0) return rule.formation;
    }
    return 'line';
  }
}
