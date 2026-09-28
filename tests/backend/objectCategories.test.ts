import { describe, it, expect } from 'vitest';
import * as client from '../../src/lib/objectCategories';
import * as server from '../../server/lib/objectCategories';
import type { ObjectClass } from '../../src/lib/objectCategories';

/**
 * The catalog's real type vocabulary: all 22 distinct strings across
 * openngc.json, catalog-curated.json and sharpless.json, with how many objects
 * carry each. The mapping is written against this list, so it is pinned here
 * rather than derived, so that adding a type to the catalog shows up as a
 * deliberate decision instead of a silent reclassification.
 */
const EXPECTED_CLASS: Record<string, ObjectClass | null> = {
  'Galaxy': 'galaxy',
  'Galaxy Pair': 'galaxy',
  'Galaxy Triplet': 'galaxy',
  'Galaxy Group': 'galaxy',
  'Spiral Galaxy': 'galaxy',
  'Lenticular Galaxy': 'galaxy',
  'Starburst Galaxy': 'galaxy',
  'Irregular Galaxy': 'galaxy',

  'Nebula': 'nebula',
  'Emission Nebula': 'nebula',
  'Emission/Reflection Nebula': 'nebula',
  'Reflection Nebula': 'nebula',
  'Planetary Nebula': 'nebula',
  'Dark Nebula': 'nebula',
  'Supernova Remnant': 'nebula',
  // Precedence: a hybrid reads as a nebula for single-class callers, because
  // the nebulosity is what it is imaged for. It is in BOTH families for the
  // callers that ask one family at a time (see the test below).
  'Cluster + Nebula': 'nebula',

  'Open Cluster': 'cluster',
  'Globular Cluster': 'cluster',

  // Deliberately unclassified: a star cloud is a Milky Way region rather than a
  // star or a nebula, a double star is neither, and these are the two catch-alls.
  'Star Cloud': null,
  'Double Star': null,
  'Unknown': null,
  'Other': null,
};

const TYPES = Object.keys(EXPECTED_CLASS);

// ─── The two copies must agree ─────────────────────────────────────────────

describe('objectCategories — client/server parity', () => {
  // The client and server build roots cannot import from each other, so this
  // pair is hand-maintained. This is the test that makes that safe: without it
  // the two tables drift and the filters disagree again, which is the exact
  // problem the shared table was introduced to end.
  it('declares the same tokens in both copies', () => {
    expect(client.OBJECT_CLASS_TOKENS).toEqual(server.OBJECT_CLASS_TOKENS);
  });

  it('declares the same precedence order in both copies', () => {
    expect(client.OBJECT_CLASS_ORDER).toEqual(server.OBJECT_CLASS_ORDER);
  });

  it.each(TYPES)('agrees on every family for "%s"', (type) => {
    expect(client.classOfType(type)).toBe(server.classOfType(type));
    for (const cls of client.OBJECT_CLASS_ORDER) {
      expect(client.typeInClass(type, cls), `${type} / ${cls}`).toBe(server.typeInClass(type, cls));
    }
  });

  it('agrees on empty, null and undefined input', () => {
    for (const value of ['', null, undefined]) {
      expect(client.classOfType(value)).toBe(server.classOfType(value));
      expect(client.typeInClass(value, 'nebula')).toBe(server.typeInClass(value, 'nebula'));
    }
  });
});

// ─── The mapping itself ────────────────────────────────────────────────────

describe('objectCategories — the shipped catalog vocabulary', () => {
  it.each(TYPES)('classifies "%s"', (type) => {
    expect(client.classOfType(type)).toBe(EXPECTED_CLASS[type]);
  });

  it('puts a supernova remnant in the nebula family, not nowhere', () => {
    // The regression this whole module exists for: the Planner's Nebulae chip
    // used to skip supernova remnants while the Catalogs board counted them.
    expect(client.typeInClass('Supernova Remnant', 'nebula')).toBe(true);
    expect(client.typeInClass('Supernova Remnant', 'cluster')).toBe(false);
    expect(client.typeInClass('Supernova Remnant', 'galaxy')).toBe(false);
  });

  it('puts a hybrid cluster+nebula in BOTH families for per-family callers', () => {
    expect(client.typeInClass('Cluster + Nebula', 'nebula')).toBe(true);
    expect(client.typeInClass('Cluster + Nebula', 'cluster')).toBe(true);
    expect(client.typeInClass('Cluster + Nebula', 'galaxy')).toBe(false);
  });

  it('does not treat a dark cloud as a cluster', () => {
    // The dropped "cl" shorthand matched this; whole-word matching does not.
    expect(client.typeInClass('Dark Cloud', 'cluster')).toBe(false);
  });

  it('matches whole words, not arbitrary substrings', () => {
    expect(client.typeInClass('Cluster + Nebula', 'cluster')).toBe(true);
    expect(client.typeInClass('Clusteroid', 'cluster')).toBe(false);
  });

  it('is case-insensitive and trims nothing it should not', () => {
    expect(client.classOfType('EMISSION NEBULA')).toBe('nebula');
    expect(client.classOfType('  spiral galaxy  ')).toBe('galaxy');
  });

  it('leaves every type that is not a galaxy, nebula or cluster unclassified', () => {
    for (const type of ['Star Cloud', 'Double Star', 'Unknown', 'Other', 'Comet', 'Moon']) {
      expect(client.classOfType(type), type).toBeNull();
    }
  });
});
