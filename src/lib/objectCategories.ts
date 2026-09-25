/**
 * How catalog object types map onto the coarse families the UI filters by:
 * galaxy, nebula, cluster.
 *
 * This is the single definition of that mapping. Before it existed the same
 * question was answered by hand in five places (the Planner's filter chips, the
 * server's auto-planner focus, the Library's curated chips, the Library hero's
 * class breakdown, and the Catalogs board's grouping) and they had quietly
 * drifted apart. Most visibly, a Supernova Remnant counted as a nebula on the
 * Catalogs board while being missing from the Planner's Nebulae filter
 * entirely, and "Cluster + Nebula" was a cluster in one place and a nebula in
 * another. Nobody wrote a bug; five independent copies just disagree over time.
 *
 * Matching is against the type text, which comes from the catalog and stays
 * English whatever language the UI is in. It is on whole words, so "cluster"
 * matches "Cluster + Nebula" but the old two-letter shorthand "cl" is gone: it
 * also matched "Dark Cloud", which is not a cluster.
 *
 * The server keeps its own port of this file at server/lib/objectCategories.ts
 * because the client and server build roots cannot import from each other, the
 * same reason bestImagingWindow and moonProximity each exist twice.
 * tests/backend/objectCategories.test.ts fails if the two ever disagree.
 */

/** The coarse families a user can filter by. */
export type ObjectClass = 'galaxy' | 'nebula' | 'cluster';

/**
 * Words that place a type in each family.
 *
 * Measured against the real catalog: 22 distinct type strings, every one of
 * them a plain English phrase with no shorthand codes. Against that vocabulary
 * only `supernova` changes any result, because every other nebula type already
 * contains the literal word "nebula". The remaining extras are here so a future
 * type such as "Reflection" on its own still lands in the right family.
 *
 * `asterism` is deliberately grouped with clusters. An asterism is a chance
 * grouping rather than a true cluster, but someone filtering for clusters wants
 * the Coathanger, and the Catalogs board has always shown it that way.
 */
export const OBJECT_CLASS_TOKENS: Readonly<Record<ObjectClass, readonly string[]>> = {
  galaxy: ['galaxy'],
  nebula: ['nebula', 'emission', 'reflection', 'planetary', 'supernova'],
  cluster: ['cluster', 'asterism'],
};

/**
 * Order for callers that must pick exactly one family: the Library hero's
 * breakdown counts and the Catalogs board's grouping.
 *
 * "Cluster + Nebula" therefore reads as a nebula there, because the nebulosity
 * is what the object is imaged for and what decides whether a narrowband filter
 * helps. Callers that ask about one family at a time are unaffected: that
 * object is in both, which is what the Planner's chips want.
 */
export const OBJECT_CLASS_ORDER: readonly ObjectClass[] = ['galaxy', 'nebula', 'cluster'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the type carries one of the family's words as a whole word. */
export function typeInClass(type: string | null | undefined, cls: ObjectClass): boolean {
  const t = (type ?? '').toLowerCase();
  if (!t) return false;
  return OBJECT_CLASS_TOKENS[cls].some(token =>
    new RegExp(`(^|\\b)${escapeRegExp(token)}(\\b|$)`).test(t),
  );
}

/** The first family the type belongs to, or null for everything else. */
export function classOfType(type: string | null | undefined): ObjectClass | null {
  for (const cls of OBJECT_CLASS_ORDER) {
    if (typeInClass(type, cls)) return cls;
  }
  return null;
}
