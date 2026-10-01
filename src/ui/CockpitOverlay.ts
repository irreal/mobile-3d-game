export type NoteStyle = 'strike' | 'heavy' | 'call' | 'laser';
export type Grade = 'perfect' | 'great' | 'good' | 'miss' | 'call';
export type PhraseMode = 'watch' | 'repeat' | null;

export interface NoteMarker {
  x: number;
  y: number;
  /** Radius of the target circle in CSS pixels. */
  size: number;
  /** 1 when the approach ring appears, 0 when it closes (the moment to tap); null for no ring. */
  approach: number | null;
  style: NoteStyle;
  /** Order in the sequence, shown inside the circle. */
  label: string;
  /** The next target to tap (others are dimmed). */
  next: boolean;
}

/** Guide for a laser swipe: a line through a row of targets, swiped from (x1, y1) to (x2, y2). */
export interface BeamGuide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  next: boolean;
}

export interface LaneNote {
  /** Beats until the note (negative once it is late). */
  beats: number;
  style: NoteStyle;
}

/** Beats of look-ahead shown on the beat lane. */
const LANE_BEATS = 4;
/** Hit line position along the lane (0..1 from the left). */
const LANE_HIT = 0.16;
const POPUPS = 8;

/**
 * DOM layer for the first-person section: canopy frame, beat-pulsing crosshair, approach
 * rings that track targets, a scrolling beat lane, combo, timer, callouts and hit flash.
 */
export class CockpitOverlay {
  private readonly root: HTMLDivElement;
  private readonly pulse: HTMLDivElement;
  private readonly noteLayer: HTMLDivElement;
  private readonly notes: HTMLDivElement[] = [];
  private readonly beams: HTMLDivElement[] = [];
  private readonly lane: HTMLDivElement;
  private readonly laneItems: HTMLDivElement[] = [];
  private readonly combo: HTMLDivElement;
  private readonly phase: HTMLDivElement;
  private readonly phaseLabel: HTMLDivElement;
  private readonly phasePips: HTMLDivElement[] = [];
  private readonly shield: HTMLDivElement;
  private readonly shieldPips: HTMLDivElement[] = [];
  private readonly popups: HTMLDivElement[] = [];
  private readonly timerFill: HTMLDivElement;
  private readonly callout: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly flash: HTMLDivElement;
  private readonly letterboxTop: HTMLDivElement;
  private readonly letterboxBottom: HTMLDivElement;
  private nextPopup = 0;
  private calloutTimer = 0;
  private bootTimer = 0;
  private shownCombo = -1;

