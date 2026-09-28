/**
 * The filter/sort vocabulary of a catalog board.
 *
 * Kept out of CatalogToolbar.tsx so the component file exports only its
 * component (Fast Refresh requirement), and so the `<select>` handler can
 * narrow its raw DOM string through isSortKey instead of asserting it.
 */
import { isOneOf } from './typeGuards';
import { FRAME_FIT_RANK, type FitAssessment } from './telescopeFov';
import type { CatalogProgressObject } from './api/catalogs';

export const STATUS_FILTERS = ['all', 'imaged', 'remaining'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SORT_KEYS = ['catalog', 'name', 'magnitude', 'constellation', 'frameFit'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Narrows the raw string a `<select>` hands back to a SortKey. */
export function isSortKey(v: string): v is SortKey {
  return isOneOf(SORT_KEYS, v);
}

/** Objects with no magnitude sort last rather than ahead of the brightest. */
const NO_MAGNITUDE = Number.POSITIVE_INFINITY;
/** Objects with no known angular size (so no `FitAssessment` at all) sort
 *  last under "Best frame fit", same reasoning as NO_MAGNITUDE above. */
const NO_FIT_RANK = Number.POSITIVE_INFINITY;

/** `fitById` is precomputed once per (catalog, fov) pair in `CatalogBoard` —
 *  every tile shows its `FitAssessment` as a badge regardless of the active
 *  sort, so the "Best frame fit" order is explained rather than a silent
 *  reshuffle; this just reuses that same map for the actual comparison.
 *  Kept in this module (rather than CatalogBoard.tsx) so it's a plain
 *  function export next to the rest of the board's sort vocabulary, not a
 *  non-component export out of a page file. Exported for direct unit testing
 *  (tests/frontend/catalogBoardSort.test.ts) — it's pure, so there's no
 *  reason to only exercise it through a full page render. */
export function compareBy(sort: SortKey, fitById: Map<string, FitAssessment | null>) {
  return (a: CatalogProgressObject, b: CatalogProgressObject): number => {
    switch (sort) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'magnitude':
        return (a.magnitude ?? NO_MAGNITUDE) - (b.magnitude ?? NO_MAGNITUDE);
      case 'constellation':
        return (a.constellation ?? 'zzz').localeCompare(b.constellation ?? 'zzz')
          || (a.number ?? 0) - (b.number ?? 0);
      case 'frameFit': {
        const fa = fitById.get(a.id) ?? null;
        const fb = fitById.get(b.id) ?? null;
        const ra = fa ? FRAME_FIT_RANK[fa.tag] : NO_FIT_RANK;
        const rb = fb ? FRAME_FIT_RANK[fb.tag] : NO_FIT_RANK;
        // Same tag (e.g. both "mosaic")? Break the tie by how extreme the fill
        // ratio is — a barely-too-big mosaic candidate sorts ahead of a
        // wildly-oversized one, and likewise within "fits"/"tight"/"tiny".
        return ra - rb || (fa?.fillRatio ?? 0) - (fb?.fillRatio ?? 0) || a.name.localeCompare(b.name);
      }
      // Catalog order is the order the list already arrives in, so this is a
      // deliberate no-op rather than an unhandled key.
      case 'catalog':
        return 0;
      default: {
        const _exhaustive: never = sort;
        void _exhaustive;
        return 0;
      }
    }
  };
}
