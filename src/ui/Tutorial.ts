export type TutorialId = 'flight' | 'cockpit';

interface TutorialRecord {
  shown: number;
  hidden: boolean;
}

/** Times shown before the "Don't show again" option appears. */
const OPT_OUT_AFTER = 3;
const STORAGE_PREFIX = 'nova-strike:tutorial:';

interface TutorialContent {
  title: string;
  art: string;
  lines: string[];
}

const CONTENT: Record<TutorialId, TutorialContent> = {
  flight: {
    title: 'HOW TO FLY',
    art: 'tutorial-art-drag',
    lines: [
      'Touch <b>anywhere</b> and drag to steer.',
      'The ship follows your finger’s <b>movement</b>, so keep your thumb below it.',
      'Your guns fire automatically. Dodge the pink bullets!',
    ],
  },
  cockpit: {
    title: 'COCKPIT STRIKE',
    art: 'tutorial-art-rhythm',
    lines: [
      'Rings close onto targets <b>on the beat</b>. <b>Tap the target</b> the moment its ring lines up.',
      'Each hit fires a rocket that lands on the music. Heavies (orange) need several hits.',
      'The bar at the bottom shows the <b>upcoming beats</b>.',
      '<b>Pink orbs</b> are incoming fire: tap them on their beat too, or take a hit.',
      'Miss and the target dodges and shoots back. Chain hits for a <b>combo</b> and <b>Overdrive</b>!',
    ],
  },
};

/** Remembers how often each tutorial was shown and whether the player opted out. */
export class TutorialStore {
  shouldShow(id: TutorialId): boolean {
    return !this.read(id).hidden;
  }

  /** Records a showing; returns how many times it has now been shown. */
  markShown(id: TutorialId): number {
    const record = this.read(id);
    record.shown++;
    this.write(id, record);
    return record.shown;
  }

  hide(id: TutorialId): void {
    const record = this.read(id);
    record.hidden = true;
    this.write(id, record);
  }

  reset(): void {
    for (const id of Object.keys(CONTENT) as TutorialId[]) {
      try {
        localStorage.removeItem(STORAGE_PREFIX + id);
      } catch {
        // Ignore unavailable storage.
      }
    }
  }

  private read(id: TutorialId): TutorialRecord {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + id);
      if (raw) return { shown: 0, hidden: false, ...(JSON.parse(raw) as Partial<TutorialRecord>) };
    } catch {
      // Fall through to defaults.
    }
    return { shown: 0, hidden: false };
  }

  private write(id: TutorialId, record: TutorialRecord): void {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(record));
    } catch {
      // Not persisting is acceptable.
    }
  }
}

/** Modal tutorial card. From the third showing on, it offers a "Don't show again" checkbox. */
export class TutorialOverlay {
  readonly store = new TutorialStore();
  private readonly modal: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly art: HTMLDivElement;
  private readonly body: HTMLUListElement;
  private readonly optOut: HTMLLabelElement;
  private readonly checkbox: HTMLInputElement;
  private current: TutorialId | null = null;
  private onClose: (() => void) | null = null;

  constructor(overlay: HTMLElement) {
    this.modal = document.createElement('div');
    this.modal.className = 'modal tutorial';
    this.modal.hidden = true;
    const card = document.createElement('div');
    card.className = 'modal-card';
    this.title = document.createElement('div');
    this.title.className = 'modal-title';
    this.art = document.createElement('div');
    this.body = document.createElement('ul');
    this.body.className = 'tutorial-lines';

    this.optOut = document.createElement('label');
    this.optOut.className = 'tutorial-optout';
    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.optOut.append(this.checkbox, document.createTextNode(' Don’t show again'));

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'menu-button primary';
    ok.textContent = 'GOT IT';
    ok.addEventListener('click', () => this.dismiss());

    card.append(this.title, this.art, this.body, this.optOut, ok);
    this.modal.append(card);
    this.modal.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.append(this.modal);
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** Shows the tutorial unless the player opted out. Returns whether it was shown. */
  showIfWanted(id: TutorialId, onClose: () => void): boolean {
    if (!this.store.shouldShow(id)) return false;
    const count = this.store.markShown(id);
    const content = CONTENT[id];
    this.current = id;
    this.onClose = onClose;
    this.title.textContent = content.title;
    this.art.className = `tutorial-art ${content.art}`;
    this.art.innerHTML = '<div class="tutorial-finger"></div><div class="tutorial-target"></div>';
    this.body.innerHTML = content.lines.map((line) => `<li>${line}</li>`).join('');
    this.checkbox.checked = false;
    this.optOut.hidden = count < OPT_OUT_AFTER;
    this.modal.hidden = false;
    return true;
  }

  /** Closes the card (as if "Got it" was pressed). */
  dismiss(): void {
    if (!this.current) return;
    if (!this.optOut.hidden && this.checkbox.checked) this.store.hide(this.current);
    this.current = null;
    this.modal.hidden = true;
    const done = this.onClose;
    this.onClose = null;
    done?.();
  }

  /** Closes without callbacks (e.g. when quitting). */
  cancel(): void {
    this.current = null;
    this.onClose = null;
    this.modal.hidden = true;
  }
}
