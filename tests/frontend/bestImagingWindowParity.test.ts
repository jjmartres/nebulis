import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  computeBestImagingWindow as clientCompute,
  isUpTonight as clientIsUpTonight,
} from '../../src/lib/bestImagingWindow';
import {
  computeBestImagingWindow as serverCompute,
  isUpTonight as serverIsUpTonight,
} from '../../server/lib/bestImagingWindow';

/**
 * Cross-implementation parity test.
 *
 * server/lib/bestImagingWindow.ts's header comment calls itself a "Server-side
 * port of src/lib/bestImagingWindow.ts", used so native clients (iOS, Android)
 * get the same answer the browser computes locally. Unlike altAz (which has
 * tests/frontend/altaz.test.ts pinning client and server to the same output),
 * these two had no cross-check at all before this file: each only had its own
 * independent unit test, so the two copies could silently diverge (different
 * windowStart/windowEnd, a different peak month) and nothing would fail.
 *
 * The client has no way to inject "now" (it always reads `new Date()`), so we
 * pin the clock with fake timers and pass the same instant to the server call.
 */
const REFERENCE_DATE = new Date('2025-06-21T12:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

function comparableMonths(months: { label: string; maxAlt: number; aboveMinAlt: boolean }[]) {
  // Drop the client-only `date` field; compare only what both sides expose.
  return months.map(({ label, maxAlt, aboveMinAlt }) => ({ label, maxAlt, aboveMinAlt }));
}

describe('computeBestImagingWindow client port matches server implementation', () => {
  it('agrees on a hand-picked set of canonical target/observer pairs', () => {
    const cases = [
      { ra: 5.58, dec: -5.39, lat: 40.7128, lon: -74.006, minAlt: 20 },  // M42, NYC
      { ra: 0.71, dec: 41.27, lat: 51.5074, lon: -0.1278, minAlt: 20 }, // M31, London
      { ra: 12, dec: -30, lat: -33.8688, lon: 151.2093, minAlt: 20 },   // Sydney, southern target
      { ra: 18, dec: 60, lat: 64.1466, lon: -21.9426, minAlt: 30 },     // high-latitude Reykjavik
      { ra: 23.99, dec: -89.9, lat: -89, lon: 179, minAlt: 20 },        // extreme south pole target
      { ra: 6, dec: 89, lat: 40.7128, lon: -74.006, minAlt: 20 },       // near-circumpolar
    ];

    for (const { ra, dec, lat, lon, minAlt } of cases) {
      vi.useFakeTimers();
      vi.setSystemTime(REFERENCE_DATE);
      const client = clientCompute(ra, dec, lat, lon, minAlt);
      vi.useRealTimers();

      const server = serverCompute(ra, dec, lat, lon, minAlt, REFERENCE_DATE);

      expect(comparableMonths(client.months)).toEqual(comparableMonths(server.months));
      expect(client.windowStart).toBe(server.windowStart);
      expect(client.windowEnd).toBe(server.windowEnd);
      expect(client.everVisible).toBe(server.everVisible);
    }
  });

  it('agrees at a different reference instant, so the parity is not an artifact of one fixed date', () => {
    const other = new Date('2025-12-01T00:00:00Z');
    const ra = 5.58, dec = -5.39, lat = 40.7128, lon = -74.006, minAlt = 20;

    vi.useFakeTimers();
    vi.setSystemTime(other);
    const client = clientCompute(ra, dec, lat, lon, minAlt);
    vi.useRealTimers();

    const server = serverCompute(ra, dec, lat, lon, minAlt, other);

    expect(comparableMonths(client.months)).toEqual(comparableMonths(server.months));
    expect(client.windowStart).toBe(server.windowStart);
    expect(client.windowEnd).toBe(server.windowEnd);
  });
});

describe('isUpTonight client port matches server implementation', () => {
  // Both sides anchor "tonight" on the local wall clock with a 07:00 rollover
  // (plannerToday() in src/lib/nightWindow.ts; a matching anchor in
  // server/lib/bestImagingWindow.ts) rather than on `now`'s own calendar day.
  // A previous version of the server port skipped that rollover entirely, so
  // a call placed between midnight and 07:00 asked about the *next* evening's
  // window instead of the one still running, and could answer differently
  // than the client for the same instant. This target/night genuinely flips
  // across that boundary (confirmed by direct search), so it actually
  // exercises the bug rather than happening to agree either way.
  const RA = 10.6, DEC = 15, LAT = 40.7128, LON = -74.006, MIN_ALT = 60;

  it('agrees for a call in the early hours, still inside the previous evening\'s window', () => {
    const at2am = new Date(2025, 10, 22, 2, 0, 0); // Nov 22, 02:00 local
    expect(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, at2am))
      .toBe(serverIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, at2am));
  });

  it('agrees right at the 07:00 rollover boundary, on both sides of it', () => {
    const justBefore = new Date(2025, 10, 22, 6, 59, 0);
    const justAfter = new Date(2025, 10, 22, 7, 0, 0);

    expect(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justBefore))
      .toBe(serverIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justBefore));
    expect(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justAfter))
      .toBe(serverIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justAfter));
    // And the rollover actually changes the answer for this fixture, so the
    // test above is not vacuously true.
    expect(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justBefore))
      .not.toBe(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, justAfter));
  });

  it('agrees during the evening, well away from the rollover', () => {
    const evening = new Date(2025, 10, 21, 20, 0, 0);
    expect(clientIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, evening))
      .toBe(serverIsUpTonight(RA, DEC, LAT, LON, MIN_ALT, evening));
  });
});
