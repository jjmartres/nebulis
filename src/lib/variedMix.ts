/**
 * Ordering a target list for variety rather than for score.
 *
 * The planner's targets arrive ranked by how good tonight is for each one,
 * which is the right order when you want the single best target. It is a poor
 * browse order though: ten galaxies in a row is a common result, and nothing
 * about the list tells you what else is up.
 *
 * This is that one function, kept pure and outside the component so the
 * property that matters (it is a permutation) can be tested directly.
 */
import { classOfType, type ObjectClass } from './objectCategories';

/** The buckets a varied mix rotates through: the three families the app names,
 *  plus everything the mapping does not claim, such as double stars and star
 *  clouds. Those still belong in the list, just not in a family of their own. */
type MixBucket = ObjectClass | 'other';

/** Rotation order. Fixed rather than derived from the input, so two lists with
 *  the same contents come out in the same order. */
const BUCKET_ORDER: readonly MixBucket[] = ['nebula', 'galaxy', 'cluster', 'other'];

function bucketOf(type: string): MixBucket {
  return classOfType(type) ?? 'other';
}

/**
 * Reorder targets so consecutive rows come from different families.
 *
 * Takes the best-ranked remaining member of each family in turn, so the top of
 * the list shows the range of what is up rather than one repeated shape, and
 * the strongest target of each family still appears before its weaker siblings.
 *
 * The families come from the shared mapping in objectCategories, so "what
 * counts as a nebula" is still answered in exactly one place.
 *
 * It is a permutation: every input appears exactly once, and the caller's
 * ranking is preserved inside each family. An empty or single-family list comes
 * back in its original order.
 */
export function variedMix<T extends { type: string }>(targets: readonly T[]): T[] {
  const buckets: Record<MixBucket, T[]> = { nebula: [], galaxy: [], cluster: [], other: [] };
  for (const target of targets) buckets[bucketOf(target.type)].push(target);

  // Index cursors rather than shift(): the list can run to a couple of thousand
  // rows, and repeated shift() would make this quadratic.
  const cursors: Record<MixBucket, number> = { nebula: 0, galaxy: 0, cluster: 0, other: 0 };
  const out: T[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const bucket of BUCKET_ORDER) {
      const list = buckets[bucket];
      const i = cursors[bucket];
      if (i < list.length) {
        out.push(list[i]);
        cursors[bucket] = i + 1;
        progressed = true;
      }
    }
  }
  return out;
}
