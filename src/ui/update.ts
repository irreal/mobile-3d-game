export type UpdateStatus = { kind: 'update'; version: string } | { kind: 'current' } | { kind: 'error' };

/** Compares the running build with `version.json` on the server (written at build time). */
export async function checkForUpdate(): Promise<UpdateStatus> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { kind: 'error' };
    const live = (await res.json()) as { version: string; commit: string };
    if (live.commit !== __APP_COMMIT__ || live.version !== __APP_VERSION__) return { kind: 'update', version: live.version };
    return { kind: 'current' };
  } catch {
    return { kind: 'error' };
  }
}

/** Reloads past any cached index.html (GitHub Pages caches it for a few minutes). */
export function reloadFresh(): void {
  const url = new URL(location.href);
  url.searchParams.set('v', String(Date.now()));
  location.replace(url.toString());
}

/**
 * Wires `el` as a check-for-update control: first press checks, and when a newer build (or
 * nothing to compare) is found the next press reloads.
 */
export function bindUpdateCheck(el: HTMLElement, idleText: string): () => void {
  let state: 'idle' | 'checking' | 'ready' = 'idle';
  const reset = (): void => {
    state = 'idle';
    el.textContent = idleText;
  };
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state === 'checking') return;
    if (state === 'ready') {
      reloadFresh();
      return;
    }
    state = 'checking';
    el.textContent = 'Checking…';
    void checkForUpdate().then((status) => {
      state = 'ready';
      if (status.kind === 'update') el.textContent = `Update to v${status.version} · tap to reload`;
      else if (status.kind === 'current') el.textContent = `Up to date (v${__APP_VERSION__}) · tap to reload`;
      else el.textContent = "Couldn't check · tap to reload";
    });
  });
  reset();
  return reset;
}
