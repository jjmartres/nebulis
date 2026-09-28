import { describe, it, expect } from 'vitest';
import { compareBy } from '../../src/lib/catalogSort';
import type { CatalogProgressObject } from '../../src/lib/api/catalogs';
import type { FitAssessment, FitTag } from '../../src/lib/telescopeFov';

function makeObject(overrides: Partial<CatalogProgressObject> & Pick<CatalogProgressObject, 'id' | 'name'>): CatalogProgressObject {
  return {
    number: null,
    ngcName: null,
    type: 'Galaxy',
    typeClass: 'galaxy',
    constellation: null,
    magnitude: null,
    majorAxisArcmin: null,
    ra: null,
    dec: null,
    isImaged: false,
    libraryObjectId: null,
    sessionCount: 0,
    ...overrides,
  };
}

function makeFit(tag: FitTag, fillRatio = 0.5): FitAssessment {
  return { tag, short: tag, label: tag, fillRatio };
}

describe('CatalogBoard compareBy — frameFit', () => {
  it('ranks fits < tight < tiny < mosaic', () => {
    const fits = makeObject({ id: 'A', name: 'Fits Object' });
    const tight = makeObject({ id: 'B', name: 'Tight Object' });
    const tiny = makeObject({ id: 'C', name: 'Tiny Object' });
    const mosaic = makeObject({ id: 'D', name: 'Mosaic Object' });

    const fitById = new Map<string, FitAssessment | null>([
      [fits.id, makeFit('fits')],
      [tight.id, makeFit('tight')],
      [tiny.id, makeFit('tiny')],
      [mosaic.id, makeFit('mosaic')],
    ]);

    const sorted = [mosaic, tiny, fits, tight].sort(compareBy('frameFit', fitById));
    expect(sorted.map(o => o.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('sorts objects with no known angular size (null FitAssessment) last', () => {
    const known = makeObject({ id: 'A', name: 'Known' });
    const unknown = makeObject({ id: 'B', name: 'Unknown' });
    const fitById = new Map<string, FitAssessment | null>([
      [known.id, makeFit('mosaic')], // even the worst known tag beats "unknown"
      [unknown.id, null],
    ]);
    const sorted = [unknown, known].sort(compareBy('frameFit', fitById));
    expect(sorted.map(o => o.id)).toEqual(['A', 'B']);
  });

  it('breaks a tie within the same tag by fill ratio ascending', () => {
    const barelyMosaic = makeObject({ id: 'A', name: 'Barely' });
    const wayTooMosaic = makeObject({ id: 'B', name: 'Way Too Big' });
    const fitById = new Map<string, FitAssessment | null>([
      [barelyMosaic.id, makeFit('mosaic', 1.1)],
      [wayTooMosaic.id, makeFit('mosaic', 4.0)],
    ]);
    const sorted = [wayTooMosaic, barelyMosaic].sort(compareBy('frameFit', fitById));
    expect(sorted.map(o => o.id)).toEqual(['A', 'B']);
  });

  it('falls back to name as a final tie-break when tag and fillRatio match', () => {
    const zebra = makeObject({ id: 'Z', name: 'Zebra Nebula' });
    const alpha = makeObject({ id: 'A', name: 'Alpha Nebula' });
    const fitById = new Map<string, FitAssessment | null>([
      [zebra.id, makeFit('fits', 0.5)],
      [alpha.id, makeFit('fits', 0.5)],
    ]);
    const sorted = [zebra, alpha].sort(compareBy('frameFit', fitById));
    expect(sorted.map(o => o.name)).toEqual(['Alpha Nebula', 'Zebra Nebula']);
  });
});

describe('CatalogBoard compareBy — existing keys still work unchanged', () => {
  const emptyFitById = new Map<string, FitAssessment | null>();

  it('name: locale-compares names', () => {
    const a = makeObject({ id: '1', name: 'Andromeda' });
    const b = makeObject({ id: '2', name: 'Bode\'s' });
    expect([b, a].sort(compareBy('name', emptyFitById)).map(o => o.id)).toEqual(['1', '2']);
  });

  it('magnitude: brightest (lowest number) first, unknown last', () => {
    const bright = makeObject({ id: '1', name: 'Bright', magnitude: 3.4 });
    const dim = makeObject({ id: '2', name: 'Dim', magnitude: 9.1 });
    const unknown = makeObject({ id: '3', name: 'Unknown', magnitude: null });
    const sorted = [unknown, dim, bright].sort(compareBy('magnitude', emptyFitById));
    expect(sorted.map(o => o.id)).toEqual(['1', '2', '3']);
  });

  it('catalog: is a no-op (preserves array order)', () => {
    const a = makeObject({ id: '1', name: 'B' });
    const b = makeObject({ id: '2', name: 'A' });
    expect([a, b].sort(compareBy('catalog', emptyFitById)).map(o => o.id)).toEqual(['1', '2']);
  });
});
