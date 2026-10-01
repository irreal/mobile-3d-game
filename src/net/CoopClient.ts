/**
 * Co-op connection to the game server over WebRTC data channels: an unreliable, unordered
 * "state" channel for ship positions (UDP-like, no head-of-line blocking) and a reliable
 * "events" channel for joins, leaves, pings and the shared game (wave starts, kills, damage,
 * orb pickups). Signalling is one HTTPS POST of the offer. See server/protocol.go for the wire
 * format.
 */

export type CoopStatus = 'off' | 'connecting' | 'online' | 'error';

/** Flags bits in a player state. */
export const COOP_ALIVE = 1;
export const COOP_FIRING = 2;
export const COOP_COCKPIT = 4;
/** Recovering from a hit (blinking). */
export const COOP_HURT = 8;

export interface CoopShipState {
  /** -1..1 across the shared arena. */
  x: number;
  /** World y over the arena's half height. */
  y: number;
  flags: number;
  gun: number;
  gunLevel: number;
  rocketLevel: number;
  wave: number;
}

export interface RemotePlayer extends CoopShipState {
  id: number;
}

/** Shared-game messages from the server (see server/game.go). */
export type CoopGameEvent =
  | { t: 'wave'; w: number; seed: number; at: number; kills: number[]; picks: number[]; squad?: number }
  | { t: 'kill' | 'pick'; w: number; id: number; by: number }
  | { t: 'dmg'; w: number; by: number; h: [number, number][] }
  /** The squad's base fight starts at `at` (server ms). */
  | { t: 'boss'; w: number; at: number }
  /** A squadmate's game ended (`quit`: they disconnected rather than being shot down). */
  | { t: 'out'; id: number; quit?: boolean };

interface Sample extends CoopShipState {
  /** Server time (ms) the sender sent it at. */
  t: number;
}

/** Bumped on wire format changes; client and server refuse to pair across versions. */
export const PROTOCOL_VERSION = 2;
const MSG_PLAYER_STATE = 1;
const MSG_SNAPSHOT = 2;
const STATE_BYTES = 17;
/** Ship history kept per player, for interpolation and for `pilotsAt`. */
const HISTORY_MS = 1500;
/** `pilotsAt` holds a player's last sample this long past it (a lost packet or two). */
const HOLD_MS = 250;
const SEND_INTERVAL_MS = 1000 / 30;
/** Remote ships are drawn this far in the past, so there are snapshots on both sides. */
const INTERPOLATION_DELAY_MS = 100;
const STALE_MS = 3000;
const PING_INTERVAL_MS = 2000;
/** Quick pings right after connecting, so the clock is synced before the first wave. */
const FIRST_PINGS_MS = [250, 500, 800];
const CLOCK_SAMPLES = 10;
const RECONNECT_MS = 3000;
const GATHER_TIMEOUT_MS = 1000;
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

export class CoopClient {
  status: CoopStatus = 'off';
  /** Our player id on the server (0 until welcomed). */
  id = 0;
  /** Round-trip time in ms, or 0 before the first pong. */
  rttMs = 0;
  error = '';
  onChange: (() => void) | null = null;
  onGame: ((e: CoopGameEvent) => void) | null = null;

  private url = '';
  private pc: RTCPeerConnection | null = null;
  private stateChannel: RTCDataChannel | null = null;
  private eventsChannel: RTCDataChannel | null = null;
  private readonly samples = new Map<number, Sample[]>();
  /** What we sent, exactly as everyone else received it. */
  private readonly selfSamples: Sample[] = [];
  private readonly known = new Set<number>();
  private readonly sendBuffer = new ArrayBuffer(1 + STATE_BYTES);
  private lastSend = 0;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private firstPings: number[] = [];
  private wanted = false;
  /** Recent (round trip, server minus local clock) samples; the quickest round trip is trusted. */
  private clockSamples: { rtt: number; offset: number }[] = [];
  private clockOffset = Date.now() - performance.now();

  /** Players connected besides us. */
  get others(): number {
    return this.known.size;
  }

  connect(url: string): void {
    this.url = url.replace(/\/+$/, '');
    this.wanted = true;
    void this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.teardown();
    this.setStatus('off');
  }

  /** Server clock (Unix ms), from the local clock and the best ping sample. */
  serverNow(now = performance.now()): number {
    return now + this.clockOffset;
  }

  /** Sends a shared-game message; false if offline. */
  send(event: Record<string, unknown>): boolean {
    const dc = this.eventsChannel;
    if (this.status !== 'online' || !dc || dc.readyState !== 'open') return false;
    dc.send(JSON.stringify(event));
    return true;
  }

