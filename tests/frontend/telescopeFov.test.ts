import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  arcsecPerPixel,
  classifyFit,
  fovFromOptics,
  resolveFov,
  readFovSetup,
  writeFovSetup,
  telescopeProfileOptionId,
  CUSTOM_FOV_PROFILE_ID,
  DEFAULT_CUSTOM_OPTICS,
  type FovSetup,
  type TelescopeProfileLike,
  type OpticalConfigLike,
} from '../../src/lib/telescopeFov';

let configCounter = 0;
function makeConfig(overrides: Partial<OpticalConfigLike> & Pick<OpticalConfigLike, 'name' | 'focalLengthMm' | 'sensorWidthMm' | 'sensorHeightMm'>): OpticalConfigLike {
  return { id: `cfg-${++configCounter}`, pixelSizeUm: null, ...overrides };
}

function makeTelescope(overrides: Partial<TelescopeProfileLike> & Pick<TelescopeProfileLike, 'id' | 'name' | 'kind'>): TelescopeProfileLike {
  return {
    archivedAt: null,
    opticalConfigs: [],
    activeOpticalConfigId: null,
    ...overrides,
  };
}

describe('fovFromOptics', () => {
  it('derives FOV in degrees from focal length and sensor dimensions', () => {
    // A 250mm scope with a 5.6mm x 3.2mm sensor — roughly a SeeStar S50-ish rig.
    const { widthDeg, heightDeg } = fovFromOptics(250, 5.6, 3.2);
    expect(widthDeg).toBeCloseTo(1.283, 2);
    expect(heightDeg).toBeCloseTo(0.733, 2);
  });
});

describe('arcsecPerPixel', () => {
  it('computes plate scale from focal length and pixel pitch', () => {
    // 250mm focal length, 3.76µm pixels (a common ZWO pitch).
    expect(arcsecPerPixel(250, 3.76)).toBeCloseTo(3.098, 2);
  });

  it('returns 0 for non-positive inputs rather than NaN/Infinity', () => {
    expect(arcsecPerPixel(0, 3.76)).toBe(0);
    expect(arcsecPerPixel(250, 0)).toBe(0);
    expect(arcsecPerPixel(-5, 3.76)).toBe(0);
  });
});

describe('classifyFit', () => {
  const fov = { widthDeg: 1.28, heightDeg: 0.73 }; // SeeStar S50-ish

  it('returns null when the object angular size is unknown', () => {
    expect(classifyFit(fov, null)).toBeNull();
  });

  it('tags a small object as tiny', () => {
    const result = classifyFit(fov, { widthArcmin: 2, heightArcmin: 2 });
    expect(result?.tag).toBe('tiny');
  });

  it('tags a comfortably-sized object as fits', () => {
    const result = classifyFit(fov, { widthArcmin: 20, heightArcmin: 15 });
    expect(result?.tag).toBe('fits');
  });

  it('tags an object filling most of the frame as tight', () => {
    // Frame height is 0.73° = 43.8′; 90% of that fills the limiting axis.
    const result = classifyFit(fov, { widthArcmin: 30, heightArcmin: 40 });
    expect(result?.tag).toBe('tight');
  });

  it('tags an object larger than the frame as needing a mosaic', () => {
    const result = classifyFit(fov, { widthArcmin: 200, heightArcmin: 100 });
    expect(result?.tag).toBe('mosaic');
    expect(result?.label).toMatch(/mosaic/i);
  });
});

/**
 * The suite runs in Vitest's default `node` environment (this repo's
 * `environmentMatchGlobs: [['tests/frontend/**', 'jsdom']]` config option
 * isn't honored by the installed Vitest version, so no test file here
 * actually gets a DOM — pre-existing, unrelated to this feature). `readFovSetup`/
 * `writeFovSetup` guard on `typeof window === 'undefined'`, so exercising the
 * localStorage-backed path needs a minimal `window` + `localStorage` stub.
 */
function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

describe('FOV setup persistence', () => {
  beforeEach(() => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to following the owned telescope when nothing is saved', () => {
    const setup = readFovSetup();
    expect(setup.profileId).toBeNull();
    expect(setup.custom).toEqual(DEFAULT_CUSTOM_OPTICS);
  });

  it('round-trips a saved setup through localStorage', () => {
    const setup: FovSetup = {
      profileId: CUSTOM_FOV_PROFILE_ID,
      custom: { focalMm: 400, sensorWMm: 23.5, sensorHMm: 15.7, pixelSizeUm: 3.76 },
    };
    writeFovSetup(setup);
    expect(readFovSetup()).toEqual(setup);
  });

  it('ignores corrupted storage and falls back to defaults', () => {
    localStorage.setItem('nebulis-fov-setup', '{not json');
    expect(readFovSetup()).toEqual({ profileId: null, custom: DEFAULT_CUSTOM_OPTICS });
  });
});

