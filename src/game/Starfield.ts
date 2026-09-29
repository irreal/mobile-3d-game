import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';

interface Layer {
  points: Points;
  positions: Float32Array;
  speed: number;
}

const SPREAD_X = 90;
const SPREAD_Y = 45;

/** Parallax star layers scrolling down behind the playfield to sell forward motion. */
export class Starfield {
  readonly layers: Layer[] = [];

  constructor() {
    const specs = [
      { count: 350, z: -45, size: 0.18, speed: 0.35, color: 0x7788bb },
      { count: 220, z: -25, size: 0.22, speed: 0.6, color: 0xaab8e8 },
      { count: 90, z: -8, size: 0.14, speed: 1, color: 0xffffff },
    ];
    for (const spec of specs) {
      const positions = new Float32Array(spec.count * 3);
      for (let i = 0; i < spec.count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * SPREAD_X * 2;
        positions[i * 3 + 1] = (Math.random() - 0.5) * SPREAD_Y * 2;
        positions[i * 3 + 2] = spec.z;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const points = new Points(
        geometry,
        new PointsMaterial({ color: spec.color, size: spec.size, sizeAttenuation: true, depthWrite: false }),
      );
      points.frustumCulled = false;
      this.layers.push({ points, positions, speed: spec.speed });
    }
  }

  /** `speed` is the scroll speed of the nearest layer in world units per second. */
  update(dt: number, speed: number): void {
    for (const layer of this.layers) {
      const p = layer.positions;
      const dy = layer.speed * speed * dt;
      for (let i = 1; i < p.length; i += 3) {
        let y = p[i]! - dy;
        if (y < -SPREAD_Y) y += SPREAD_Y * 2;
        p[i] = y;
      }
      layer.points.geometry.attributes.position!.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.points.geometry.dispose();
      (layer.points.material as PointsMaterial).dispose();
    }
  }
}
