import type { AudioEngine } from './AudioEngine.ts';
import type { Song } from './songs.ts';

const LOOKAHEAD = 0.15;
const TICK_MS = 25;

const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

interface Playback {
  song: Song;
  out: GainNode;
  step: number;
  nextTime: number;
}

/**
 * Step sequencer that schedules synthesized drums, bass, arpeggio, pads and lead slightly
 * ahead of time on the AudioContext clock (so timing stays tight even if frames drop).
 */
export class Music {
  private current: Playback | null = null;
  private timer: number | null = null;

  constructor(private readonly audio: AudioEngine) {}

  get playing(): Song | null {
    return this.current?.song ?? null;
  }

  /** Crossfades to `song` (no-op if it's already playing). */
  play(song: Song, fadeIn = 0.6): void {
    const ctx = this.audio.ctx;
    if (!ctx || this.current?.song === song) return;
    this.stop(fadeIn);

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeIn);
    out.connect(this.audio.music);
    this.current = { song, out, step: 0, nextTime: ctx.currentTime + 0.08 };
    this.audio.setEchoTime((60 / song.bpm) * 0.75);
    this.timer ??= window.setInterval(this.tick, TICK_MS);
  }

  stop(fadeOut = 0.6): void {
    const ctx = this.audio.ctx;
    const playback = this.current;
    this.current = null;
    if (!ctx || !playback) return;
    const g = playback.out.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(0, ctx.currentTime + fadeOut);
    window.setTimeout(() => playback.out.disconnect(), (fadeOut + 0.5) * 1000);
  }

  /** Smoothly moves the music low-pass cutoff (used to "muffle" music during transitions). */
  setCutoff(hz: number, seconds: number): void {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const f = this.audio.musicFilter.frequency;
    f.cancelScheduledValues(ctx.currentTime);
    f.setValueAtTime(f.value, ctx.currentTime);
    f.exponentialRampToValueAtTime(hz, ctx.currentTime + Math.max(0.01, seconds));
  }

  private readonly tick = (): void => {
    const ctx = this.audio.ctx;
    const p = this.current;
    if (!ctx || !p) return;
    // After a suspend (tab hidden), don't try to catch up on missed steps.
    if (p.nextTime < ctx.currentTime - 0.2) p.nextTime = ctx.currentTime + 0.05;
    const stepDur = 60 / p.song.bpm / 4;
    while (p.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleStep(p, p.step, p.nextTime, stepDur);
      p.step++;
      p.nextTime += stepDur;
    }
  };

  private scheduleStep(p: Playback, step: number, t: number, stepDur: number): void {
    const a = this.audio;
    const song = p.song;
    const s = step % 16;
    const barIndex = Math.floor(step / 16);
    const bar = song.bars[barIndex % song.bars.length]!;
    const out = p.out;

    const kick = song.kick[s];
    if (kick === 'x' || kick === 'X') {
      a.tone({ freq: 160, to: 42, time: t, duration: 0.32, gain: 0.9, destination: out });
      a.noise({ time: t, duration: 0.02, gain: 0.25, filter: { type: 'lowpass', freq: 2500 }, destination: out });
    }
    const snare = song.snare[s];
    if (snare === 'x' || snare === 'X') {
      const accent = snare === 'X' ? 1.3 : 1;
      a.noise({
        time: t,
        duration: 0.2,
        gain: 0.32 * accent,
        filter: { type: 'bandpass', freq: 1900, q: 0.8 },
        destination: out,
      });
      a.tone({ type: 'triangle', freq: 220, to: 150, time: t, duration: 0.12, gain: 0.25, destination: out });
    }
    const hat = song.hat[s];
    if (hat === 'x' || hat === 'X') {
      a.noise({
        time: t,
        duration: hat === 'X' ? 0.09 : 0.035,
        gain: hat === 'X' ? 0.12 : 0.07,
        filter: { type: 'highpass', freq: 7500 },
        destination: out,
      });
    }

    const bass = song.bass[s];
    if (bass === 'x' || bass === 'o') {
      const note = bar.root + (bass === 'o' ? 12 : 0);
      a.tone({
        type: 'sawtooth',
        freq: midiToHz(note),
        time: t,
        duration: stepDur * 1.8,
        gain: 0.22,
        filter: { type: 'lowpass', freq: 1400, to: 260, q: 6 },
        destination: out,
      });
    }

    const arpIndex = song.arp[s] ?? -1;
    if (arpIndex >= 0) {
      const tones = [...bar.chord, bar.chord[0]! + 12, bar.chord[1]! + 12];
      const note = tones[arpIndex % tones.length]! + song.arpShift;
      a.tone({
        type: 'square',
        freq: midiToHz(note),
        time: t,
        duration: stepDur * 1.5,
        gain: 0.045,
        filter: { type: 'lowpass', freq: 3200 },
        destination: out,
      });
      a.tone({ type: 'square', freq: midiToHz(note), time: t, duration: stepDur, gain: 0.03, destination: a.echo });
    }

    if (s === 0) {
      const barDur = stepDur * 16;
      for (const note of bar.chord) {
        for (const detune of [-8, 8]) {
          a.tone({
            type: 'sawtooth',
            freq: midiToHz(note),
            detune,
            time: t,
            duration: barDur,
            gain: song.padLevel,
            attack: 0.25,
            sustain: true,
            release: 0.3,
            filter: { type: 'lowpass', freq: 900 },
            destination: out,
          });
        }
      }
    }

    const melodyBars = song.melody.length;
    if (melodyBars > 0 && Math.floor(barIndex / melodyBars) % 2 === 1) {
      const events = song.melody[barIndex % melodyBars]!;
      for (const [start, note, length] of events) {
        if (start !== s) continue;
        const spec = {
          type: song.lead,
          freq: midiToHz(note),
          time: t,
          duration: stepDur * length * 0.95,
          gain: 0.06,
          attack: 0.01,
          sustain: true,
          release: 0.06,
          filter: { type: 'lowpass' as const, freq: 2600 },
        };
        a.tone({ ...spec, destination: out });
        a.tone({ ...spec, detune: 7, gain: 0.03, destination: out });
        a.tone({ ...spec, gain: 0.035, destination: a.echo });
      }
    }
  }
}
