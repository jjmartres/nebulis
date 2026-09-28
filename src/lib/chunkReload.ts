/**
 * Recovering from a stale build.
 *
 * Route chunks are content-hashed and cached immutably, which is correct: the
 * bytes behind a given filename never change. The failure mode is a tab that
 * still holds an `index.html` from an older build. When it lazily requests a
 * route chunk it asks for a hash the server no longer has. Before this module
 * existed the server's SPA fallback answered that request with `index.html`, so
 * the browser tried to run HTML as a module and surfaced the opaque
 * "Importing a module script failed" instead of a clean 404.
 *
 * Two halves fix it:
 *  - `server/index.ts` no longer serves `index.html` for a missing asset (it
 *    404s), and marks `index.html` no-cache so a new build is picked up.
 *  - This module reloads the page once when a route import fails, which fetches
 *    the current `index.html` and the matching chunk hashes.
 *
 * The reload is rate-limited so a genuinely broken deploy lands on the error
 * boundary instead of reloading forever.
 */
import { lazy } from 'react';

const RELOAD_STAMP_KEY = 'nebulis-stale-chunk-reload';
const RELOAD_COOLDOWN_MS = 60_000;

/**
 * Reload once to pick up a newer build. Does nothing when a reload has already
 * happened inside the cooldown window, so a missing chunk that survives the
 * reload is reported rather than retried in a loop.
 */
export function reloadOnceForStaleChunk(): void {
  let lastReload = 0;
  try {
    lastReload = Number(sessionStorage.getItem(RELOAD_STAMP_KEY)) || 0;
  } catch {
    // Without sessionStorage an untracked reload could loop on a broken deploy,
    // so leave recovery to the error boundary's manual reload button.
    return;
  }
  if (Date.now() - lastReload < RELOAD_COOLDOWN_MS) return;
  try {
    sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
}

/**
 * `lazy`, with a failed route import treated as a possible stale build. The
 * error is rethrown after the reload attempt, so a real failure still reaches
 * the error boundary.
 *
 * The factory and return types are derived from React's own `lazy` rather than
 * restated, so they stay correct across React versions and do not need the
 * `any` that React's signature itself carries.
 */
export function lazyRoute(factory: Parameters<typeof lazy>[0]): ReturnType<typeof lazy> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      reloadOnceForStaleChunk();
      throw error;
    }),
  );
}
