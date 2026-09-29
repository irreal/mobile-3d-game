import { AdditiveBlending, MathUtils, MeshBasicMaterial } from 'three';
import { InstancedPool } from './InstancedPool.ts';
import { sharedGeometries } from './models.ts';

/** Explosion / spark particles, all in one instanced draw call. */
export class Effects {
  readonly particles = new InstancedPool(
    sharedGeometries.particle,
    new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }),
    600,
    true,
  );

  /** Burst of particles. With `z` set, particles fly out in 3D (for the cockpit view). */
  explode(
    x: number,
    y: number,
    colors: readonly number[],
    count: number,
    speed: number,
    life = 0.6,
    z?: number,
  ): void {
    const spherical = z !== undefined;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const s = speed * MathUtils.randFloat(0.3, 1);
      const elevation = spherical ? Math.asin(MathUtils.randFloatSpread(2)) : 0;
      const color = colors[i % colors.length];
      const p = this.particles.spawn(
        x,
        y,
        Math.cos(angle) * Math.cos(elevation) * s,
        Math.sin(angle) * Math.cos(elevation) * s,
        spherical ? 0.6 : 1,
        life * MathUtils.randFloat(0.6, 1.2),
        color,
      );
      if (!p) continue;
      p.rotation = Math.random() * Math.PI;
      if (spherical) {
        p.z = z;
        p.vz = Math.sin(elevation) * s;
      }
    }
  }

  /** Short-lived single particle, e.g. for rocket exhaust trails. */
  trail(x: number, y: number, z: number, color: number, life = 0.35): void {
    const p = this.particles.spawn(x, y, 0, 0, 0.4, life, color);
    if (!p) return;
    p.z = z;
    p.rotation = Math.random() * Math.PI;
  }

  update(dt: number): void {
    const drag = Math.exp(-3 * dt);
    this.particles.update(dt, (p) => {
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
      p.rotation += dt * 6;
      // `radius` doubles as the particle's base size.
      p.scale = 1.4 * p.radius * (1 - p.age / p.life);
      return true;
    });
    this.particles.sync();
  }

  clear(): void {
    this.particles.clear();
    this.particles.sync();
  }
}
