import { describe, it, expect } from 'vitest';
import { altAz } from '../../server/lib/astroCalc';
import {
  checkBlockVisibility,
  objectEverVisible,
  cellIndex,
  SKY_MAP_AZ_SLICES,
  SKY_MAP_BANDS,
  SKY_MAP_CELLS,
} from '../../server/lib/visibilityCheck';

// Nothing in this file existed before: checkBlockVisibility (the Planner's
// per-block traffic-light verdict) and objectEverVisible (autoPlan's
// scheduling gate) had zero direct tests, on either the server port or the
// browser copy it must match exactly (see the header comment in
// server/lib/visibilityCheck.ts).

const REFERENCE_DATE = new Date('2025-06-21T03:14:15Z');
const LAT = 40.7128;
const LON = -74.006;

function allTrueMap(): boolean[] {
  return Array(SKY_MAP_CELLS).fill(true);
}
function allFalseMap(): boolean[] {
  return Array(SKY_MAP_CELLS).fill(false);
}

/** The cell a real alt/az position falls into, using the same 10°x10° grid
 *  checkBlockVisibility uses internally (locateCell is not exported). */
function cellFor(ra: number, dec: number, lat: number, lon: number, when: Date) {
  const { alt, az } = altAz(ra, dec, lat, lon, when);
  const azNorm = ((az % 360) + 360) % 360;
  return {
    alt,
    az,
    azSlice: Math.min(SKY_MAP_AZ_SLICES - 1, Math.floor(azNorm / (360 / SKY_MAP_AZ_SLICES))),
    band: Math.min(SKY_MAP_BANDS - 1, Math.floor(alt / (80 / SKY_MAP_BANDS))),
  };
}

describe('cellIndex', () => {
  it('lays cells out az-major, band-minor', () => {
    expect(cellIndex(0, 0)).toBe(0);
    expect(cellIndex(0, 1)).toBe(1);
    expect(cellIndex(1, 0)).toBe(SKY_MAP_BANDS);
    expect(cellIndex(SKY_MAP_AZ_SLICES - 1, SKY_MAP_BANDS - 1)).toBe(SKY_MAP_CELLS - 1);
  });
});

describe('checkBlockVisibility — no sky map configured', () => {
  it('reports everything visible when no map has been set, even for an object that never clears the horizon', () => {
    // dec chosen so this target sits well below the horizon from LAT/LON for
    // the whole window (confirmed: alt stays around -41° to -43°). A sky
    // mask only restricts what the app can already see above the horizon;
    // it is not a substitute for the caller's own above-horizon scheduling.
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 60 * 60 * 1000);
    const result = checkBlockVisibility(0, -85, LAT, LON, start, end, null, 15);

    expect(result.verdict).toBe('all');
    expect(result.fractionVisible).toBe(1);
    expect(result.firstBlockedAt).toBeNull();
    expect(result.reason).toBe('');
    // minAlt/maxAlt are still the real (negative) altitudes sampled, so a
    // caller cannot mistake this for "confirmed above the horizon."
    expect(result.maxAlt).toBeLessThan(0);
    expect(result.minAlt).toBeLessThan(result.maxAlt);
  });

  it('treats a legacy 144-cell (4-band) map the same as no map at all, rather than erroring or half-applying it', () => {
    const legacyMap = Array(SKY_MAP_AZ_SLICES * 4).fill(false); // old 4-band grid
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 10 * 60 * 1000);
    const result = checkBlockVisibility(12, 40, LAT, LON, start, end, legacyMap, 5);

    expect(result.verdict).toBe('all');
    expect(result.fractionVisible).toBe(1);
  });
});

describe('checkBlockVisibility — with a configured 288-cell sky map', () => {
  const RA = 12;
  const DEC = 40;

  it('is all-visible when the object stays inside its one allowed cell for the whole window', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 10 * 60 * 1000);
    // Confirmed the object sits in the same cell at every 5-minute sample
    // across this window (band 4, azSlice 29).
    const { azSlice, band } = cellFor(RA, DEC, LAT, LON, start);
    const map = allFalseMap();
    map[cellIndex(azSlice, band)] = true;

    const result = checkBlockVisibility(RA, DEC, LAT, LON, start, end, map, 5);
    expect(result.verdict).toBe('all');
    expect(result.fractionVisible).toBe(1);
    expect(result.firstBlockedAt).toBeNull();
  });

  it('goes partial, and names where and when, once the object drifts into a masked cell', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 15 * 60 * 1000);
    // Only the cell the object occupies for the first 10 minutes is allowed;
    // by the 15-minute sample it has drifted down into the band below.
    const { azSlice, band } = cellFor(RA, DEC, LAT, LON, start);
    const map = allFalseMap();
    map[cellIndex(azSlice, band)] = true;

    const result = checkBlockVisibility(RA, DEC, LAT, LON, start, end, map, 5);
    expect(result.verdict).toBe('partial');
    expect(result.fractionVisible).toBe(0.75); // 3 of 4 samples (0/5/10/15 min)
    expect(result.firstBlockedAt).toEqual(new Date(REFERENCE_DATE.getTime() + 15 * 60 * 1000));
    // The reason has to name the direction, the altitude, and the time the
    // block starts: it's the user's only clue why a "partial" verdict fired.
    expect(result.reason).toContain('WNW');
    expect(result.reason).toContain('°) from');
  });

  it('is none, and marks the very first sample, when every cell the object touches is masked', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 10 * 60 * 1000);
    const result = checkBlockVisibility(RA, DEC, LAT, LON, start, end, allFalseMap(), 5);

    expect(result.verdict).toBe('none');
    expect(result.fractionVisible).toBe(0);
    expect(result.firstBlockedAt).toEqual(start);
    expect(result.reason).toContain('from 03:14');
  });

  it('treats the zenith as always visible, even when every cell in the map is masked', () => {
    // ra/dec chosen so the object transits within ~0.05° of the zenith at
    // REFERENCE_DATE from this site (alt ~= 90 regardless of the 80-degree
    // band ceiling the grid otherwise applies).
    const start = REFERENCE_DATE;
    const result = checkBlockVisibility(16.28, LAT, LAT, LON, start, start, allFalseMap(), 5);

    expect(result.verdict).toBe('all');
    expect(result.maxAlt).toBeGreaterThan(80);
  });
});

describe('objectEverVisible', () => {
  const RA = 12;
  const DEC = 40;

  it('is true with no map configured, even for an object that never rises', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 60 * 60 * 1000);
    expect(objectEverVisible(0, -85, LAT, LON, start, end, null, 15)).toBe(true);
  });

  it('is false for an object below the horizon even when a configured map allows every cell', () => {
    // The sky mask only restricts the visible portion of the sky above the
    // horizon; it never manufactures visibility below it.
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 60 * 60 * 1000);
    expect(objectEverVisible(0, -85, LAT, LON, start, end, allTrueMap(), 15)).toBe(false);
  });

  it('is true once the object passes through any allowed cell', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 10 * 60 * 1000);
    const { azSlice, band } = cellFor(RA, DEC, LAT, LON, start);
    const map = allFalseMap();
    map[cellIndex(azSlice, band)] = true;

    expect(objectEverVisible(RA, DEC, LAT, LON, start, end, map, 5)).toBe(true);
  });

  it('is false when the object never passes through an allowed cell', () => {
    const start = REFERENCE_DATE;
    const end = new Date(REFERENCE_DATE.getTime() + 10 * 60 * 1000);
    expect(objectEverVisible(RA, DEC, LAT, LON, start, end, allFalseMap(), 5)).toBe(false);
  });
});
