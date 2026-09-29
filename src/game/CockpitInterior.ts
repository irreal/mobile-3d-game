import {
  AdditiveBlending,
  Box3,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

/**
 * "Space ship cockpit" by Osmic (Ville Seppanen), CC-BY 3.0 — see public/assets/cockpit.
 * The OBJ is y-up with the nose along +z, in roughly 4 cm units; groups are named parts.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}assets/cockpit/cockpit.obj`;
/** Pilot eye in model units: raised a little so the dashboard only fills the bottom of a portrait screen. */
const MODEL_EYE = new Vector3(0, 20, -8);
/** Model units → world units (canopy ends up ~0.85 wide, sized to the player ship). */
const SCALE = 0.014;

type PartName = 'inside_panels' | 'inside_controller' | 'inside_chair' | 'inside_bottom' | 'outside_hood' | 'inside_frames';

const PART_MATERIALS: Record<PartName, () => Material> = {
  inside_panels: () => new MeshStandardMaterial({ color: 0x1f2636, metalness: 0.55, roughness: 0.55, side: DoubleSide }),
  inside_bottom: () => new MeshStandardMaterial({ color: 0x161b26, metalness: 0.3, roughness: 0.8, side: DoubleSide }),
  inside_frames: () => new MeshStandardMaterial({ color: 0x8a95ab, metalness: 0.85, roughness: 0.3, side: DoubleSide }),
  inside_chair: () => new MeshStandardMaterial({ color: 0x3a2f2a, metalness: 0.1, roughness: 0.85, side: DoubleSide }),
  inside_controller: () =>
    new MeshStandardMaterial({ color: 0x2d323c, metalness: 0.7, roughness: 0.35, emissive: 0x5a0d10, side: DoubleSide }),
  // Unlit tint: a glossy lit canopy catches the key light as a huge bloomed highlight.
  outside_hood: () =>
    new MeshBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.05, depthWrite: false, side: DoubleSide }),
};

let template: Group | null = null;

/** Loads the cockpit model; resolves even on failure (the first-person view then has no interior). */
export async function loadCockpitModel(): Promise<void> {
  try {
    template = await new OBJLoader().loadAsync(MODEL_URL);
  } catch (error) {
    console.warn('Cockpit model failed to load; the cockpit view will have no interior.', error);
  }
}

/**
 * The ship's interior in world space (facing +y, up +z like the cockpit camera), placed at the
 * pilot's eye so the camera literally flies into it. Visible only near the end of the fly-in and while inside.
 */
export class CockpitInterior {
  readonly object = new Group();
  readonly available: boolean;
  private readonly light = new PointLight(0x6ff3ff, 0, 1.6, 1.5);
  private readonly glowMaterials: MeshBasicMaterial[] = [];

  constructor() {
    this.object.visible = false;
    this.available = template !== null;
    if (!template) return;

    const model = template.clone(true);
    model.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      const make = PART_MATERIALS[obj.name as PartName];
      obj.material = make ? make() : PART_MATERIALS.inside_panels();
      obj.renderOrder = obj.name === 'outside_hood' ? 5 : 0;
      if (obj.name === 'outside_hood') obj.add(canopyStruts(obj.geometry as BufferGeometry));
    });
    model.add(this.dashStrip(model));

    // Model axes → cockpit view: model +z (forward) = world +y, model +y (up) = world +z.
    const basis = new Matrix4().makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0));
    const inner = new Group();
    inner.add(model);
    inner.quaternion.setFromRotationMatrix(basis);
    inner.scale.setScalar(SCALE);
    inner.position.copy(MODEL_EYE).multiplyScalar(-SCALE).applyQuaternion(inner.quaternion);
    this.object.add(inner);

    this.light.position.set(0, 0.35, -0.2);
    this.object.add(this.light);
  }

  /** Follows the pilot eye; `power` (0..1) drives dashboard lights with the HUD boot. */
  update(eye: Vector3, visible: boolean, power: number): void {
    this.object.visible = this.available && visible;
    if (!this.object.visible) return;
    this.object.position.copy(eye);
    this.light.intensity = power * 0.9;
    for (const m of this.glowMaterials) m.opacity = 0.25 + power * 0.75;
  }

  dispose(): void {
    this.object.traverse((obj) => {
      if (obj instanceof Mesh || obj instanceof LineSegments) (obj.material as Material).dispose();
    });
  }

  /** Thin glowing strip along the dashboard's top edge, lit when the HUD powers on. */
  private dashStrip(model: Group): Mesh {
    const bottom = model.getObjectByName('inside_bottom');
    const box = bottom ? new Box3().setFromObject(bottom) : new Box3(new Vector3(-20, -10, -20), new Vector3(20, -4, 40));
    const material = new MeshBasicMaterial({
      color: new Color(0x6ff3ff).multiplyScalar(1.4),
      transparent: true,
      opacity: 0.25,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.glowMaterials.push(material);
    const strip = new Mesh(new PlaneGeometry(box.max.x - box.min.x, 0.6), material);
    strip.position.set(0, box.max.y + 0.3, box.max.z);
    return strip;
  }
}

/** Faint edge lines on the glass canopy read as struts and give it shape. */
function canopyStruts(geometry: BufferGeometry): LineSegments {
  return new LineSegments(
    new EdgesGeometry(geometry, 25),
    new LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.22, depthWrite: false }),
  );
}
