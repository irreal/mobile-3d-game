import { AdditiveBlending, MathUtils, Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import type { Camera, Scene } from 'three';
import { createGlowMaterial, glowGeometry } from './glow.ts';
import { InstancedPool } from './InstancedPool.ts';
import type { PoolItem } from './InstancedPool.ts';
import { sharedGeometries } from './models.ts';

interface Ring {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  life: number;
  size: number;
  /** Faces the camera (cockpit view) instead of lying on the gameplay plane. */
  billboard: boolean;
}

const ringGeometry = new RingGeometry(0.82, 1, 48);

/**
 * Explosions and sparks: soft glowing billboards (sparks and flashes, bloom-friendly),
 * chunky debris, and expanding shock rings for big blasts. Each pool is one draw call.
 */
export class Effects {
  readonly sparks = new InstancedPool(glowGeometry, createGlowMaterial({ size: 1, intensity: 1.6 }), 900, true);
  readonly flashes = new InstancedPool(
    glowGeometry,
    createGlowMaterial({ size: 1, intensity: 1.1, core: 0.45 }),
    48,
    true,
  );
  readonly debris = new InstancedPool(
    sharedGeometries.particle,
    new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }),
    400,
    true,
  );
  private readonly rings: Ring[] = [];

  constructor(private readonly scene: Scene) {
    scene.add(this.debris.mesh, this.sparks.mesh, this.flashes.mesh);
  }

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
      const isDebris = i % 3 === 2;
      const pool = isDebris ? this.debris : this.sparks;
      const size = isDebris ? (spherical ? 0.6 : 1) : MathUtils.randFloat(0.35, 0.8) * (spherical ? 0.8 : 1);
      const p = pool.spawn(
        x,
        y,
        Math.cos(angle) * Math.cos(elevation) * s,
        Math.sin(angle) * Math.cos(elevation) * s,
        size,
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
    if (count >= 8) this.flash(x, y, z ?? 0, colors[0] ?? 0xffffff, Math.min(3.6, 0.8 + count * 0.04), life * 0.5);
  }

  /** Big bright bloom-y blob that swells and fades. */
  flash(x: number, y: number, z: number, color: number, size: number, life = 0.3): void {
    const p = this.flashes.spawn(x, y, 0, 0, size, life, color);
    if (p) p.z = z;
  }

  /** Expanding ring of light; lies flat on the playfield unless `billboard` (cockpit view). */
  ring(x: number, y: number, z: number, color: number, size: number, life = 0.5, billboard = false): void {
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    material.color.multiplyScalar(1.6);
    const mesh = new Mesh(ringGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.01);
    this.scene.add(mesh);
    this.rings.push({ mesh, material, age: 0, life, size, billboard });
  }

  /** Short-lived single particle, e.g. for rocket exhaust trails and engine plumes. */
  trail(x: number, y: number, z: number, color: number, life = 0.35, size = 0.55, vy = 0): void {
    const p = this.sparks.spawn(x, y, MathUtils.randFloatSpread(0.6), vy, size, life, color);
    if (!p) return;
    p.z = z;
  }

  update(dt: number, camera: Camera): void {
    const drag = Math.exp(-3 * dt);
    const shrink = (p: PoolItem): boolean => {
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
      p.rotation += dt * 6;
      // `radius` doubles as the particle's base size.
      p.scale = 1.4 * p.radius * (1 - p.age / p.life);
      return true;
    };
    this.sparks.update(dt, shrink);
    this.debris.update(dt, shrink);
    this.flashes.update(dt, (p) => {
      const t = p.age / p.life;
      p.scale = p.radius * (0.55 + 0.6 * Math.sqrt(t)) * (1 - t * t);
      return true;
    });
    this.sparks.sync();
    this.debris.sync();
    this.flashes.sync();

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        this.removeRing(i);
        continue;
      }
      const eased = 1 - (1 - t) ** 3;
      r.mesh.scale.setScalar(r.size * eased);
      r.material.opacity = (1 - t) ** 1.5;
      if (r.billboard) r.mesh.quaternion.copy(camera.quaternion);
    }
  }

  clear(): void {
    this.sparks.clear();
    this.debris.clear();
    this.flashes.clear();
    this.sparks.sync();
    this.debris.sync();
    this.flashes.sync();
    for (let i = this.rings.length - 1; i >= 0; i--) this.removeRing(i);
  }

  dispose(): void {
    this.clear();
    this.sparks.dispose();
    this.debris.dispose();
    this.flashes.dispose();
  }

  private removeRing(index: number): void {
    const r = this.rings[index]!;
    this.scene.remove(r.mesh);
    r.material.dispose();
    this.rings.splice(index, 1);
  }
}
