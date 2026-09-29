import { config } from '../config.ts';

/**
 * Floating virtual joystick: appears wherever a pointer goes down on `surface`
 * and follows drags from there. Works with touch, pen, and mouse (handy on desktop).
 * `x`/`y` are in [-1, 1]; +y means "up the screen".
 */
export class VirtualJoystick {
  x = 0;
  y = 0;

  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;

  constructor(
    private readonly surface: HTMLElement,
    overlay: HTMLElement,
  ) {
    this.base = document.createElement('div');
    this.base.className = 'joystick';
    this.knob = document.createElement('div');
    this.knob.className = 'joystick-knob';
    this.base.appendChild(this.knob);
    overlay.appendChild(this.base);

    surface.addEventListener('pointerdown', this.onDown);
    surface.addEventListener('pointermove', this.onMove);
    surface.addEventListener('pointerup', this.onUp);
    surface.addEventListener('pointercancel', this.onUp);
    surface.addEventListener('lostpointercapture', this.onUp);
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onDown);
    this.surface.removeEventListener('pointermove', this.onMove);
    this.surface.removeEventListener('pointerup', this.onUp);
    this.surface.removeEventListener('pointercancel', this.onUp);
    this.surface.removeEventListener('lostpointercapture', this.onUp);
    this.base.remove();
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.surface.setPointerCapture(e.pointerId);

    const rect = this.surface.getBoundingClientRect();
    this.originX = e.clientX - rect.left;
    this.originY = e.clientY - rect.top;
    this.base.style.transform = `translate(${this.originX}px, ${this.originY}px)`;
    this.base.classList.add('active');
    this.setKnob(0, 0);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const rect = this.surface.getBoundingClientRect();
    let dx = e.clientX - rect.left - this.originX;
    let dy = e.clientY - rect.top - this.originY;

    const { radius, deadZone } = config.joystick;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    this.setKnob(dx, dy);

    const magnitude = Math.min(dist, radius) / radius;
    if (magnitude < deadZone) {
      this.x = 0;
      this.y = 0;
    } else {
      // Rescale so output ramps from 0 at the dead-zone edge to 1 at the rim.
      const scale = (magnitude - deadZone) / (1 - deadZone) / magnitude;
      this.x = (dx / radius) * scale;
      this.y = (-dy / radius) * scale;
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.base.classList.remove('active');
  };

  private setKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