describe('resolveFov', () => {
  const noPick: FovSetup = { profileId: null, custom: DEFAULT_CUSTOM_OPTICS };

  it('resolves the active telescope to its known FOV_PROFILES entry when it carries no custom optics', () => {
    const seestar = makeTelescope({ id: 't1', name: 'My Backyard Scope', kind: 'seestar-s30' });
    const resolved = resolveFov(noPick, [seestar]);
    expect(resolved.label).toBe('My Backyard Scope');
    expect(resolved.widthDeg).toBeCloseTo(2.14, 2); // ZWO SeeStar S30's known field
    expect(resolved.arcsecPerPixel).toBeNull();
    expect(resolved.profileId).toBe(telescopeProfileOptionId('t1'));
  });

  it('resolves an unsupported-kind telescope from its one saved optical config', () => {
    const config = makeConfig({ name: 'Native', focalLengthMm: 400, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76 });
    const rig = makeTelescope({ id: 't2', name: 'ZWO + Askar', kind: 'other', opticalConfigs: [config] });
    const resolved = resolveFov(noPick, [rig]);
    expect(resolved.label).toBe('ZWO + Askar — Native');
    const expected = fovFromOptics(400, 23.5, 15.7);
    expect(resolved.widthDeg).toBeCloseTo(expected.widthDeg, 5);
    expect(resolved.arcsecPerPixel).toBeCloseTo(arcsecPerPixel(400, 3.76), 5);
    expect(resolved.profileId).toBe(telescopeProfileOptionId('t2', config.id));
  });

  it('ignores optical configs on a known smart-telescope kind (leftover from an earlier kind switch)', () => {
    const stale = makeConfig({ name: 'Leftover', focalLengthMm: 999, sensorWidthMm: 999, sensorHeightMm: 999 });
    const seestar = makeTelescope({ id: 't3', name: 'Relabeled Scope', kind: 'seestar-s50', opticalConfigs: [stale] });
    const resolved = resolveFov(noPick, [seestar]);
    expect(resolved.widthDeg).toBeCloseTo(1.28, 2); // the real SeeStar S50 field, not the stale 999mm config
    expect(resolved.label).toBe('Relabeled Scope'); // no " — Leftover" suffix — the config was never used
  });

  it('falls back to an unsupported-kind telescope with no configs saved as a generic default', () => {
    const rig = makeTelescope({ id: 't4', name: 'Bare rig', kind: 'other' });
    const resolved = resolveFov(noPick, [rig]);
    expect(resolved.label).toBe('Bare rig');
    expect(resolved.widthDeg).toBeCloseTo(1.28, 2); // DEFAULT_FOV_PROFILE_ID's field
  });

  it('uses the profile\'s activeOpticalConfigId over the oldest config when both exist', () => {
    const native = makeConfig({ name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const reducer = makeConfig({ name: '0.8x Reducer', focalLengthMm: 1600, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const rig = makeTelescope({
      id: 't2b', name: 'ZWO + Askar', kind: 'asiair',
      opticalConfigs: [native, reducer], activeOpticalConfigId: reducer.id,
    });
    const resolved = resolveFov(noPick, [rig]);
    expect(resolved.label).toBe('ZWO + Askar — 0.8x Reducer');
    expect(resolved.widthDeg).toBeCloseTo(fovFromOptics(1600, 23.5, 15.7).widthDeg, 5);
  });

  it('falls back to the oldest config when activeOpticalConfigId is unset', () => {
    const native = makeConfig({ name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const reducer = makeConfig({ name: '0.8x Reducer', focalLengthMm: 1600, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const rig = makeTelescope({ id: 't2c', name: 'ZWO + Askar', kind: 'asiair', opticalConfigs: [native, reducer] });
    const resolved = resolveFov(noPick, [rig]);
    expect(resolved.label).toBe('ZWO + Askar — Native');
  });

  it('resolves an explicit telescope:<id>:<configId> pick, overriding the active config', () => {
    const native = makeConfig({ name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const reducer = makeConfig({ name: '0.8x Reducer', focalLengthMm: 1600, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const rig = makeTelescope({
      id: 't2d', name: 'ZWO + Askar', kind: 'other',
      opticalConfigs: [native, reducer], activeOpticalConfigId: native.id,
    });
    const setup: FovSetup = { profileId: telescopeProfileOptionId('t2d', reducer.id), custom: DEFAULT_CUSTOM_OPTICS };
    const resolved = resolveFov(setup, [rig]);
    expect(resolved.label).toBe('ZWO + Askar — 0.8x Reducer');
    expect(resolved.widthDeg).toBeCloseTo(fovFromOptics(1600, 23.5, 15.7).widthDeg, 5);
  });

  it('falls back to the active config when a picked configId no longer exists on the telescope', () => {
    const native = makeConfig({ name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const rig = makeTelescope({ id: 't2e', name: 'ZWO + Askar', kind: 'other', opticalConfigs: [native], activeOpticalConfigId: native.id });
    const setup: FovSetup = { profileId: telescopeProfileOptionId('t2e', 'deleted-config-id'), custom: DEFAULT_CUSTOM_OPTICS };
    const resolved = resolveFov(setup, [rig]);
    expect(resolved.label).toBe('ZWO + Askar — Native');
  });

  it('prefers the first non-archived telescope over an archived one', () => {
    const archived = makeTelescope({ id: 't5', name: 'Retired', kind: 'seestar-s30', archivedAt: 1700000000000 });
    const active = makeTelescope({ id: 't6', name: 'Current', kind: 'dwarf-3' });
    const resolved = resolveFov(noPick, [archived, active]);
    expect(resolved.label).toBe('Current');
  });

  it('resolves an explicit telescope: pick over the active telescope default', () => {
    const active = makeTelescope({ id: 't7', name: 'Active Scope', kind: 'seestar-s30' });
    const config = makeConfig({ name: 'Native', focalLengthMm: 250, sensorWidthMm: 5.6, sensorHeightMm: 3.2, pixelSizeUm: 3.76 });
    const other = makeTelescope({ id: 't8', name: 'Picked Rig', kind: 'other', opticalConfigs: [config] });
    const setup: FovSetup = { profileId: telescopeProfileOptionId('t8'), custom: DEFAULT_CUSTOM_OPTICS };
    const resolved = resolveFov(setup, [active, other]);
    expect(resolved.label).toBe('Picked Rig — Native');
    expect(resolved.arcsecPerPixel).toBeCloseTo(arcsecPerPixel(250, 3.76), 5);
  });

  it('falls through to the active-telescope default when a saved telescope: pick no longer exists', () => {
    const active = makeTelescope({ id: 't9', name: 'Still Here', kind: 'seestar-s30' });
    const setup: FovSetup = { profileId: telescopeProfileOptionId('deleted-id'), custom: DEFAULT_CUSTOM_OPTICS };
    const resolved = resolveFov(setup, [active]);
    expect(resolved.label).toBe('Still Here');
  });

  it('resolves a built-in FOV_PROFILES id pick regardless of registered telescopes', () => {
    const setup: FovSetup = { profileId: 'dwarf-2', custom: DEFAULT_CUSTOM_OPTICS };
    const resolved = resolveFov(setup, []);
    expect(resolved.label).toBe('DwarfLab Dwarf II');
    expect(resolved.arcsecPerPixel).toBeNull();
  });

  it('resolves the ad-hoc Custom pick from focal length + sensor, with a plate scale when pixel size is set', () => {
    const setup: FovSetup = {
      profileId: CUSTOM_FOV_PROFILE_ID,
      custom: { focalMm: 250, sensorWMm: 5.6, sensorHMm: 3.2, pixelSizeUm: 3.76 },
    };
    const resolved = resolveFov(setup, null);
    expect(resolved.label).toBe('Custom');
    expect(resolved.widthDeg).toBeCloseTo(1.283, 2);
    expect(resolved.arcsecPerPixel).toBeCloseTo(3.098, 2);
  });

  it('omits the plate scale when no pixel size was entered', () => {
    const setup: FovSetup = {
      profileId: CUSTOM_FOV_PROFILE_ID,
      custom: { focalMm: 250, sensorWMm: 5.6, sensorHMm: 3.2, pixelSizeUm: null },
    };
    const resolved = resolveFov(setup, null);
    expect(resolved.arcsecPerPixel).toBeNull();
  });

  it('falls back to the generic default when no telescopes are registered at all', () => {
    const resolved = resolveFov(noPick, []);
    expect(resolved.label).toBe('ZWO SeeStar S50');
  });
});
