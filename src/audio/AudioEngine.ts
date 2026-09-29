export interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  /** Ramp the cutoff to this over the sound's duration. */
  to?: number;
  q?: number;
}

export interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  /** Exponential pitch glide target over `duration`. */
  to?: number;
  /** Start time (AudioContext clock); defaults to now. */
  time?: number;
  duration: number;
  gain: number;
  attack?: number;
  /** Hold the level and release at the end (pads, leads) instead of decaying (plucks, blips). */
  sustain?: boolean;
  release?: number;
  detune?: number;
  filter?: FilterSpec;
  destination?: AudioNode;
}

export interface NoiseSpec {
  time?: number;
  duration: number;
  gain: number;
  attack?: number;
  sustain?: boolean;
  release?: number;
  filter: FilterSpec;
  destination?: AudioNode;
}

const MUTE_STORAGE_KEY = 'nova-strike:muted';

type AudioContextCtor = typeof AudioContext;

/**
 * Web Audio graph and synth primitives. All game audio is synthesized at runtime (no
 * asset files), so there is nothing to license and nothing to download.
 *
 * Graph: music bus → music filter → music gain ┐
 *        echo send → delay ⟲ feedback ─────────┤→ master → compressor → speakers
 *        sfx bus ──────────────────────────────┘
 *
 * Mobile browsers only start audio from a user gesture, so the context is resumed on the
 * first touch/click/key press. When Web Audio is unavailable every method is a no-op.
 */
export class AudioEngine {
  readonly ctx: AudioContext | null;
  readonly music!: GainNode;
  readonly musicFilter!: BiquadFilterNode;
  readonly echo!: GainNode;
  readonly sfx!: GainNode;
  private readonly master!: GainNode;
  private readonly musicLevel!: GainNode;
  private readonly delay!: DelayNode;
  private unlocked = false;
  private noiseBuffer: AudioBuffer | null = null;
  private muteListeners = new Set<(muted: boolean) => void>();
  muted: boolean;

  constructor() {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    this.ctx = Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
    this.muted = readMuted();
    if (!this.ctx) return;
    const ctx = this.ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(compressor);

    this.musicLevel = ctx.createGain();
    this.musicLevel.gain.value = 0.55;
    this.musicLevel.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.8;
    this.musicFilter.connect(this.musicLevel);
    this.music = ctx.createGain();
    this.music.connect(this.musicFilter);

    this.echo = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.34;
    this.delay = delay;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.echo.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(this.musicFilter);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.8;
    this.sfx.connect(this.master);

    this.installUnlock();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else if (this.unlocked) void ctx.resume();
    });
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * AudioContext time that is reaching the speakers at `perfMs` (performance.now() time
   * base). Lags `currentTime` by the output latency, so input can be judged against what
   * the player actually hears.
   */
  audibleTime(perfMs = performance.now()): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const now = performance.now();
    const ts = ctx.getOutputTimestamp?.();
    if (ts?.contextTime !== undefined && ts.performanceTime) {
      const heard = ts.contextTime + (now - ts.performanceTime) / 1000;
      // Some implementations report stale or bogus timestamps; only trust sane ones.
      if (heard <= ctx.currentTime + 0.02 && heard > ctx.currentTime - 0.5) return heard + (perfMs - now) / 1000;
    }
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return ctx.currentTime - latency + (perfMs - now) / 1000;
  }

  setEchoTime(seconds: number): void {
    if (this.ctx) this.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.05);
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Not persisting the preference is fine.
    }
    if (this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.03);
    this.muteListeners.forEach((fn) => fn(muted));
  }

  onMuteChange(listener: (muted: boolean) => void): void {
    this.muteListeners.add(listener);
  }

  tone(spec: ToneSpec): void {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const t = spec.time ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = spec.type ?? 'sine';
    osc.frequency.setValueAtTime(spec.freq, t);
    if (spec.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t + spec.duration);
    if (spec.detune) osc.detune.value = spec.detune;
    const end = this.envelope(osc, spec, t);
    osc.start(t);
    osc.stop(end + 0.02);
  }

  noise(spec: NoiseSpec): void {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const t = spec.time ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise();
    src.loop = true;
    const end = this.envelope(src, spec, t);
    src.start(t, Math.random() * 1.5);
    src.stop(end + 0.02);
  }

  private envelope(
    source: AudioScheduledSourceNode,
    spec: {
      duration: number;
      gain: number;
      attack?: number;
      sustain?: boolean;
      release?: number;
      filter?: FilterSpec;
      destination?: AudioNode;
    },
    t: number,
  ): number {
    const ctx = this.ctx!;
    const amp = ctx.createGain();
    const attack = spec.attack ?? 0.004;
    const end = t + spec.duration;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(spec.gain, t + attack);
    if (spec.sustain) {
      const release = Math.min(spec.release ?? 0.08, spec.duration - attack);
      amp.gain.setValueAtTime(spec.gain, end - release);
      amp.gain.linearRampToValueAtTime(0, end);
    } else {
      amp.gain.exponentialRampToValueAtTime(0.0001, end);
    }

    let node: AudioNode = source;
    if (spec.filter) {
      const f = ctx.createBiquadFilter();
      f.type = spec.filter.type;
      f.frequency.setValueAtTime(spec.filter.freq, t);
      if (spec.filter.to !== undefined) f.frequency.exponentialRampToValueAtTime(spec.filter.to, end);
      if (spec.filter.q !== undefined) f.Q.value = spec.filter.q;
      node.connect(f);
      node = f;
    }
    node.connect(amp);
    amp.connect(spec.destination ?? this.sfx);
    return end;
  }

  private getNoise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const ctx = this.ctx!;
      const length = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  private installUnlock(): void {
    const ctx = this.ctx!;
    const events = ['pointerdown', 'touchend', 'click', 'keydown'] as const;
    const unlock = (): void => {
      void ctx.resume().then(() => {
        this.unlocked = true;
        if (ctx.state === 'running') events.forEach((e) => document.removeEventListener(e, unlock, true));
      });
      // iOS Safari needs a sound started inside the gesture to fully unlock output.
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
    };
    events.forEach((e) => document.addEventListener(e, unlock, true));
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
