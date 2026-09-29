import { Color, DynamicDrawUsage, InstancedMesh, Object3D } from 'three';
import type { BufferGeometry, Material } from 'three';

export interface PoolItem {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds since spawn. */
  age: number;
  /** Seconds until auto-removal; Infinity for none. */
  life: number;
  scale: number;
  rotation: number;
  radius: number;
}

const dummy = new Object3D();
const tmpColor = new Color();

/**
 * Fixed-capacity pool of simple moving things (bullets, particles) drawn with a single
 * InstancedMesh, so hundreds of objects cost one draw call and no per-frame allocations.
 * Live items are kept packed in `items[0..count)`; removal swaps with the last one.
 */
export class InstancedPool {
  readonly mesh: InstancedMesh;
  readonly items: PoolItem[];
  count = 0;

  constructor(geometry: BufferGeometry, material: Material, readonly capacity: number, withColor = false) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    if (withColor) this.mesh.setColorAt(0, tmpColor.set(0xffffff));
    this.items = Array.from({ length: capacity }, () => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      age: 0,
      life: Infinity,
      scale: 1,
      rotation: 0,
      radius: 0,
    }));
  }

  /** Returns the new item, or null when full (the spawn is dropped). */
  spawn(x: number, y: number, vx: number, vy: number, radius = 0, life = Infinity, color?: number): PoolItem | null {
    if (this.count >= this.capacity) return null;
    const index = this.count++;
    const item = this.items[index]!;
    item.x = x;
    item.y = y;
    item.vx = vx;
    item.vy = vy;
    item.radius = radius;
    item.life = life;
    item.age = 0;
    item.scale = 1;
    item.rotation = 0;
    if (color !== undefined) this.mesh.setColorAt(index, tmpColor.set(color));
    return item;
  }

  remove(index: number): void {
    const last = --this.count;
    if (index === last) return;
    const items = this.items;
    const removed = items[index]!;
    items[index] = items[last]!;
    items[last] = removed;
    if (this.mesh.instanceColor) {
      this.mesh.getColorAt(last, tmpColor);
      this.mesh.setColorAt(index, tmpColor);
    }
  }

  clear(): void {
    this.count = 0;
  }

  /** Integrates motion and ages items; removes expired ones and those rejected by `keep`. */
  update(dt: number, keep?: (item: PoolItem) => boolean): void {
    for (let i = this.count - 1; i >= 0; i--) {
      const item = this.items[i]!;
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.age += dt;
      if (item.age >= item.life || (keep && !keep(item))) this.remove(i);
    }
  }

  /** Uploads transforms to the GPU. Call once per frame after all updates. */
  sync(): void {
    for (let i = 0; i < this.count; i++) {
      const item = this.items[i]!;
      dummy.position.set(item.x, item.y, 0);
      dummy.rotation.set(0, 0, item.rotation);
      dummy.scale.setScalar(item.scale);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}
