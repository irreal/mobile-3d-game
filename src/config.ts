export const config = {
  /** Upper bound for renderer pixel ratio; 3x phones render at 2x to save fill rate. */
  maxPixelRatio: 2,
  /** Pixel ratio cap with post-processing on (bloom, MSAA render target, final pass). */
  maxPixelRatioFx: 1.5,
  /** Largest simulation step in seconds, so a backgrounded tab doesn't teleport things on resume. */
  maxDeltaTime: 0.1,
  antialias: true,
  shadows: false,
  camera: {
    fov: 60,
    near: 0.1,
    far: 200,
  },
} as const;
