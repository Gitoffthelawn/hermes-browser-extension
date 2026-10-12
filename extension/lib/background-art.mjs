export const ORIGINAL_BACKGROUND_ART = 'assets/img/hermes-browser-enter-gate-ink.png';
export const BACKGROUND_ART_STORAGE_KEY = 'hermesBrowserBackgroundArt';
// How many recent picks a newly opened panel avoids, so panels open side by
// side in different tabs show different artwork.
export const BACKGROUND_ART_RECENT_LIMIT = 5;

export const BACKGROUND_ART = Object.freeze([
  ORIGINAL_BACKGROUND_ART,
  'assets/img/background-art/01-living-browser-gate-ink.webp',
  'assets/img/background-art/02-memory-orrery-ink.webp',
  'assets/img/background-art/03-first-contact-ink.webp',
  'assets/img/background-art/04-network-crossing-ink.webp',
  'assets/img/background-art/05-messenger-axis-ink.webp',
  'assets/img/background-art/06-winged-passage-ink.webp',
  'assets/img/background-art/07-clockwork-dispatch-ink.webp',
  'assets/img/background-art/08-contained-cosmos-ink.webp',
  'assets/img/background-art/09-winged-dispatch-ink.webp',
  'assets/img/background-art/10-recursive-presence-ink.webp',
  'assets/img/background-art/stack-graf10-ink.webp',
  'assets/img/background-art/stack-graf13-ink.webp',
  'assets/img/background-art/stack-graf14-ink.webp',
  'assets/img/background-art/stack-graf12-ink.webp',
]);

/** Recent picks, newest first. Accepts the older single-string storage value. */
export function recentBackgroundArt(saved) {
  const list = Array.isArray(saved) ? saved : [saved];
  return [...new Set(list.filter((entry) => BACKGROUND_ART.includes(entry)))].slice(0, BACKGROUND_ART_RECENT_LIMIT);
}

/** A random entry that avoids `previous` (one entry or a list of recent ones). */
export function pickBackgroundArt(random = Math.random, previous = '') {
  const avoid = new Set(Array.isArray(previous) ? previous : [previous]);
  const filtered = BACKGROUND_ART.filter((entry) => !avoid.has(entry));
  const pool = filtered.length ? filtered : BACKGROUND_ART;
  const value = Number(typeof random === 'function' ? random() : random);
  const index = Number.isFinite(value)
    ? Math.min(pool.length - 1, Math.max(0, Math.floor(value * pool.length)))
    : 0;
  return pool[index];
}

export function backgroundArtCssValue(entry = '') {
  return BACKGROUND_ART.includes(entry) ? `url("${entry}")` : '';
}

/**
 * One artwork per open panel. Each panel picks once when it opens and keeps
 * that picture until it closes: switching tabs, or hiding and showing the
 * panel, never changes it. The pick avoids the last few used, so panels open
 * in separate tabs at the same time get different pictures.
 */
export function createBackgroundArtRotation({
  root,
  storage,
  random = Math.random,
  locks = globalThis.navigator?.locks,
}) {
  let current = '';

  async function chooseAndApply() {
    let recent = [];
    try {
      const saved = await storage?.get(BACKGROUND_ART_STORAGE_KEY);
      recent = recentBackgroundArt(saved?.[BACKGROUND_ART_STORAGE_KEY]);
    } catch {
      // Artwork must not block startup when optional storage is unavailable.
    }
    current = pickBackgroundArt(random, recent);
    root.style.setProperty('--background-art', backgroundArtCssValue(current));
    try {
      await storage?.set({ [BACKGROUND_ART_STORAGE_KEY]: [current, ...recent].slice(0, BACKGROUND_ART_RECENT_LIMIT) });
    } catch {
      // The panel keeps its pick even when the choice cannot be remembered.
    }
    return current;
  }

  // The lock serializes panels opening at the same moment, so each one sees
  // the others' picks before choosing.
  const ready = Promise.resolve()
    .then(() => (typeof locks?.request === 'function'
      ? locks.request('hermes-background-art', chooseAndApply)
      : chooseAndApply()))
    .catch(() => current);
  return {
    ready,
    dispose() {},
  };
}
