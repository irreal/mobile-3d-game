/**
 * Co-op connection to the game server over WebRTC data channels: an unreliable, unordered
 * "state" channel for ship positions (UDP-like, no head-of-line blocking) and a reliable
 * "events" channel for joins, leaves and pings. Signalling is one HTTPS POST of the offer.
 * See server/protocol.go for the wire format.
 */

export type CoopStatus = 'off' | 'connecting' | 'online' | 'error';

/** Flags bits in a player state. */
export const COOP_ALIVE = 1;
export const COOP_FIRING = 2;
export const COOP_COCKPIT = 4;

export interface CoopShipState {
  /** -1..1 across the playfield. */
  x: number;
  /** 0..1 from the bottom of the playfield. */
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

interface Sample extends CoopShipState {
  t: number;
}

const MSG_PLAYER_STATE = 1;
const MSG_SNAPSHOT = 2;
const STATE_BYTES = 13;
const SEND_INTERVAL_MS = 1000 / 30;
/** Remote ships are drawn this far in the past, so there are snapshots on both sides. */
const INTERPOLATION_DELAY_MS = 100;
const STALE_MS = 3000;
const PING_INTERVAL_MS = 2000;
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

  private url = '';
  private pc: RTCPeerConnection | null = null;
  private stateChannel: RTCDataChannel | null = null;
  private eventsChannel: RTCDataChannel | null = null;
  private readonly samples = new Map<number, Sample[]>();
  private readonly known = new Set<number>();
  private readonly sendBuffer = new ArrayBuffer(1 + STATE_BYTES);
  private lastSend = 0;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private wanted = false;

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

  /** Call every frame with the local ship; sends at most 30 times a second. */
  sendState(s: CoopShipState, now = performance.now()): void {
    const dc = this.stateChannel;
    if (this.status !== 'online' || !dc || dc.readyState !== 'open' || now - this.lastSend < SEND_INTERVAL_MS) return;
    this.lastSend = now;
    const v = new DataView(this.sendBuffer);
    v.setUint8(0, MSG_PLAYER_STATE);
    v.setFloat32(1, s.x, true);
    v.setFloat32(5, s.y, true);
    v.setUint8(9, s.flags);
    v.setUint8(10, s.gun);
    v.setUint8(11, s.gunLevel);
    v.setUint8(12, s.rocketLevel);
    v.setUint8(13, Math.min(255, s.wave));
    dc.send(this.sendBuffer);
  }

  /** Other players' ships, interpolated `INTERPOLATION_DELAY_MS` into the past. */
  remotes(now = performance.now()): RemotePlayer[] {
    const at = now - INTERPOLATION_DELAY_MS;
    const out: RemotePlayer[] = [];
    for (const [id, list] of this.samples) {
      const last = list[list.length - 1]!;
      if (now - last.t > STALE_MS) {
        this.samples.delete(id);
        continue;
      }
      let i = list.length - 1;
      while (i > 0 && list[i - 1]!.t > at) i--;
      const b = list[i]!;
      const a = list[i - 1];
      if (!a || at >= b.t) {
        out.push({ ...b, id });
        continue;
      }
      const k = Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t || 1)));
      out.push({ ...b, id, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
    }
    return out;
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
        this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail('connection lost');
      };

      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc, GATHER_TIMEOUT_MS);
      const res = await fetch(`${this.url}/rtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pc.localDescription),
      });
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
    const pc = this.pc;
    this.pc = null;
    this.stateChannel = null;
    this.eventsChannel = null;
    pc?.close();
    this.samples.clear();
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
    let e: { t?: string; id?: number; players?: number[]; c?: number };
    try {
      e = JSON.parse(text) as typeof e;
    } catch {
      return;
    }
    switch (e.t) {
      case 'welcome':
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
        if (typeof e.c === 'number') this.rttMs = Math.round(performance.now() - e.c);
        break;
      default:
        return;
    }
    this.onChange?.();
  }

  private onSnapshot(data: ArrayBuffer): void {
    const v = new DataView(data);
    if (v.byteLength < 3 || v.getUint8(0) !== MSG_SNAPSHOT) return;
    const count = v.getUint16(1, true);
    const t = performance.now();
    for (let i = 0, o = 3; i < count && o + 2 + STATE_BYTES <= v.byteLength; i++, o += 2 + STATE_BYTES) {
      const id = v.getUint16(o, true);
      if (id === this.id) continue;
      let list = this.samples.get(id);
      if (!list) this.samples.set(id, (list = []));
      list.push({
        t,
        x: v.getFloat32(o + 2, true),
        y: v.getFloat32(o + 6, true),
        flags: v.getUint8(o + 10),
        gun: v.getUint8(o + 11),
        gunLevel: v.getUint8(o + 12),
        rocketLevel: v.getUint8(o + 13),
        wave: v.getUint8(o + 14),
      });
      if (list.length > 8) list.shift();
    }
  }
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

/** Server URL: `?coop=` in the page URL, then the saved one, then the build default. */
export function coopServerUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('coop');
  if (fromQuery) {
    saveCoop(fromQuery, true);
    return fromQuery;
  }
  return loadCoop().url || (import.meta.env.VITE_COOP_SERVER as string | undefined) || '';
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