  /** Call every frame with the local ship; sends at most 30 times a second. */
  sendState(s: CoopShipState, now = performance.now()): void {
    const dc = this.stateChannel;
    if (this.status !== 'online' || !dc || dc.readyState !== 'open' || now - this.lastSend < SEND_INTERVAL_MS) return;
    this.lastSend = now;
    const t = Math.floor(this.serverNow(now));
    const v = new DataView(this.sendBuffer);
    v.setUint8(0, MSG_PLAYER_STATE);
    v.setFloat32(1, s.x, true);
    v.setFloat32(5, s.y, true);
    v.setUint8(9, s.flags);
    v.setUint8(10, s.gun);
    v.setUint8(11, s.gunLevel);
    v.setUint8(12, s.rocketLevel);
    v.setUint8(13, Math.min(255, s.wave));
    v.setUint32(14, t % 2 ** 32, true);
    dc.send(this.sendBuffer);
    const sent = { ...s, x: Math.fround(s.x), y: Math.fround(s.y), wave: Math.min(255, s.wave), t };
    addSample(this.selfSamples, sent);
  }

  /** Other players' ships, interpolated `INTERPOLATION_DELAY_MS` into the past. */
  remotes(now = performance.now()): RemotePlayer[] {
    const serverNow = this.serverNow(now);
    const out: RemotePlayer[] = [];
    for (const [id, list] of this.samples) {
      if (serverNow - list[list.length - 1]!.t > STALE_MS) {
        this.samples.delete(id);
        continue;
      }
      const s = sampleAt(list, serverNow - INTERPOLATION_DELAY_MS, Infinity);
      if (s) out.push({ ...s, id });
    }
    return out;
  }

