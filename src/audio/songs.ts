/** [step within bar (0-15), MIDI note, length in 16th steps] */
export type NoteEvent = readonly [number, number, number];

export interface Bar {
  /** Bass root (MIDI). */
  root: number;
  /** Pad voicing (MIDI); arpeggios are built from it. */
  chord: readonly number[];
}

export interface Song {
  name: string;
  bpm: number;
  /** Chord loop, one entry per bar. */
  bars: readonly Bar[];
  /** 16-step patterns: 'x' hit, 'X' accented hit, '.' rest. */
  kick: string;
  snare: string;
  hat: string;
  /** 'x' root, 'o' root an octave up, '.' rest. */
  bass: string;
  /** Per 16th: index into [...chord, chord[0]+12, chord[1]+12], or -1 for rest. */
  arp: readonly number[];
  arpShift: number;
  /** One entry per bar. Plays on every other pass of its length, so sections alternate. */
  melody: readonly (readonly NoteEvent[])[];
  lead: OscillatorType;
  padLevel: number;
}

/** Top-down shooter theme: driving synthwave in A minor. */
export const NOVA_DRIVE: Song = {
  name: 'Nova Drive',
  bpm: 128,
  bars: [
    { root: 33, chord: [57, 60, 64] }, // Am
    { root: 29, chord: [57, 60, 65] }, // F
    { root: 36, chord: [55, 60, 64] }, // C
    { root: 31, chord: [55, 59, 62] }, // G
  ],
  kick: 'x...x...x...x...',
  snare: '....x.......x...',
  hat: '..x...x...x...xx',
  bass: 'x.xox.xox.xox.xo',
  arp: [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3],
  arpShift: 12,
  melody: [
    [
      [0, 76, 3],
      [3, 74, 3],
      [6, 72, 2],
      [8, 69, 6],
      [14, 72, 2],
    ],
    [
      [0, 72, 3],
      [3, 74, 3],
      [6, 76, 2],
      [8, 77, 4],
      [12, 76, 4],
    ],
    [
      [0, 79, 3],
      [3, 76, 3],
      [6, 72, 2],
      [8, 76, 6],
      [14, 74, 2],
    ],
    [
      [0, 74, 4],
      [4, 71, 4],
      [8, 67, 4],
      [12, 71, 4],
    ],
    [
      [0, 76, 3],
      [3, 74, 3],
      [6, 72, 2],
      [8, 69, 6],
      [14, 72, 2],
    ],
    [
      [0, 72, 3],
      [3, 74, 3],
      [6, 76, 2],
      [8, 77, 4],
      [12, 81, 4],
    ],
    [
      [0, 79, 4],
      [4, 76, 2],
      [6, 79, 2],
      [8, 84, 6],
      [14, 83, 2],
    ],
    [
      [0, 83, 4],
      [4, 79, 4],
      [8, 74, 8],
    ],
  ],
  lead: 'sawtooth',
  padLevel: 0.05,
};

/** Cockpit strike theme: faster, darker D minor with a harmonic-minor turnaround. */
export const LOCK_ON: Song = {
  name: 'Lock On',
  bpm: 146,
  bars: [
    { root: 38, chord: [62, 65, 69] }, // Dm
    { root: 34, chord: [58, 62, 65] }, // Bb
    { root: 31, chord: [58, 62, 67] }, // Gm
    { root: 33, chord: [57, 61, 64] }, // A
  ],
  kick: 'x...x...x...x.x.',
  snare: '....X.......X..x',
  hat: 'xxXxxxXxxxXxxxXx',
  bass: 'xxoxxxoxxxoxxxox',
  arp: [0, 2, 1, 3, 0, 2, 1, 4, 0, 2, 1, 3, 4, 3, 2, 1],
  arpShift: 12,
  melody: [
    [
      [0, 74, 2],
      [2, 77, 2],
      [4, 81, 4],
      [10, 79, 2],
      [12, 77, 4],
    ],
    [
      [0, 77, 2],
      [2, 74, 2],
      [4, 70, 4],
      [8, 72, 2],
      [10, 74, 6],
    ],
    [
      [0, 74, 2],
      [2, 79, 2],
      [4, 82, 4],
      [8, 81, 4],
      [12, 79, 4],
    ],
    [
      [0, 76, 4],
      [4, 73, 4],
      [8, 76, 4],
      [12, 81, 4],
    ],
  ],
  lead: 'square',
  padLevel: 0.035,
};
