/** Uniform 0..1 random source; co-op seeds one so every client spawns the same wave. */
export type Rng = () => number;

/** mulberry32: tiny, fast and good enough for gameplay. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

export function randFloat(rng: Rng, low: number, high: number): number {
  return low + rng() * (high - low);
}
