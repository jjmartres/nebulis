import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  filterRecommendations,
  isFilterRecommendationKey,
  FILTER_RECOMMENDATION_KEYS,
  DEFAULT_FILTER_RECOMMENDATION,
  type FilterRecommendation,
} from '../../src/lib/filterRecommendations';

/** Every type string the shipped catalogs actually carry (openngc.json and
 *  catalog-curated.json, plus the two catch-all labels). The rule table is
 *  written against this vocabulary, so a new type that resolves to nothing
 *  sensible should show up here first. */
const CATALOG_TYPES = [
  'Cluster + Nebula',
  'Dark Nebula',
  'Double Star',
  'Emission Nebula',
  'Emission/Reflection Nebula',
  'Galaxy',
  'Galaxy Group',
  'Galaxy Pair',
  'Galaxy Triplet',
  'Globular Cluster',
  'Irregular Galaxy',
  'Lenticular Galaxy',
  'Nebula',
  'Open Cluster',
  'Other',
  'Planetary Nebula',
  'Reflection Nebula',
  'Spiral Galaxy',
  'Star Cloud',
  'Starburst Galaxy',
  'Supernova Remnant',
  'Unknown',
];

function expectRecommendation(r: FilterRecommendation, color: string, mono: string) {
  expect(r).toEqual({ color, mono });
}

// ─── Emission nebulae ──────────────────────────────────────────────────────

describe('filterRecommendations — emission nebulae', () => {
  it('recommends Ha/dual and SHO for "Emission Nebula"', () => {
    expectRecommendation(filterRecommendations('Emission Nebula'), 'ha-dual', 'sho');
  });

  it('is case-insensitive', () => {
    expect(filterRecommendations('EMISSION NEBULA').color).toBe('ha-dual');
  });

  it('ignores surrounding whitespace', () => {
    expectRecommendation(filterRecommendations('  Emission Nebula  '), 'ha-dual', 'sho');
  });
});

// ─── Emission/reflection hybrids ──────────────────────────────────────────

describe('filterRecommendations — emission/reflection hybrids', () => {
  it('recommends Ha/dual and Ha+OIII for "Emission/Reflection Nebula"', () => {
    expectRecommendation(filterRecommendations('Emission/Reflection Nebula'), 'ha-dual', 'ha-oiii');
  });

  it('matches even when the words appear in either order', () => {
    expectRecommendation(filterRecommendations('Reflection/Emission Nebula'), 'ha-dual', 'ha-oiii');
  });
});

// ─── Reflection nebulae ───────────────────────────────────────────────────

describe('filterRecommendations — reflection nebulae', () => {
  it('recommends broadband for a pure "Reflection Nebula"', () => {
    expectRecommendation(filterRecommendations('Reflection Nebula'), 'no-filter-lrgb', 'lrgb');
  });
});

// ─── Planetary nebulae ────────────────────────────────────────────────────

describe('filterRecommendations — planetary nebulae', () => {
  it('recommends Ha/dual and OIII+Ha for "Planetary Nebula"', () => {
    expectRecommendation(filterRecommendations('Planetary Nebula'), 'ha-dual', 'oiii-ha');
  });
});

// ─── Supernova remnants ───────────────────────────────────────────────────

describe('filterRecommendations — supernova remnants', () => {
  it('recommends Ha/dual and SHO for "Supernova Remnant"', () => {
    expectRecommendation(filterRecommendations('Supernova Remnant'), 'ha-dual', 'sho');
  });
});

// ─── Dark nebulae ─────────────────────────────────────────────────────────

