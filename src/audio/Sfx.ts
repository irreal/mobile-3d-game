import type { AudioEngine } from './AudioEngine.ts';

/** Minimum seconds between repeats, for sounds that can fire many times per frame. */
const THROTTLE: Record<string, number> = {
  shot: 0.07,
  hit: 0.035,
  enemyShot: 0.06,
  explosion: 0.03,
  rocket: 0.035,
  trailPop: 0.05,
  warpIn: 0.07,
};

/** Synthesized sound effects. */
export class Sfx {
  private readonly last = new Map<string, number>();

  constructor(private readonly a: AudioEngine) {}

  private throttled(name: string): boolean {
    const now = this.a.now;
    const min = THROTTLE[name] ?? 0;
    if (now - (this.last.get(name) ?? -Infinity) < min) return true;
    this.last.set(name, now);
    return false;
  }

  // --- Shooter ---------------------------------------------------------------------------

  shot(): void {
    if (this.throttled('shot')) return;
    this.a.tone({ type: 'square', freq: 1400, to: 520, duration: 0.06, gain: 0.035 });
  }

  hit(): void {
    if (this.throttled('hit')) return;
    this.a.tone({ type: 'triangle', freq: 420, to: 180, duration: 0.05, gain: 0.07 });
  }

  enemyShot(): void {
    if (this.throttled('enemyShot')) return;
    this.a.tone({ type: 'sine', freq: 620, to: 260, duration: 0.14, gain: 0.05 });
  }

  explosion(size: 'small' | 'big' = 'small'): void {
    if (this.throttled('explosion')) return;
    const big = size === 'big';
    const d = big ? 1.1 : 0.45;
    this.a.noise({
      duration: d,
      gain: big ? 0.7 : 0.35,
      filter: { type: 'lowpass', freq: big ? 2400 : 3200, to: 120, q: 1 },
    });
    this.a.tone({ freq: big ? 110 : 150, to: 32, duration: d * 0.8, gain: big ? 0.7 : 0.35 });
  }

  playerHit(): void {
    this.a.noise({ duration: 0.7, gain: 0.6, filter: { type: 'lowpass', freq: 1800, to: 100 } });
    this.a.tone({ type: 'sawtooth', freq: 440, to: 55, duration: 0.6, gain: 0.25 });
    this.a.tone({ type: 'square', freq: 90, to: 40, duration: 0.5, gain: 0.2 });
  }

  powerup(): void {
    const t = this.a.now;
    [0, 4, 7, 12].forEach((semi, i) => {
      this.a.tone({
        type: 'square',
        freq: 660 * 2 ** (semi / 12),
        time: t + i * 0.06,
        duration: 0.12,
        gain: 0.07,
        filter: { type: 'lowpass', freq: 4000 },
      });
    });
  }

  // --- Flow ------------------------------------------------------------------------------

  start(): void {
    const t = this.a.now;
    this.a.tone({ type: 'square', freq: 440, time: t, duration: 0.1, gain: 0.08 });
    this.a.tone({ type: 'square', freq: 880, time: t + 0.08, duration: 0.25, gain: 0.08 });
  }

  waveClear(): void {
    const t = this.a.now;
    [0, 4, 7, 11, 12, 16].forEach((semi, i) => {
      this.a.tone({
        type: 'triangle',
        freq: 523 * 2 ** (semi / 12),
        time: t + i * 0.08,
        duration: 0.35,
        gain: 0.12,
      });
    });
  }

  gameOver(): void {
    const t = this.a.now;
    [0, -3, -7, -12].forEach((semi, i) => {
      this.a.tone({
        type: 'sawtooth',
        freq: 330 * 2 ** (semi / 12),
        time: t + i * 0.22,
        duration: 0.5,
        gain: 0.1,
        filter: { type: 'lowpass', freq: 1400 },
      });
    });
  }

  /** Rising jet swell for the fly-in; ends with a low boom. */
  flyIn(duration: number): void {
    const t = this.a.now;
    this.a.noise({
      duration,
      gain: 0.28,
      attack: duration * 0.7,
      sustain: true,
      release: 0.3,
      filter: { type: 'bandpass', freq: 300, to: 3500, q: 1.2 },
    });
    this.a.tone({
      type: 'sawtooth',
      freq: 70,
      to: 420,
      duration,
      gain: 0.06,
      attack: duration * 0.8,
      sustain: true,
      release: 0.2,
      filter: { type: 'lowpass', freq: 600, to: 2200 },
    });
    this.a.tone({ freq: 90, to: 30, time: t + duration - 0.1, duration: 1.4, gain: 0.7 });
    this.a.noise({
      time: t + duration - 0.1,
      duration: 1.2,
      gain: 0.3,
      filter: { type: 'lowpass', freq: 900, to: 80 },
    });
  }