  /**
   * Every player's ship (ours included) as it was at server time `serverMs`, from the states
   * everyone sent. Asked for a moment far enough back that all clients have the same samples,
   * every client gets the same answer, so it's what shared enemies aim at.
   */
  pilotsAt(serverMs: number): RemotePlayer[] {
    const out: RemotePlayer[] = [];
    const self = sampleAt(this.selfSamples, serverMs, HOLD_MS);
    if (self && this.id) out.push({ ...self, id: this.id });
    for (const [id, list] of this.samples) {
      const s = sampleAt(list, serverMs, HOLD_MS);
      if (s) out.push({ ...s, id });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  private async open(): Promise<void> {
    this.teardown();
    this.setStatus('connecting');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.pc = pc;
      const state = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
      const events = pc.createDataChannel('events');
      state.binaryType = 'arraybuffer';
      this.stateChannel = state;
      this.eventsChannel = events;
      state.onmessage = (e) => this.onSnapshot(e.data as ArrayBuffer);
      events.onmessage = (e) => this.onEvent(String(e.data));
      events.onopen = () => {
        this.setStatus('online');
        this.ping();
        this.firstPings = FIRST_PINGS_MS.map((ms) => window.setTimeout(() => this.ping(), ms));
        this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail('connection lost');
      };

      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc, GATHER_TIMEOUT_MS);
      const res = await fetch(`${this.url}/rtc/offer?v=${PROTOCOL_VERSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pc.localDescription),
      });
      if (res.status === 426) throw new Error('game out of date: reload');
      if (!res.ok) throw new Error(res.status === 503 ? 'server full' : `server error ${res.status}`);
      if (pc !== this.pc) return;
      await pc.setRemoteDescription((await res.json()) as RTCSessionDescriptionInit);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private fail(message: string): void {
    this.teardown();
    this.error = message;
    this.setStatus('error');
    if (this.wanted) this.reconnectTimer = window.setTimeout(() => void this.open(), RECONNECT_MS);
  }

  private teardown(): void {
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.reconnectTimer);
    for (const t of this.firstPings) window.clearTimeout(t);
    this.firstPings = [];
    this.clockSamples = [];
    const pc = this.pc;
    this.pc = null;
    this.stateChannel = null;
    this.eventsChannel = null;
    pc?.close();
    this.samples.clear();
    this.selfSamples.length = 0;
    this.known.clear();
    this.id = 0;
    this.rttMs = 0;
  }

  private setStatus(status: CoopStatus): void {
    this.status = status;
    if (status !== 'error') this.error = '';
    this.onChange?.();
  }

  private ping(): void {
    if (this.eventsChannel?.readyState === 'open') {
      this.eventsChannel.send(JSON.stringify({ t: 'ping', c: performance.now() }));
    }
  }

  private onEvent(text: string): void {
    let e: { t?: string; id?: number; players?: number[]; c?: number; s?: number; v?: number };
    try {
      e = JSON.parse(text) as typeof e;
    } catch {
      return;
    }
    switch (e.t) {
      case 'wave':
      case 'boss':
      case 'kill':
      case 'pick':
      case 'dmg':
      case 'out':
        this.onGame?.(e as CoopGameEvent);
        return;
      case 'welcome':
        if (e.v !== PROTOCOL_VERSION) {
          // An older server: the state format differs, so ships would come out as garbage.
          this.wanted = false;
          this.fail('server out of date');
          return;
        }
        this.id = e.id ?? 0;
        for (const id of e.players ?? []) this.known.add(id);
        break;
      case 'join':
        if (e.id) this.known.add(e.id);
        break;
      case 'leave':
        if (e.id) {
          this.known.delete(e.id);
          this.samples.delete(e.id);
        }
        break;
      case 'pong':
        if (typeof e.c === 'number') {
          const now = performance.now();
          const rtt = now - e.c;
          this.rttMs = Math.round(rtt);
          if (typeof e.s === 'number') this.addClockSample(rtt, e.s + rtt / 2 - now);
        }
        break;
      default:
        return;
    }
    this.onChange?.();
  }

  private addClockSample(rtt: number, offset: number): void {
    const samples = this.clockSamples;
    samples.push({ rtt, offset });
    if (samples.length > CLOCK_SAMPLES) samples.shift();
    let best = samples[0]!;
    for (const s of samples) if (s.rtt < best.rtt) best = s;
    this.clockOffset = best.offset;
  }

  private onSnapshot(data: ArrayBuffer): void {
    const v = new DataView(data);
    if (v.byteLength < 3 || v.getUint8(0) !== MSG_SNAPSHOT) return;
    const count = v.getUint16(1, true);
    const now = Math.floor(this.serverNow());
    for (let i = 0, o = 3; i < count && o + 2 + STATE_BYTES <= v.byteLength; i++, o += 2 + STATE_BYTES) {
      const id = v.getUint16(o, true);
      if (id === this.id) continue;
      let list = this.samples.get(id);
      if (!list) this.samples.set(id, (list = []));
      addSample(list, {
        t: unwrapTime(v.getUint32(o + 15, true), now),
        x: v.getFloat32(o + 2, true),
        y: v.getFloat32(o + 6, true),
        flags: v.getUint8(o + 10),
        gun: v.getUint8(o + 11),
        gunLevel: v.getUint8(o + 12),
        rocketLevel: v.getUint8(o + 13),
        wave: v.getUint8(o + 14),
      });
    }
  }
}

/** Full server ms from its low 32 bits, taking the value nearest `now`. */
function unwrapTime(low: number, now: number): number {
  let d = (now % 2 ** 32) - low;
  if (d > 2 ** 31) d -= 2 ** 32;
  else if (d < -(2 ** 31)) d += 2 ** 32;
  return now - d;
}

/** Inserts in time order (the state channel is unordered), skipping repeats; trims old history. */
function addSample(list: Sample[], s: Sample): void {
  let i = list.length;
  while (i > 0 && list[i - 1]!.t > s.t) i--;
  if (i > 0 && list[i - 1]!.t === s.t) return;
  list.splice(i, 0, s);
  const newest = list[list.length - 1]!.t;
  while (list.length > 2 && newest - list[0]!.t > HISTORY_MS) list.shift();
}

/**
 * The state at time `t`, interpolating position between the samples around it. Before the
 * first sample: none. After the last: the last one, for up to `holdMs`.
 */
function sampleAt(list: readonly Sample[], t: number, holdMs: number): Sample | null {
  if (list.length === 0 || t < list[0]!.t) return null;
  const last = list[list.length - 1]!;
  if (t >= last.t) return t - last.t <= holdMs ? last : null;
  let i = list.length - 1;
  while (i > 0 && list[i - 1]!.t > t) i--;
  const a = list[i - 1]!;
  const b = list[i]!;
  const k = (t - a.t) / (b.t - a.t || 1);
  return { ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Resolves once ICE gathering is done (non-trickle signalling), or after `timeoutMs`. */
function gatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      pc.removeEventListener('icegatheringstatechange', check);
      window.clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const STORAGE_KEY = 'nova-strike:coop';
export const DEFAULT_COOP_SERVER = 'https://novastrike.irreal.dev:7443';

/** Server URL: `?coop=` in the page URL, then the saved one, then the build override, then the default. */
export function coopServerUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('coop');
  if (fromQuery) {
    saveCoop(fromQuery, true);
    return fromQuery;
  }
  return loadCoop().url || (import.meta.env.VITE_COOP_SERVER as string | undefined) || DEFAULT_COOP_SERVER;
}

export function loadCoop(): { url: string; enabled: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { url?: string; enabled?: boolean };
    return { url: raw.url ?? '', enabled: raw.enabled ?? false };
  } catch {
    return { url: '', enabled: false };
  }
}

export function saveCoop(url: string, enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, enabled }));
  } catch {
    // Private mode: co-op still works for this session.
  }
}
