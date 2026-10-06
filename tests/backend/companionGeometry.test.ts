import { describe, it, expect } from 'vitest';
import { KIND_FOV_DEG, UNKNOWN_FRAME_RADIUS_DEG, MAX_COMPANION_SEP_DEG, frameRadiusDeg, companionKey } from '../../server/lib/companionGeometry';
import { companionsInFrame, companionsOf, hostsOf } from '../../server/lib/companions';
import { FOV_PROFILES } from '../../src/lib/telescopeFov';
import table from '../../server/data/catalog-companions.json';

describe('server FOV table matches the client one', () => {
  it('has the same size for every kind the server knows', () => {
    for (const [kind, fov] of Object.entries(KIND_FOV_DEG)) {
      const client = FOV_PROFILES.find(p => p.id === kind);
      expect(client, `no client FOV profile for ${kind}`).toBeDefined();
      expect(fov).toEqual({ widthDeg: client!.widthDeg, heightDeg: client!.heightDeg });
    }
  });
});

describe('frameRadiusDeg', () => {
  it('is half the short side of the field', () => {
    expect(frameRadiusDeg(['seestar-s50'])).toBeCloseTo(0.365, 3);
    expect(frameRadiusDeg(['seestar-s50-pro'])).toBeCloseTo(0.69, 3);
  });

  it('uses the best telescope that imaged the object', () => {
    expect(frameRadiusDeg(['seestar-s50', 'dwarf-3'])).toBeCloseTo(0.825, 3);
  });

  it('falls back to the narrowest field for rigs with no known optics', () => {
    expect(frameRadiusDeg([])).toBe(UNKNOWN_FRAME_RADIUS_DEG);
    expect(frameRadiusDeg(['asiair', 'other', null, undefined])).toBe(UNKNOWN_FRAME_RADIUS_DEG);
  });

  it('never exceeds what the table stores', () => {
    const widest = Math.max(...Object.values(KIND_FOV_DEG).map(f => Math.min(f.widthDeg, f.heightDeg) / 2));
    expect(widest).toBeLessThanOrEqual(MAX_COMPANION_SEP_DEG);
  });
});

describe('catalog companion table', () => {
  it('pairs M42 with M43 on every telescope', () => {
    expect(companionsInFrame('M42', ['seestar-s50']).map(c => c.id)).toContain('M43');
    expect(companionsInFrame('M42', []).map(c => c.id)).toContain('M43');
  });

  it('only pairs M31 with M32 and M110 on a wide enough field', () => {
    expect(companionsInFrame('M31', ['seestar-s50'])).toEqual([]);
    expect(companionsInFrame('M31', ['dwarf-mini']).map(c => c.id)).toEqual(['M32']); // 0.60 deg radius reaches 0.40 but not 0.61
    expect(companionsInFrame('M31', ['seestar-s50-pro']).map(c => c.id)).toEqual(['M32', 'M110']);
  });

  it('credits the M65 / M66 pair on every telescope', () => {
    expect(companionsInFrame('M65', ['seestar-s50']).map(c => c.id)).toContain('M66');
    expect(companionsInFrame('M66', ['seestar-s50']).map(c => c.id)).toContain('M65');
  });

  it('never lists an alias of the same object as its companion', () => {
    // Sh2-281 and NGC1976 are M42 under other names; Sh2-45 is M17.
    const m42 = companionsOf('M42').map(c => c.id);
    expect(m42).not.toContain('SH2-281');
    expect(m42).not.toContain('NGC1976');
    expect(companionsOf('M17').map(c => c.id)).not.toContain('SH2-45');
  });

  it('never lists a host as its own companion, and keeps every distance within the cutoff', () => {
    for (const [host, members] of Object.entries((table as { pairs: Record<string, Array<[string, number]>> }).pairs)) {
      for (const [member, sep] of members) {
        expect(member).not.toBe(host);
        expect(sep).toBeGreaterThanOrEqual(0);
        expect(sep).toBeLessThanOrEqual(MAX_COMPANION_SEP_DEG);
      }
    }
  });

  it('is symmetric between two board objects, with the same distance', () => {
    const m32 = hostsOf('M31').find(h => h.hostId === 'M32');
    const m31 = hostsOf('M32').find(h => h.hostId === 'M31');
    expect(m32?.sepDeg).toBe(0.4);
    expect(m31?.sepDeg).toBe(0.4);
  });

  it('keys by the canonical id, whatever spelling the caller has', () => {
    expect(companionKey('m 42')).toBe('M42');
    expect(companionKey('SH2-281')).toBe('M42');
  });

  it('has the Sharpless positions in the right place (degrees, not hours)', () => {
    // A bare Sharpless RA is decimal degrees. Read as hours, Sh2-282 landed 15x too far east
    // and had no neighbours; it must sit next to Sh2-283.
    expect(companionsOf('SH2-282').map(c => c.id)).toContain('SH2-283');
  });
});
