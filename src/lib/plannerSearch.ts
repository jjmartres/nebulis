/**
 * How the Planner's object list answers a search box.
 *
 * Two sources feed it. The in-browser list is every object that is up tonight,
 * matched instantly on the names the server sent for each one. The server
 * catalog search covers the rest of the sky, including objects that never rise
 * tonight, and is the authority on what an object is called. The two must
 * never drop an object between them, so this module owns both halves:
 *
 *   - a target is shown when the browser matches it OR the server's results
 *     name it (by id or by any alias, so "Sh2-155" finds the target stored
 *     under OpenNGC's "C9");
 *   - a server result is listed as "not observable tonight" only when no
 *     target already stands for it, so the same object is never listed twice.
 *
 * LibraryPanel renders what these return; tests/backend/dsoAliasSearch.test.ts
 * and tests/frontend/plannerSearch.test.ts hold them to every known object.
 */
import { catalogNumber, catalogPrefix, isExactMatch, matchesSearch, searchKey } from './dsoSearch';

interface Named {
  id: string;
  ngcName: string;
  name: string;
  constellation: string | null;
  commonNames: string[];
  aliases?: string[];
}

/** Every id an object goes by, folded to comparison keys. */
function identityKeys(e: { id: string; aliases?: string[] }): string[] {
  return [e.id, ...(e.aliases ?? [])].map(searchKey).filter(Boolean);
}

/** Keys of everything the server's results stand for. */
export function serverResultKeys(results: ReadonlyArray<{ id: string; aliases?: string[] }> | undefined): Set<string> {
  const keys = new Set<string>();
  for (const r of results ?? []) for (const k of identityKeys(r)) keys.add(k);
  return keys;
}

/** True when the browser matches the target, or the server's results name it. */
export function targetMatches<T extends Named>(target: T, query: string, serverKeys: ReadonlySet<string>): boolean {
  if (matchesSearch(target, query)) return true;
  return serverKeys.size > 0 && identityKeys(target).some((k) => serverKeys.has(k));
}

/** Matching targets with an exact name or designation first, the rest in
 *  their existing order (the sort is stable). A catalog name ("Caldwell")
 *  lists that catalog in order, C1, C2, C3... */
export function rankTargets<T extends Named>(matched: readonly T[], query: string): T[] {
  const catalog = catalogPrefix(query);
  if (catalog) {
    const n = (t: T) => catalogNumber(t, catalog) ?? Infinity;
    return [...matched].sort((a, b) => n(a) - n(b));
  }
  return [...matched].sort((a, b) => Number(isExactMatch(b, query)) - Number(isExactMatch(a, query)));
}

/** Server results no target already stands for: the "not observable" rows. */
export function resultsWithoutTarget<R extends { id: string; aliases?: string[] }>(
  results: readonly R[] | undefined,
  targets: ReadonlyArray<{ id: string; aliases?: string[] }>,
): R[] {
  const have = new Set<string>();
  for (const t of targets) for (const k of identityKeys(t)) have.add(k);
  return (results ?? []).filter((r) => !identityKeys(r).some((k) => have.has(k)));
}
