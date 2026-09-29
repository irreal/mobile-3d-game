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

  explode(x: number, y: number, colors: readonly number[], count: number, speed: number, life = 0.6): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const s = speed * MathUtils.randFloat(0.3, 1);
      const color = colors[i % colors.length];
      const p = this.particles.spawn(
        x,
        y,
        Math.cos(angle) * s,
        Math.sin(angle) * s,
        0,
        life * MathUtils.randFloat(0.6, 1.2),
        color,
      );
      if (p) p.rotation = Math.random() * Math.PI;
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-3 * dt);
    this.particles.update(dt, (p) => {
      p.vx *= drag;
      p.vy *= drag;
      p.rotation += dt * 6;
      p.scale = 1.4 * (1 - p.age / p.life);
      return true;
    });
    this.particles.sync();
  }

  clear(): void {
    this.particles.clear();
    this.particles.sync();
  }
}
