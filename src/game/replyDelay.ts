/** Tunable delay (in beats) from a cockpit call to its reply; set from the pause menu. */
export const REPLY_DELAY_MIN = 4;
export const REPLY_DELAY_MAX = 8;
const DEFAULT_REPLY_DELAY = 4;
const STORAGE_KEY = 'nova-strike:reply-delay';

let current = load();

export function replyDelayBeats(): number {
  return current;
}

export function setReplyDelayBeats(beats: number): number {
  current = clamp(Math.round(beats));
  try {
    localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // Not persisted; fine.
  }
  return current;
}

function load(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (stored) return clamp(stored);
  } catch {
    // Storage unavailable.
  }
  return DEFAULT_REPLY_DELAY;
}

function clamp(beats: number): number {
  return Math.min(REPLY_DELAY_MAX, Math.max(REPLY_DELAY_MIN, beats));
}
