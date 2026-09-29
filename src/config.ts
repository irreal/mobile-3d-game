export const config = {
  /** Upper bound for renderer pixel ratio; 3x phones render at 2x to save fill rate. */
  maxPixelRatio: 2,
  /** Largest simulation step in seconds, so a backgrounded tab doesn't teleport things on resume. */
  maxDeltaTime: 0.1,
  antialias: true,
  shadows: true,
  camera: {
    fovLandscape: 55,
    /** Portrait screens are narrow, so widen the vertical FOV to keep the horizontal view usable. */
    fovPortrait: 70,
    near: 0.1,
    far: 200,
  },
  joystick: {
    /** Max knob travel in CSS pixels. */
    radius: 50,
    deadZone: 0.12,
  },
} as const;