describe('filterRecommendations — dark nebulae', () => {
  // A dark nebula has no emission lines of its own: it is read as a silhouette
  // against a rich star field, so broadband is the correct answer and a
  // narrowband filter would discard the very stars the silhouette is defined by.
  it('recommends broadband LRGB for "Dark Nebula"', () => {
    expectRecommendation(filterRecommendations('Dark Nebula'), 'no-filter-lrgb', 'lrgb');
  });

  it('does not recommend a narrowband filter', () => {
    const r = filterRecommendations('Dark Nebula');
    expect(r.color).not.toBe('ha-dual');
    expect(r.mono).not.toBe('ha-oiii');
    expect(r.mono).not.toBe('sho');
  });

  it('matches a dark nebula described by another name (e.g. "Dark Cloud")', () => {
    expectRecommendation(filterRecommendations('Dark Cloud'), 'no-filter-lrgb', 'lrgb');
  });
});

// ─── Generic nebulae ──────────────────────────────────────────────────────

describe('filterRecommendations — generic nebula', () => {
  it('recommends narrowband for a plain "Nebula" type', () => {
    expectRecommendation(filterRecommendations('Nebula'), 'ha-dual', 'ha-oiii');
  });
});

// ─── Clusters ─────────────────────────────────────────────────────────────

describe('filterRecommendations — clusters', () => {
  it('recommends broadband for "Open Cluster"', () => {
    expectRecommendation(filterRecommendations('Open Cluster'), 'no-filter-lrgb', 'lrgb');
  });

  it('recommends broadband for "Globular Cluster"', () => {
    expectRecommendation(filterRecommendations('Globular Cluster'), 'no-filter-lrgb', 'lrgb');
  });

  it('recommends narrowband for "Cluster + Nebula"', () => {
    expectRecommendation(filterRecommendations('Cluster + Nebula'), 'ha-dual', 'sho');
  });
});

// ─── Galaxies ─────────────────────────────────────────────────────────────

describe('filterRecommendations — galaxies', () => {
  it('recommends broadband LRGB / luminance for "Galaxy"', () => {
    expectRecommendation(filterRecommendations('Galaxy'), 'no-filter-lrgb', 'luminance');
  });

  it.each([
    'Spiral Galaxy',
    'Barred Spiral Galaxy',
    'Irregular Galaxy',
    'Lenticular Galaxy',
    'Starburst Galaxy',
    'Galaxy Group',
    'Galaxy Pair',
    'Galaxy Triplet',
  ])('matches the galaxy sub-type "%s"', (type) => {
    expectRecommendation(filterRecommendations(type), 'no-filter-lrgb', 'luminance');
  });
});

// ─── Star clouds ──────────────────────────────────────────────────────────

describe('filterRecommendations — star clouds', () => {
  it('recommends broadband for "Star Cloud"', () => {
    expectRecommendation(filterRecommendations('Star Cloud'), 'no-filter-lrgb', 'lrgb');
  });
});

// ─── Double stars ─────────────────────────────────────────────────────────

