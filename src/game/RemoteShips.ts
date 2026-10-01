import { AdditiveBlending, Color, MathUtils, MeshBasicMaterial } from 'three';
import type { Scene } from 'three';
import { COOP_ALIVE, COOP_COCKPIT, COOP_FIRING, COOP_HURT } from '../net/CoopClient.ts';
import type { RemotePlayer } from '../net/CoopClient.ts';
import { GUN_TYPES, GUNS } from './constants.ts';
import { InstancedPool } from './InstancedPool.ts';
import { disposeModel, sharedGeometries } from './models.ts';
import { PlayerShip } from './PlayerShip.ts';
import type { Playfield } from './Playfield.ts';

/** Hull tints that tell co-op partners apart, by player id. */
const TINTS = [0xff6a3d, 0x57ff9a, 0xff6af0, 0xffd23d, 0x6fa8ff];

interface Remote {
  ship: PlayerShip;
  fireTimer: number;
  weapons: string;
  seen: boolean;
  /** Runs while they're recovering from a hit, to blink their hull like ours. */
  hurtTime: number;
}

/**
 * Other players' ships in the top-down view, from co-op snapshots: tinted hulls with their
 * current guns mounted, and harmless look-alike bolts while they fire.
 */
export class RemoteShips {
  private readonly remotes = new Map<number, Remote>();
  private readonly bolts = new InstancedPool(
    sharedGeometries.playerBullet,
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }),
    200,
    true,
  );

  constructor(private readonly scene: Scene) {
    scene.add(this.bolts.mesh);
  }

  /** `visible` is false while the local camera isn't in the top-down view. */
  update(dt: number, players: readonly RemotePlayer[], playfield: Playfield, visible: boolean): void {
    for (const r of this.remotes.values()) r.seen = false;
    for (const p of players) {
      const r = this.remotes.get(p.id) ?? this.add(p.id);
      r.seen = true;
      const ship = r.ship;
      ship.x = p.x * playfield.halfWidth;
      ship.y = p.y * playfield.arenaTop;
      const gun = GUN_TYPES[p.gun] ?? 'pulse';
      const level = MathUtils.clamp(p.gunLevel, 1, GUNS[gun].levels.length - 1);
      const key = `${gun}${level}/${p.rocketLevel}`;
      if (key !== r.weapons) {
        r.weapons = key;
        ship.weapons.set(gun, level, p.rocketLevel, false);
      }
      ship.destroyed = !(p.flags & COOP_ALIVE) || (p.flags & COOP_COCKPIT) !== 0 || !visible;
      r.hurtTime = p.flags & COOP_HURT ? r.hurtTime + dt : 0;
      ship.sync(dt, r.hurtTime > 0 ? 10 - r.hurtTime : 0);
      if (!ship.destroyed && p.flags & COOP_FIRING) this.fire(r, gun, level, dt);
    }
    for (const [id, r] of this.remotes) if (!r.seen) this.remove(id);

    const pf = playfield;
    this.bolts.update(dt, (b) => !pf.isOutside(b.x, b.y, 1));
    this.bolts.mesh.visible = visible;
    this.bolts.sync();
  }

  /** Last known position of a remote ship. */
  positionOf(id: number): { x: number; y: number } | null {
    const ship = this.remotes.get(id)?.ship;
    return ship ? { x: ship.x, y: ship.y } : null;
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
    this.bolts.clear();
    this.bolts.sync();
  }

  private add(id: number): Remote {
    const ship = new PlayerShip();
    const tint = new Color(TINTS[id % TINTS.length]!);
    for (const m of ship.model.flashMaterials) {
      m.emissive.copy(tint);
      m.emissiveIntensity = 0.35;
    }
    this.scene.add(ship.object);
    const r: Remote = { ship, fireTimer: 0, weapons: '', seen: true, hurtTime: 0 };
    this.remotes.set(id, r);
    return r;
  }

  private remove(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.ship.object);
    disposeModel(r.ship.model);
    this.remotes.delete(id);
  }

  private fire(r: Remote, type: (typeof GUN_TYPES)[number], level: number, dt: number): void {
    const gun = GUNS[type];
    const l = gun.levels[level]!;
    r.fireTimer -= dt;
    while (r.fireTimer <= 0) {
      r.fireTimer += l.interval;
      for (const [dx, deg] of l.shots) {
        const a = MathUtils.degToRad(90 + deg);
        const b = this.bolts.spawn(r.ship.x + dx, r.ship.y + 0.9, Math.cos(a) * l.speed, Math.sin(a) * l.speed, 0, l.life, gun.color);
        if (b) b.rotation = MathUtils.degToRad(deg);
      }
    }
  }
}
