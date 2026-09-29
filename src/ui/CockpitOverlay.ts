export interface LockMarker {
  x: number;
  y: number;
  /** Rockets queued on this target. */
  count: number;
  /** Radius of the reticle in CSS pixels. */
  size: number;
}

/**
 * DOM layer for the first-person section: canopy frame, crosshair, lock-on reticles
 * that track targets, a timer bar, lock counter, callouts and hit flash.
 */
export class CockpitOverlay {
  private readonly root: HTMLDivElement;
  private readonly reticleLayer: HTMLDivElement;
  private readonly reticles: HTMLDivElement[] = [];
  private readonly brush: HTMLDivElement;
  private readonly lockCount: HTMLDivElement;
  private readonly timerFill: HTMLDivElement;
  private readonly focusFill: HTMLDivElement;
  private readonly focusMeter: HTMLDivElement;
  private readonly callout: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly letterboxTop: HTMLDivElement;
  private readonly letterboxBottom: HTMLDivElement;
  private calloutTimer = 0;
  private bootTimer = 0;

  constructor(overlay: HTMLElement) {
    this.root = div('cockpit');
    this.root.append(div('cockpit-frame'), div('cockpit-crosshair'));
    this.reticleLayer = div('cockpit-reticles');
    this.brush = div('cockpit-brush');
    this.lockCount = div('cockpit-locks');
    const timer = div('cockpit-timer');
    this.timerFill = div('cockpit-timer-fill');
    timer.append(this.timerFill);
    this.focusMeter = div('cockpit-focus');
    const focusLabel = div('cockpit-focus-label');
    focusLabel.textContent = 'FOCUS';
    const focusTrack = div('cockpit-focus-track');
    this.focusFill = div('cockpit-focus-fill');
    focusTrack.append(this.focusFill);
    this.focusMeter.append(focusLabel, focusTrack);
    this.callout = div('cockpit-callout');
    this.hint = div('cockpit-hint');
    this.hint.textContent = 'SWIPE OVER TARGETS TO LOCK · RELEASE TO FIRE';
    this.flash = div('cockpit-flash');
    const boot = div('cockpit-boot');
    for (const line of BOOT_LINES) {
      const row = div('cockpit-boot-line');
      row.textContent = line;
      boot.append(row);
    }
    this.root.append(
      this.reticleLayer,
      this.brush,
      this.lockCount,
      this.focusMeter,
      timer,
      this.callout,
      this.hint,
      boot,
      div('cockpit-scan'),
      this.flash,
    );
    this.letterboxTop = div('letterbox letterbox-top');
    this.letterboxBottom = div('letterbox letterbox-bottom');
    // Behind the HUD so score/lives stay readable.
    const hud = overlay.querySelector('.hud');
    overlay.insertBefore(this.root, hud);
    overlay.insertBefore(this.letterboxTop, hud);
    overlay.insertBefore(this.letterboxBottom, hud);
    this.setLetterbox(0);
  }

  /** Plays the HUD power-on sequence (flicker, scan line, boot text, instruments). */
  powerOn(seconds: number): void {
    this.root.classList.remove('booting');
    void this.root.offsetWidth;
    this.root.classList.add('booting');
    this.bootTimer = seconds + 0.2;
  }

  /** Cinematic bars during camera transitions; 0 hidden, 1 fully in. */
  setLetterbox(amount: number): void {
    const hidden = (1 - amount) * 100;
    this.letterboxTop.style.transform = `translateY(${-hidden}%)`;
    this.letterboxBottom.style.transform = `translateY(${hidden}%)`;
  }

  /** 0 hides everything; 1 is fully shown. */
  /** With a 3D cockpit interior, the painted canopy frame and dashboard are dropped. */
  setInterior(on: boolean): void {
    this.root.classList.toggle('with-interior', on);
  }

  setOpacity(opacity: number): void {
    this.root.style.opacity = String(opacity);
    this.root.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
  }

  setHintVisible(visible: boolean): void {
    this.hint.classList.toggle('visible', visible);
  }

  setLocks(markers: readonly LockMarker[], total: number, max: number): void {
    while (this.reticles.length < markers.length) {
      const r = div('cockpit-reticle');
      r.append(div('cockpit-reticle-count'));
      this.reticleLayer.append(r);
      this.reticles.push(r);
    }
    this.reticles.forEach((r, i) => {
      const m = markers[i];
      if (!m) {
        r.style.display = 'none';
        return;
      }
      r.style.display = '';
      r.style.left = `${m.x - m.size}px`;
      r.style.top = `${m.y - m.size}px`;
      r.style.width = r.style.height = `${m.size * 2}px`;
      (r.firstChild as HTMLDivElement).textContent = m.count > 1 ? `×${m.count}` : '';
    });
    this.lockCount.textContent = `LOCK ${total}/${max}`;
    this.lockCount.classList.toggle('full', total >= max);
  }

  /** Shows the swipe cursor at (x, y), or hides it when `x` is null. */
  setBrush(x: number | null, y = 0): void {
    if (x === null) {
      this.brush.classList.remove('visible');
      return;
    }
    this.brush.classList.add('visible');
    this.brush.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Focus meter level (0..1); `active` tints the view for the slow-mo. */
  setFocus(level: number, active: boolean): void {
    this.focusFill.style.transform = `scaleX(${level})`;
    this.focusMeter.classList.toggle('empty', level <= 0.01);
    this.root.classList.toggle('focusing', active);
  }

  setTimer(fraction: number): void {
    this.timerFill.style.transform = `scaleX(${Math.max(0, fraction)})`;
    this.timerFill.classList.toggle('low', fraction < 0.25);
  }

  showCallout(text: string, seconds = 1.1): void {
    this.callout.textContent = text;
    this.callout.classList.remove('pop');
    // Restart the CSS animation.
    void this.callout.offsetWidth;
    this.callout.classList.add('pop');
    this.calloutTimer = seconds;
  }

  hitFlash(): void {
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  update(dt: number): void {
    if (this.bootTimer > 0) {
      this.bootTimer -= dt;
      if (this.bootTimer <= 0) this.root.classList.remove('booting');
    }
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.callout.classList.remove('pop');
    }
  }

  reset(): void {
    this.setLocks([], 0, 1);
    this.setBrush(null);
    this.callout.classList.remove('pop');
    this.calloutTimer = 0;
    this.bootTimer = 0;
    this.root.classList.remove('booting', 'focusing');
  }
}

const BOOT_LINES = [
  'NOVA-7 FLIGHT SYSTEMS',
  'POWER ········ OK',
  'SENSORS ······ OK',
  'TARGETING ···· ONLINE',
  '▸ WEAPONS FREE',
];

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}
