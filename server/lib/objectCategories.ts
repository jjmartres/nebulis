/**
 * Server-side port of src/lib/objectCategories.ts.
 *
 * The client and server build roots cannot import from each other, so this pair
 * exists for the same reason server/lib/bestImagingWindow.ts and
 * server/lib/moonProximity.ts do. Keep the two in step:
 * tests/backend/objectCategories.test.ts imports both and fails if the tables
 * or their results ever diverge.
 *
 * See the client file for the full rationale. In short: this is the one
 * definition of which catalog types count as a galaxy, a nebula or a cluster,
 * replacing five hand-written copies that had drifted apart.
 */

/** The coarse families a user can filter by. */
export type ObjectClass = 'galaxy' | 'nebula' | 'cluster';

/** Words that place a type in each family. Must match the client table. */
export const OBJECT_CLASS_TOKENS: Readonly<Record<ObjectClass, readonly string[]>> = {
  galaxy: ['galaxy'],
  nebula: ['nebula', 'emission', 'reflection', 'planetary', 'supernova'],
  cluster: ['cluster', 'asterism'],
};

/** Order for callers that must pick exactly one family. Must match the client. */
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