  constructor(overlay: HTMLElement) {
    this.root = div('cockpit');
    const crosshair = div('cockpit-crosshair');
    this.pulse = div('cockpit-pulse');
    this.root.append(div('cockpit-frame'), this.pulse, crosshair);
    this.noteLayer = div('cockpit-notes');
    this.lane = div('cockpit-lane');
    this.lane.append(div('cockpit-lane-hit'));
    this.combo = div('cockpit-combo');
    this.phase = div('cockpit-phase');
    this.phaseLabel = div('cockpit-phase-label');
    const pips = div('cockpit-phase-pips');
    for (let i = 0; i < 4; i++) {
      const pip = div('cockpit-phase-pip');
      pips.append(pip);
      this.phasePips.push(pip);
    }
    this.phase.append(this.phaseLabel, pips);
    this.shield = div('cockpit-shield');
    const timer = div('cockpit-timer');
    this.timerFill = div('cockpit-timer-fill');
    timer.append(this.timerFill);
    this.callout = div('cockpit-callout');
    this.hint = div('cockpit-hint');
    this.hint.textContent = HINTS.rhythm;
    this.flash = div('cockpit-flash');
    const popupLayer = div('cockpit-popups');
    for (let i = 0; i < POPUPS; i++) {
      const p = div('cockpit-judge');
      popupLayer.append(p);
      this.popups.push(p);
    }
    const boot = div('cockpit-boot');
    for (const line of BOOT_LINES) {
      const row = div('cockpit-boot-line');
      row.textContent = line;
      boot.append(row);
    }
    this.root.append(
      this.noteLayer,
      popupLayer,
      this.lane,
      this.combo,
      this.phase,
      this.shield,
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

  /** With a 3D cockpit interior, the painted canopy frame and dashboard are dropped. */
  setInterior(on: boolean): void {
    this.root.classList.toggle('with-interior', on);
  }

  /** 0 hides everything; 1 is fully shown. */
  setOpacity(opacity: number): void {
    this.root.style.opacity = String(opacity);
    this.root.style.visibility = opacity > 0.01 ? 'visible' : 'hidden';
  }

  /** Which mini-game the HUD is dressed for (the beat lane and phase pips are rhythm only). */
  setMode(mode: 'rhythm' | 'asteroids'): void {
    this.root.classList.toggle('asteroids', mode === 'asteroids');
    this.hint.textContent = HINTS[mode];
  }

  setHintVisible(visible: boolean): void {
    this.hint.classList.toggle('visible', visible);
  }

  /** Swipe guides for laser rows, drawn under the target circles. */
  setBeams(guides: readonly BeamGuide[]): void {
    while (this.beams.length < guides.length) {
      const b = div('cockpit-beam');
      b.append(div('cockpit-beam-arrow'));
      this.noteLayer.prepend(b);
      this.beams.push(b);
    }
    this.beams.forEach((b, i) => {
      const g = guides[i];
      if (!g) {
        b.style.display = 'none';
        return;
      }
      b.style.display = '';
      b.classList.toggle('next', g.next);
      const dx = g.x2 - g.x1;
      const dy = g.y2 - g.y1;
      b.style.width = `${Math.hypot(dx, dy)}px`;
      b.style.transform = `translate(${g.x1}px, ${g.y1}px) rotate(${Math.atan2(dy, dx)}rad)`;
    });
  }

  /** Target circles with their closing approach rings. */
  setNotes(markers: readonly NoteMarker[]): void {
    while (this.notes.length < markers.length) {
      const n = div('cockpit-note');
      n.append(div('cockpit-note-ring'), div('cockpit-note-label'));
      this.noteLayer.append(n);
      this.notes.push(n);
    }
    this.notes.forEach((n, i) => {
      const m = markers[i];
      if (!m) {
        n.style.display = 'none';
        return;
      }
      n.style.display = '';
      const now = m.approach !== null && m.approach < 0.12;
      n.className = `cockpit-note ${m.style}${m.next ? ' next' : ''}${now ? ' now' : ''}`;
      n.style.transform = `translate(${m.x - m.size}px, ${m.y - m.size}px)`;
      n.style.width = n.style.height = `${m.size * 2}px`;
      const ring = n.firstChild as HTMLDivElement;
      const label = n.lastChild as HTMLDivElement;
      if (label.textContent !== m.label) label.textContent = m.label;
      if (m.approach === null) {
        ring.style.opacity = '0';
        return;
      }
      ring.style.transform = `scale(${1 + Math.max(0, m.approach) * 2.2})`;
      ring.style.opacity = String(Math.min(1, (1 - m.approach) * 4));
    });
  }

  /** Scrolls the beat lane (notes and beat ticks) and pulses the crosshair on the beat. */
  setBeat(beat: number, notes: readonly LaneNote[]): void {
    const width = this.lane.clientWidth;
    const hitX = width * LANE_HIT;
    const perBeat = (width - hitX) / LANE_BEATS;
    let used = 0;
    const place = (cls: string, beats: number): void => {
      let item = this.laneItems[used];
      if (!item) {
        item = div('');
        this.lane.append(item);
        this.laneItems.push(item);
      }
      used++;
      item.className = cls;
      item.style.display = '';
      item.style.transform = `translateX(${hitX + beats * perBeat}px)`;
    };
    for (let b = Math.ceil(beat - 0.5); b <= beat + LANE_BEATS; b++) {
      place(b % 4 === 0 ? 'cockpit-lane-tick bar' : 'cockpit-lane-tick', b - beat);
    }
    for (const n of notes) {
      if (n.beats > LANE_BEATS || n.beats < -0.5) continue;
      place(`cockpit-lane-note ${n.style}`, n.beats);
    }
    for (let i = used; i < this.laneItems.length; i++) this.laneItems[i]!.style.display = 'none';

    const frac = beat - Math.floor(beat);
    const downbeat = ((Math.floor(beat) % 4) + 4) % 4 === 0;
    const kick = (1 - frac) ** 3;
    this.pulse.style.transform = `scale(${1 + kick * (downbeat ? 0.5 : 0.3)})`;
    this.pulse.style.opacity = String(0.15 + kick * (downbeat ? 0.7 : 0.45));
  }

  /** Pops a judgement label ("PERFECT", "MISS", …) at a screen position. */
  judgement(text: string, grade: Grade, x: number, y: number): void {
    const p = this.popups[this.nextPopup]!;
    this.nextPopup = (this.nextPopup + 1) % this.popups.length;
    p.textContent = text;
    p.className = `cockpit-judge ${grade}`;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    void p.offsetWidth;
    p.classList.add('pop');
  }

  setCombo(combo: number, multiplier: number, overdrive: boolean): void {
    this.root.classList.toggle('overdrive', overdrive);
    if (combo === this.shownCombo) return;
    const grew = combo > this.shownCombo;
    this.shownCombo = combo;
    this.combo.innerHTML =
      combo >= 2 ? `<b>${combo}</b> COMBO${multiplier > 1 ? ` <i>×${multiplier}</i>` : ''}` : '';
    if (!grew) return;
    this.combo.classList.remove('bump');
    void this.combo.offsetWidth;
    this.combo.classList.add('bump');
  }

  /** WATCH / REPEAT indicator with one pip per beat of the current bar. */
  setPhase(mode: PhraseMode, beatInBar: number): void {
    this.phase.classList.toggle('watch', mode === 'watch');
    this.phase.classList.toggle('repeat', mode === 'repeat');
    const text = mode === 'watch' ? 'WATCH' : mode === 'repeat' ? 'REPEAT' : '';
    if (this.phaseLabel.textContent !== text) this.phaseLabel.textContent = text;
    this.phasePips.forEach((p, i) => p.classList.toggle('on', mode !== null && i <= beatInBar));
  }

  /** Flash marking the switch from the call to the player's response. */
  cueResponse(): void {
    for (const el of [this.root, this.phase]) {
      el.classList.remove('cue');
      void el.offsetWidth;
      el.classList.add('cue');
    }
  }

  setShield(level: number, max: number): void {
    while (this.shieldPips.length < max) {
      const pip = div('cockpit-shield-pip');
      this.shield.append(pip);
      this.shieldPips.push(pip);
    }
    this.shieldPips.forEach((p, i) => {
      p.style.display = i < max ? '' : 'none';
      p.classList.toggle('on', i < level);
    });
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
    this.setNotes([]);
    for (const item of this.laneItems) item.style.display = 'none';
    for (const p of this.popups) p.classList.remove('pop');
    this.setCombo(0, 1, false);
    this.setPhase(null, 0);
    this.callout.classList.remove('pop');
    this.calloutTimer = 0;
    this.bootTimer = 0;
    this.root.classList.remove('booting', 'cue');
  }
}

const HINTS = {
  rhythm: 'WATCH THE SEQUENCE · THEN TAP IT BACK IN RHYTHM',
  asteroids: 'DRAG TO STEER · DODGE THE ROCKS · FLY THROUGH THE RINGS',
};

const BOOT_LINES = [
  'NOVA-7 FLIGHT SYSTEMS',
  'POWER ········ OK',
  'SENSORS ······ OK',
  'BEAT SYNC ···· LOCKED',
  '▸ WEAPONS FREE',
];

function div(className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}
