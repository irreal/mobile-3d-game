import { AdditiveBlending, BackSide, Color, Group, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

export interface PlanetLook {
  low: number;
  mid: number;
  high: number;
  sea: number;
  seaLevel: number;
  seaGlow: number;
  /** Atmosphere rim / halo colour. */
  atmosphere: number;
}

const NOISE3 = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise3(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v / 0.96875;
  }
`;

const VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uMid;
  uniform vec3 uHigh;
  uniform vec3 uSea;
  uniform float uSeaLevel;
  uniform float uSeaGlow;
  uniform vec3 uAtmosphere;
  uniform vec3 uSunDir;
  uniform float uSpin;
  uniform float uOpacity;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vView;
  ${NOISE3}

  void main() {
    vec3 d = normalize(vLocal);
    float c = cos(uSpin), s = sin(uSpin);
    d = vec3(c * d.x - s * d.y, s * d.x + c * d.y, d.z);
    float h = fbm3(d * 2.6 + 4.0);
    vec3 color = mix(uLow, uMid, smoothstep(0.3, 0.55, h));
    color = mix(color, uHigh, smoothstep(0.55, 0.8, h));
    vec3 emissive = vec3(0.0);
    if (uSeaLevel >= 0.0) {
      float under = smoothstep(uSeaLevel + 0.02, uSeaLevel - 0.02, h);
      vec3 sea = uSea * mix(0.7, 1.1, fbm3(d * 9.0));
      color = mix(color, uSeaGlow > 0.0 ? uSea * 0.3 : sea, under);
      emissive = uSea * uSeaGlow * under * smoothstep(0.45, 0.7, fbm3(d * 14.0));
    }
    // Cloud bands for worlds with weather.
    float clouds = smoothstep(0.55, 0.75, fbm3(d * vec3(3.0, 3.0, 7.0) + vec3(uSpin * 0.6, 0.0, 0.0)));
    color = mix(color, mix(uAtmosphere, vec3(1.0), 0.6), clouds * 0.55);
    float ndl = dot(vNormal, uSunDir);
    float light = smoothstep(-0.25, 0.7, ndl);
    color = color * (0.04 + light * 1.1) + emissive * (1.0 - light * 0.5);
    float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.5);
    color += uAtmosphere * rim * (0.2 + light) * 1.2;
    gl_FragColor = vec4(color, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 uAtmosphere;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    // Seen from outside through the back faces: brightest just off the limb, fading outward.
    float f = max(dot(-vNormal, vView), 0.0);
    float glow = pow(smoothstep(0.0, 0.42, f), 2.0) * (1.0 - smoothstep(0.42, 0.62, f));
    float light = 0.35 + 0.65 * smoothstep(-0.4, 0.6, dot(vNormal, uSunDir));
    gl_FragColor = vec4(uAtmosphere * glow * light * 1.4 * uOpacity, 1.0);
  }
`;

/** Distance from the camera; the planet's apparent size is set by its radius. */
const DISTANCE = 150;
const COCKPIT_DIR = new Vector3(0.12, 1, -0.22).normalize();
const dir = new Vector3();

/**
 * A planet hanging in space ahead of the ship. `size` 0..1 goes from a small disc to one that
 * fills most of the view; above 1 the camera is diving into it. Kept at a fixed distance from
 * the camera like a sky object, placed ahead-below in the top-down view and ahead in the cockpit.
 */
export class Planet {
  readonly object = new Group();
  private readonly surface: ShaderMaterial;
  private readonly halo: ShaderMaterial;
  private spin = Math.random() * 6;

  constructor(sunDir: Vector3) {
    this.surface = new ShaderMaterial({
      uniforms: {
        uLow: { value: new Color() },
        uMid: { value: new Color() },
        uHigh: { value: new Color() },
        uSea: { value: new Color() },
        uSeaLevel: { value: -1 },
        uSeaGlow: { value: 0 },
        uAtmosphere: { value: new Color() },
        uSunDir: { value: sunDir },
        uSpin: { value: 0 },
        uOpacity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.halo = new ShaderMaterial({
      uniforms: {
        uAtmosphere: this.surface.uniforms.uAtmosphere!,
        uSunDir: { value: sunDir },
        uOpacity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: HALO_FRAGMENT,
      side: BackSide,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const body = new Mesh(new SphereGeometry(1, 64, 32), this.surface);
    const halo = new Mesh(new SphereGeometry(1.16, 48, 24), this.halo);
    halo.renderOrder = -9;
    body.renderOrder = -8;
    body.frustumCulled = halo.frustumCulled = false;
    this.object.add(halo, body);
    this.object.visible = false;
  }

  setLook(look: PlanetLook): void {
    const u = this.surface.uniforms;
    u.uLow!.value.setHex(look.low);
    u.uMid!.value.setHex(look.mid);
    u.uHigh!.value.setHex(look.high);
    u.uSea!.value.setHex(look.sea);
    u.uSeaLevel!.value = look.seaLevel;
    u.uSeaGlow!.value = look.seaGlow;
    u.uAtmosphere!.value.setHex(look.atmosphere);
  }

  /** `cockpit` is the camera blend (0 top-down, 1 first person). */
  /**
   * `screenY` places it in the top-down view: tangent of its angle up the screen from centre
   * (above ~0.6 it is off the top edge).
   */
  update(dt: number, cameraPosition: Vector3, cockpit: number, size: number, screenY: number, opacity: number): void {
    this.object.visible = opacity > 0.001;
    if (!this.object.visible) return;
    this.spin += dt * 0.02;
    this.surface.uniforms.uSpin!.value = this.spin;
    this.surface.uniforms.uOpacity!.value = opacity;
    this.halo.uniforms.uOpacity!.value = opacity;
    const angle = 0.05 + 0.4 * Math.min(1.7, Math.max(0, size)) ** 1.5;
    const radius = DISTANCE * Math.min(0.9, Math.sin(Math.min(angle, Math.PI / 2)));
    dir.set(0.04, screenY, -1).normalize().lerp(COCKPIT_DIR, cockpit).normalize();
    this.object.position.copy(cameraPosition).addScaledVector(dir, DISTANCE);
    this.object.scale.setScalar(radius);
  }

  /** Fixed placement in the world (the victory backdrop) instead of following the camera. */
  place(dt: number, position: Vector3, radius: number, opacity: number): void {
    this.object.visible = opacity > 0.001;
    if (!this.object.visible) return;
    this.spin += dt * 0.03;
    this.surface.uniforms.uSpin!.value = this.spin;
    this.surface.uniforms.uOpacity!.value = opacity;
    this.halo.uniforms.uOpacity!.value = opacity;
    this.object.position.copy(position);
    this.object.scale.setScalar(radius);
  }

  dispose(): void {
    for (const child of this.object.children) (child as Mesh).geometry.dispose();
    this.surface.dispose();
    this.halo.dispose();
  }
}
