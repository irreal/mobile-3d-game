/** On-screen touch button. Calls `onPress` on pointer down (no click delay). */
export class ActionButton {
  readonly element: HTMLButtonElement;
  private pointers = new Set<number>();

  constructor(overlay: HTMLElement, label: string, onPress: () => void) {
    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = 'action-button';
    this.element.textContent = label;
    overlay.appendChild(this.element);

    this.element.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.element.setPointerCapture(e.pointerId);
      this.pointers.add(e.pointerId);
      this.element.classList.add('pressed');
      onPress();
    });
    const release = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.element.classList.remove('pressed');
    };
    this.element.addEventListener('pointerup', release);
    this.element.addEventListener('pointercancel', release);
    this.element.addEventListener('lostpointercapture', release);
  }

  get isDown(): boolean {
    return this.pointers.size > 0;
  }
}
