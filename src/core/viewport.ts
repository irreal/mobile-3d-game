/**
 * Blocks browser gestures that fight with game input: pinch-zoom, double-tap zoom,
 * pull-to-refresh, scroll bounce, long-press menus. CSS `touch-action: none` covers
 * most browsers; the listeners cover iOS Safari quirks.
 */
export function preventDefaultGestures(canvas: HTMLCanvasElement): void {
  const prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  const opts: AddEventListenerOptions = { passive: false };

  canvas.addEventListener('touchstart', prevent, opts);
  document.addEventListener('touchmove', prevent, opts);
  document.addEventListener('dblclick', prevent, opts);
  document.addEventListener('contextmenu', prevent, opts);
  // Non-standard iOS Safari pinch events.
  document.addEventListener('gesturestart', prevent, opts);
  document.addEventListener('gesturechange', prevent, opts);
  document.addEventListener('gestureend', prevent, opts);
}

/**
 * Calls `onChange` whenever the element's size may have changed: element resize,
 * window resize, orientation change, or mobile browser toolbar show/hide.
 * Returns an unsubscribe function.
 */
export function observeViewport(element: HTMLElement, onChange: () => void): () => void {
  const timers = new Set<number>();
  const handleOrientation = (): void => {
    onChange();
    // iOS reports stale dimensions right after orientationchange; check again once it settles.
    const id = window.setTimeout(() => {
      timers.delete(id);
      onChange();
    }, 300);
    timers.add(id);
  };

  const resizeObserver = new ResizeObserver(onChange);
  resizeObserver.observe(element);
  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', handleOrientation);
  screen.orientation?.addEventListener('change', handleOrientation);
  window.visualViewport?.addEventListener('resize', onChange);

  return () => {
    resizeObserver.disconnect();
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', handleOrientation);
    screen.orientation?.removeEventListener('change', handleOrientation);
    window.visualViewport?.removeEventListener('resize', onChange);
    timers.forEach((id) => window.clearTimeout(id));
  };
}
