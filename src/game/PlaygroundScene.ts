import {
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import type { PerspectiveCamera } from 'three';
import type { GameScene } from '../core/Engine.ts';
import type { Input } from '../input/Input.ts';
import { Player } from './Player.ts';
import type { Obstacle } from './Player.ts';

const WORLD_SIZE = 60;
const CAMERA_OFFSET = new Vector3(0, 8, 10);
const CAMERA_LOOK_OFFSET = new Vector3(0, 1, 0);
const CAMERA_FOLLOW = 6;
const OBSTACLE_COLORS = [0x4f7cff, 0x46c2a5, 0xf2c14e, 0xb86bff, 0xef5b7b];

/** Placeholder level: lit ground, a few crates, and a player driven by `Input`. */
export class PlaygroundScene implements GameScene {
  readonly scene = new Scene();
  private readonly player = new Player();
  private readonly sun = new DirectionalLight(0xffffff, 2.2);
  private readonly obstacles: Obstacle[] = [];
  private readonly lookTarget = new Vector3();
  private readonly tmp = new Vector3();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: Input,
  ) {
    const sky = new Color(0x9fc6ff);
    this.scene.background = sky;
    this.scene.fog = new Fog(sky, 25, 70);

    this.scene.add(new HemisphereLight(0xdfeaff, 0x3b4a2f, 1.1));

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const s = this.sun.shadow.camera;
    s.left = -15;
    s.right = 15;
    s.top = 15;
    s.bottom = -15;
    s.near = 1;
    s.far = 60;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    const ground = new Mesh(
      // Larger than the playable area so its edge stays hidden in the fog.
      new PlaneGeometry(WORLD_SIZE * 4, WORLD_SIZE * 4),
      new MeshStandardMaterial({ color: 0x6fa35a, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new GridHelper(WORLD_SIZE, WORLD_SIZE / 2, 0x000000, 0x000000);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    this.scene.add(grid);

    this.addObstacles();
    this.scene.add(this.player.object);

    this.camera.position.copy(this.player.position).add(CAMERA_OFFSET);
    this.lookTarget.copy(this.player.position).add(CAMERA_LOOK_OFFSET);
    this.camera.lookAt(this.lookTarget);
  }

  update(dt: number): void {
    this.input.update();
    if (this.input.consumeJump()) this.player.jump();
    this.player.update(dt, this.input.move, this.obstacles, WORLD_SIZE / 2 - 1);

    const follow = 1 - Math.exp(-CAMERA_FOLLOW * dt);
    this.tmp.copy(this.player.position).add(CAMERA_OFFSET);
    this.camera.position.lerp(this.tmp, follow);
    this.tmp.copy(this.player.position).add(CAMERA_LOOK_OFFSET);
    this.lookTarget.lerp(this.tmp, follow);
    this.camera.lookAt(this.lookTarget);

    // Keep the shadow frustum centered on the player so it can stay small (sharper, cheaper).
    this.sun.target.position.copy(this.player.position);
    this.sun.position.copy(this.player.position).add(this.tmp.set(8, 16, 6));
  }

  dispose(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((m) => m.dispose());
      }
    });
  }

  private addObstacles(): void {
    // Deterministic layout so the level is the same every load.
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < 18; i++) {
      const w = 1 + rand() * 2.5;
      const d = 1 + rand() * 2.5;
      const h = 0.6 + rand() * 2;
      const x = (rand() - 0.5) * (WORLD_SIZE - 10);
      const z = (rand() - 0.5) * (WORLD_SIZE - 10);
      if (Math.hypot(x, z) < 4) continue;

      const color = OBSTACLE_COLORS[i % OBSTACLE_COLORS.length];
      const mesh = new Mesh(new BoxGeometry(w, h, d), new MeshStandardMaterial({ color, roughness: 0.6 }));
      mesh.position.set(x, h / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.obstacles.push({ position: mesh.position, halfX: w / 2, halfZ: d / 2, height: h });
    }
  }
}