  /** Falling whoosh for the fly-out. */
  flyOut(duration: number): void {
    this.a.noise({
      duration,
      gain: 0.25,
      attack: 0.3,
      filter: { type: 'bandpass', freq: 3200, to: 250, q: 1.2 },
    });
    this.a.tone({
      type: 'sawtooth',
      freq: 380,
      to: 60,
      duration,
      gain: 0.05,
      attack: 0.3,
      filter: { type: 'lowpass', freq: 1800, to: 400 },
    });
  }

  /** HUD power-on: rising hum, then a sequence of system beeps. */
  hudBoot(duration: number): void {
    const t = this.a.now;
    this.a.tone({
      type: 'sawtooth',
      freq: 55,
      to: 110,
      duration: duration * 0.6,
      gain: 0.1,
      attack: 0.2,
      filter: { type: 'lowpass', freq: 200, to: 1600 },
    });
    const beeps = [0.35, 0.55, 0.7, 0.85, 1.05];
    beeps.forEach((offset, i) => {
      this.a.tone({
        type: 'square',
        freq: i === beeps.length - 1 ? 1760 : 880 + i * 110,
        time: t + offset * (duration / 1.8),
        duration: i === beeps.length - 1 ? 0.25 : 0.05,
        gain: 0.06,
      });
    });
  }

  // --- Cockpit ---------------------------------------------------------------------------

  /** Lock-on blip; pitch climbs with each lock in the current volley. */
  lock(count: number, max: number): void {
    const full = count >= max;
    this.a.tone({ type: 'square', freq: 700 * 2 ** ((count - 1) / 6), duration: 0.07, gain: 0.07 });
    if (full) this.a.tone({ type: 'square', freq: 2100, time: this.a.now + 0.07, duration: 0.12, gain: 0.06 });
  }

  rocket(): void {
    if (this.throttled('rocket')) return;
    this.a.noise({ duration: 0.35, gain: 0.25, filter: { type: 'bandpass', freq: 600, to: 3000, q: 2 } });
    this.a.tone({ type: 'sawtooth', freq: 180, to: 90, duration: 0.25, gain: 0.08 });
  }

  /** A fighter dropping out of warp: descending zap plus a soft thump. */
  warpIn(): void {
    if (this.throttled('warpIn')) return;
    this.a.tone({ type: 'sawtooth', freq: 2400, to: 180, duration: 0.28, gain: 0.05, filter: { type: 'lowpass', freq: 5000 } });
    this.a.noise({ duration: 0.25, gain: 0.18, filter: { type: 'highpass', freq: 3000, to: 600 } });
    this.a.tone({ freq: 120, to: 50, duration: 0.3, gain: 0.25 });
  }

  /** Slow-mo engage: pitch drops like time stretching. */
  focusIn(): void {
    this.a.tone({ type: 'sine', freq: 520, to: 140, duration: 0.35, gain: 0.1 });
    this.a.noise({ duration: 0.35, gain: 0.08, filter: { type: 'lowpass', freq: 2000, to: 200 } });
  }

  focusOut(): void {
    this.a.tone({ type: 'sine', freq: 160, to: 480, duration: 0.2, gain: 0.07 });
  }

  /** Full-lock volley. */
  overcharge(): void {
    const t = this.a.now;
    this.a.tone({ type: 'sawtooth', freq: 220, to: 880, duration: 0.3, gain: 0.08, filter: { type: 'lowpass', freq: 3000 } });
    [0, 7, 12].forEach((semi, i) => {
      this.a.tone({ type: 'square', freq: 880 * 2 ** (semi / 12), time: t + 0.05 + i * 0.05, duration: 0.2, gain: 0.05 });
    });
  }

  orbFire(): void {
    this.a.tone({ type: 'sine', freq: 180, to: 520, duration: 0.3, gain: 0.08 });
  }

  orbPop(): void {
    if (this.throttled('trailPop')) return;
    this.a.tone({ type: 'triangle', freq: 1200, to: 300, duration: 0.12, gain: 0.08 });
  }

  chain(count: number): void {
    const semi = Math.min(count, 10) * 2;
    this.a.tone({ type: 'triangle', freq: 880 * 2 ** (semi / 12), duration: 0.25, gain: 0.1 });
    this.a.tone({ type: 'sine', freq: 1760 * 2 ** (semi / 12), duration: 0.3, gain: 0.05 });
  }

  squadronCleared(): void {
    const t = this.a.now;
    [0, 7, 12, 16, 19, 24].forEach((semi, i) => {
      this.a.tone({ type: 'square', freq: 392 * 2 ** (semi / 12), time: t + i * 0.07, duration: 0.3, gain: 0.07 });
    });
  }

  escaped(): void {
    const t = this.a.now;
    this.a.tone({ type: 'square', freq: 440, time: t, duration: 0.2, gain: 0.07 });
    this.a.tone({ type: 'square', freq: 330, time: t + 0.2, duration: 0.4, gain: 0.07 });
  }

  alarm(): void {
    const t = this.a.now;
    for (let i = 0; i < 2; i++) {
      this.a.tone({ type: 'square', freq: 980, time: t + i * 0.2, duration: 0.1, gain: 0.05 });
    }
  }
}
