/** Minimal text overlay showing FPS and controls hint. */
export class Hud {
  private readonly element: HTMLDivElement;
  private frames = 0;
  private accumulated = 0;

  constructor(overlay: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hud';
    overlay.appendChild(this.element);
    this.render(0);
  }

  update(dt: number): void {
    this.frames++;
    this.accumulated += dt;
    if (this.accumulated >= 0.5) {
      this.render(Math.round(this.frames / this.accumulated));
      this.frames = 0;
      this.accumulated = 0;
    }
  }

  private render(fps: number): void {
    const isTouch = matchMedia('(pointer: coarse)').matches;
    const hint = isTouch ? 'Drag anywhere to move · JUMP button' : 'WASD / arrows / drag to move · Space to jump';
    this.element.textContent = `${fps} fps\n${hint}`;
  }
}
