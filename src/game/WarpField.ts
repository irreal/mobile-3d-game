import { AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, MathUtils } from 'three';

const COUNT = 260;
const LENGTH_AHEAD = 140;
const STREAK = 3.5;

/** Speed-line streaks rushing past the cockpit, fading in with the first-person view. */
export class WarpField {
  readonly object: LineSegments;
  private readonly positions = new Float32Array(COUNT * 6);
  private readonly material = new LineBasicMaterial({
    color: 0x9fd8ff,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  constructor() {
    for (let i = 0; i < COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = MathUtils.randFloat(5, 40);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const y = Math.random() * LENGTH_AHEAD;
      this.positions.set([x, y, z, x, y + STREAK, z], i * 6);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.object = new LineSegments(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** `anchorX/Y` is the ship position the tunnel is centered on. */
  update(dt: number, opacity: number, anchorX: number, anchorY: number, speed: number): void {
    this.object.visible = opacity > 0.01;
    if (!this.object.visible) return;
    this.material.opacity = opacity * 0.7;
    this.object.position.set(anchorX, anchorY - 10, 0);

    const p = this.positions;
    const dy = speed * dt;
    for (let i = 0; i < p.length; i += 6) {
      let y = p[i + 1]! - dy;
      if (y < 0) y += LENGTH_AHEAD;
      p[i + 1] = y;
      p[i + 4] = y + STREAK;
    }
    this.object.geometry.attributes.position!.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