describe('filterRecommendations — double stars', () => {
  it('recommends no filter for "Double Star"', () => {
    expectRecommendation(filterRecommendations('Double Star'), 'no-filter', 'no-filter');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('filterRecommendations — edge cases', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns the broadband default for %s', (_label, value) => {
    expectRecommendation(filterRecommendations(value), 'no-filter-lrgb', 'lrgb');
  });

  it.each(['Other', 'Unknown', 'not a real type'])(
    'returns the broadband default for the unrecognised type "%s"',
    (type) => {
      expectRecommendation(filterRecommendations(type), 'no-filter-lrgb', 'lrgb');
      expect(filterRecommendations(type)).toEqual(DEFAULT_FILTER_RECOMMENDATION);
    },
  );

  it('never returns a key outside FILTER_RECOMMENDATION_KEYS, for any catalog type', () => {
    const valid = new Set<string>(FILTER_RECOMMENDATION_KEYS);
    for (const type of CATALOG_TYPES) {
      const r = filterRecommendations(type);
      expect(valid.has(r.color), `${type} → color ${r.color}`).toBe(true);
      expect(valid.has(r.mono), `${type} → mono ${r.mono}`).toBe(true);
    }
  });

  it('returns a fresh object callers cannot mutate into the shared default', () => {
    const r = filterRecommendations('Other');
    expect(r).not.toBe(DEFAULT_FILTER_RECOMMENDATION);
  });
});

// ─── isFilterRecommendationKey ────────────────────────────────────────────

describe('isFilterRecommendationKey', () => {
  it.each([...FILTER_RECOMMENDATION_KEYS])('accepts the known key "%s"', (key) => {
    expect(isFilterRecommendationKey(key)).toBe(true);
  });

  it.each([
    ['an unknown string', 'ha-sii'],
    ['a number', 3],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a key of the wrong case', 'HA-DUAL'],
  ])('rejects %s', (_label, value) => {
    expect(isFilterRecommendationKey(value)).toBe(false);
  });
});

// ─── Locale coverage ──────────────────────────────────────────────────────

describe('filterRecommendations — locale coverage', () => {
  const LANGS = ['en', 'de', 'fr', 'es'] as const;
  const LOCALES_DIR = path.join(__dirname, '..', '..', 'src', 'locales');

  function readFilterGroup(lang: string): Record<string, unknown> {
    const file = path.join(LOCALES_DIR, lang, 'catalogs.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      filterRecommendations?: Record<string, unknown>;
    };
    if (!json.filterRecommendations) throw new Error(`${lang}/catalogs.json has no filterRecommendations group`);
    return json.filterRecommendations;
  }

  function leafPaths(obj: unknown, prefix = ''): string[] {
    if (obj === null || typeof obj !== 'object') return [prefix];
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }

  function leafValues(obj: unknown): string[] {
    if (typeof obj === 'string') return [obj];
    if (obj === null || typeof obj !== 'object') return [];
    return Object.values(obj as Record<string, unknown>).flatMap(leafValues);
  }

  it.each([...LANGS])('%s defines a label, a short label and a rationale for every recommendation key', (lang) => {
    const group = readFilterGroup(lang) as {
      keys?: Record<string, { label?: unknown; short?: unknown; rationale?: unknown }>;
    };
    for (const key of FILTER_RECOMMENDATION_KEYS) {
      const entry = group.keys?.[key];
      expect(entry, `${lang}: missing keys.${key}`).toBeDefined();
      for (const field of ['label', 'short', 'rationale'] as const) {
        expect(typeof entry?.[field], `${lang}: keys.${key}.${field}`).toBe('string');
        expect(String(entry?.[field]).length, `${lang}: keys.${key}.${field} is empty`).toBeGreaterThan(0);
      }
      // The compact chip in the Planner row depends on `short` really being
      // shorter than the full label.
      expect(String(entry?.short).length, `${lang}: keys.${key}.short is longer than label`)
        .toBeLessThanOrEqual(String(entry?.label).length);
    }
  });

  it.each([...LANGS])('%s defines the unknown-key fallback the panel renders', (lang) => {
    const group = readFilterGroup(lang) as {
      unknown?: { label?: unknown; short?: unknown; rationale?: unknown };
    };
    for (const field of ['label', 'short', 'rationale'] as const) {
      expect(typeof group.unknown?.[field], `${lang}: unknown.${field}`).toBe('string');
    }
  });

  it('every locale carries the exact same set of filter recommendation keys', () => {
    const reference = leafPaths(readFilterGroup('en')).sort();
    for (const lang of LANGS) {
      expect(leafPaths(readFilterGroup(lang)).sort(), `${lang} key set differs from en`).toEqual(reference);
    }
  });

  it('does not use an em dash in any user-visible filter string', () => {
    // The repo's writing style bans "—" in copy. Guard the group here so a
    // translated rationale cannot reintroduce one.
    for (const lang of LANGS) {
      for (const value of leafValues(readFilterGroup(lang))) {
        expect(value.includes('—'), `${lang}: em dash in "${value}"`).toBe(false);
      }
    }
  });
});
