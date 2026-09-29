import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Points, PointsMaterial } from 'three';
import type { Texture } from 'three';

let sharedStarTexture: Texture | null = null;

/** Soft round dot, so stars aren't square points. */
function starTexture(): Texture {
  if (sharedStarTexture) return sharedStarTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sharedStarTexture = new CanvasTexture(canvas);
  return sharedStarTexture;
}

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
      { count: 350, z: -45, size: 0.18, speed: 0.35, color: 0x7788bb, glow: 1 },
      { count: 220, z: -25, size: 0.22, speed: 0.6, color: 0xaab8e8, glow: 1.4 },
      { count: 90, z: -8, size: 0.14, speed: 1, color: 0xffffff, glow: 2.2 },
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
      const material = new PointsMaterial({
        color: spec.color,
        size: spec.size * 2.2,
        sizeAttenuation: true,
        depthWrite: false,
        map: starTexture(),
        transparent: true,
        blending: AdditiveBlending,
      });
      material.color.multiplyScalar(spec.glow);
      const points = new Points(geometry, material);
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
