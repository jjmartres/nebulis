/**
 * Static-asset detection for the production SPA fallback
 * (server/lib/staticAssets.ts).
 *
 * The rule decides whether an unmatched GET gets index.html (a client route) or
 * a 404 (a file). Getting it wrong in the permissive direction is the bug this
 * guards: a missing route chunk answered with the HTML shell makes the browser
 * report "Importing a module script failed" instead of a 404.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeAssetRequest } from '../../server/lib/staticAssets.js';

describe('looksLikeAssetRequest', () => {
  it('treats every client-side route as a route, not a file', () => {
    // Every path in src/App.tsx, including the parameterised ones.
    const routes = [
      '/',
      '/planner',
      '/settings',
      '/calibrations',
      '/catalogs',
      '/catalogs/messier',
      '/forecast',
      '/help',
      '/image-gallery',
      '/link',
      '/object/M31',
      '/object/NGC7000/compare',
      '/observations',
      '/observations/M31/2026-01-04',
      '/observations/new',
      '/storage',
      '/wishlist',
      '/backup',
    ];
    for (const route of routes) {
      expect(looksLikeAssetRequest(route), route).toBe(false);
    }
  });

  it('treats Vite chunk requests as files, whether or not the chunk exists', () => {
    expect(looksLikeAssetRequest('/assets/PlannerPage-Bf3itHA6.js')).toBe(true);
    expect(looksLikeAssetRequest('/assets/index-abc123.css')).toBe(true);
    // The stale-chunk case: a hash from a build the server no longer has. The
    // path still has to be recognised as a file so it 404s instead of being
    // answered with the HTML shell.
    expect(looksLikeAssetRequest('/assets/PlannerPage-GONE.js')).toBe(true);
  });

  it('treats referenced media and metadata by extension as files', () => {
    for (const file of [
      '/favicon.ico',
      '/nebulis-64.png',
      '/space-carina.webp',
      '/screenshots/library.png',
      '/screenshots/mobile/ios-tour.webm',
      '/bmc-button.png',
      '/some/font.woff2',
      '/robots.txt',
      '/sitemap.xml',
      '/data.json',
    ]) {
      expect(looksLikeAssetRequest(file), file).toBe(true);
    }
  });

  it('only matches a known extension at the end of the path', () => {
    // A dot inside a path segment is not a file extension.
    expect(looksLikeAssetRequest('/object/M.31')).toBe(false);
    // A trailing numeric segment is not one either.
    expect(looksLikeAssetRequest('/catalogs/messier.2')).toBe(false);
  });
});
