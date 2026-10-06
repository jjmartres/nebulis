/**
 * Normalized search + display-name helpers for DSO catalog entries.
 *
 * Handles common matching gotchas:
 *   - Leading zeros in NGC/IC names (NGC0224 ↔ NGC224)
 *   - Whitespace variance (M 42 ↔ M42)
 *   - Case insensitivity
 *   - Messier-number-only queries ("42" finds M42)
 *
 * And suppresses "fake" common names like `"Messier 42"` so they don't
 * clutter the UI next to the short identifier.
 */

interface SearchableEntry {
  id: string;
  ngcName: string;
  name: string;
  constellation: string | null;
  commonNames: string[];
  /** Other catalog designations (Caldwell, Messier, NGC/IC), when the source carries them. */
  aliases?: string[];
  /** Optional — not present on PlannerTarget, only on DsoEntry. */
  messier?: number | null;
}

/**
 * Canonical form for substring search: lowercase, strip spaces, and collapse
 * leading zeros after an alpha prefix (so "NGC0224" and "NGC 224" normalize
 * to the same string). Digit-only queries pass through unchanged.
 */
export function normalizeSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/([a-z])0+(\d)/g, '$1$2');
}

/**
 * Comparison key for matching a typed query against an object's names. Both
 * sides go through it, so every spelling of the same designation lands on one
 * string:
 *
 *   "Messier 31" / "M 31" / "m31"            -> "m31"
 *   "Caldwell 39" / "C 39" / "c39"           -> "c39"
 *   "Sharpless 155" / "Sh 2-155" / "SH2-155" -> "sh2155"
 *   "NGC 0224" / "ngc224"                    -> "ngc224"
 *   "Bode's Galaxy" / "bodes galaxy"         -> "bodesgalaxy"
 *
 * It mirrors `normalizeDesignation` in server/lib/catalogAliases.ts, and
 * tests/backend/dsoAliasSearch.test.ts holds the two together. Only ever used
 * for comparison, never for display.
 */
const LONG_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmessier\s*-?\s*(?=\d)/g, 'm'],
  [/\bcaldwell\s*-?\s*(?=\d)/g, 'c'],
  // "Sharpless 2-155" carries the catalog number 2; "Sharpless 281" does not.
  [/\bsharpless\s*(?:2\s*-\s*|2\s+(?=\d))?(?=\d)/g, 'sh2'],
  [/\bsh\s*-?\s*2\s*-?\s*(?=\d)/g, 'sh2'],
  [/\bmelotte\s*-?\s*(?=\d)/g, 'mel'],
  [/\bbarnard\s*-?\s*(?=\d)/g, 'b'],
];

// Matching runs this over every field of every target on each keystroke, and
// the same few thousand strings come round again, so remember the answers.
const keyCache = new Map<string, string>();
const KEY_CACHE_MAX = 60_000;

export function searchKey(s: string): string {
  const hit = keyCache.get(s);
  if (hit !== undefined) return hit;
  let t = s.toLowerCase();
  for (const [re, short] of LONG_FORMS) t = t.replace(re, short);
  const key = t
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/([a-z])0+(\d)/g, '$1$2');
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(s, key);
  return key;
}

/** Every string an entry can be found by: ids, catalog name, constellation,
 *  common names, other designations, and its Messier number. */
function searchableFields(entry: SearchableEntry): string[] {
  const fields: string[] = [
    entry.id,
    entry.ngcName,
    entry.name,
    entry.constellation ?? '',
    ...entry.commonNames,
    ...(entry.aliases ?? []),
  ];
  if (entry.messier != null) {
    fields.push(`M${entry.messier}`);
    fields.push(String(entry.messier));
  }
  return fields;
}

/**
 * Substring-match a query against every indexable field of a DSO entry, in
 * the spellings `searchKey` folds together: so "ngc224", "NGC 0224", "Messier
 * 31", "caldwell 39" and "C 39" all find the object they name.
 */
export function matchesSearch(entry: SearchableEntry, query: string): boolean {
  const q = searchKey(query);
  if (!q) return true;
  const catalog = catalogPrefix(query);
  if (catalog && catalogNumber(entry, catalog) !== null) return true;
  // A catalog number ("C39", "m8", "ngc2392") matches names that START with it,
  // so typing M8 offers M8, M81 and M82 but "c39" no longer drags in NGC 3913
  // just because the letters appear inside it. Names and bare digits ("224")
  // still match anywhere.
  const prefixOnly = isDesignationKey(q);
  for (const field of searchableFields(entry)) {
    const key = searchKey(field);
    if (prefixOnly ? key.startsWith(q) : key.includes(q)) return true;
  }
  return false;
}

/**
 * A typed catalog name ("Caldwell", "sharpless", "cald", "Messier ") asks for
 * every object in that catalog, not for text. Returns the short designation
 * prefix those objects use (C39 -> "c", Sh2-155 -> "sh2"), or null for anything
 * else. Four letters are enough ("cald", "mess"): shorter would catch ordinary
 * names such as "Bar" or "Mel".
 */
const CATALOG_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['messier', 'm'],
  ['caldwell', 'c'],
  ['sharpless', 'sh2'],
  ['melotte', 'mel'],
  ['barnard', 'b'],
];

export function catalogPrefix(query: string): string | null {
  const word = query.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length < 4 || !/^[a-z\s]+$/i.test(query.trim())) return null;
  return CATALOG_WORDS.find(([name]) => name.startsWith(word))?.[1] ?? null;
}

/** The entry's number in a catalog ("C39" in "c" gives 39), or null when it has none. */
export function catalogNumber(entry: SearchableEntry, prefix: string): number | null {
  const re = new RegExp(`^${prefix}(\\d+)[a-z]?$`);
  let best: number | null = null;
  for (const field of searchableFields(entry)) {
    const m = re.exec(searchKey(field));
    if (m) best = best === null ? Number(m[1]) : Math.min(best, Number(m[1]));
  }
  return best;
}

/** A key shaped like a catalog number: a short letter prefix, digits, maybe a suffix letter. */
export function isDesignationKey(key: string): boolean {
  return /^[a-z]{1,4}\d+[a-z]?$/.test(key);
}

/**
 * True when the query is, in full, one of the entry's designations or names
 * (id, catalog name, alias, common name). Used to put "C39" and "Eskimo
 * Nebula" ahead of NGC3900 and IC391, which merely contain the same text.
 */
export function isExactMatch(entry: SearchableEntry, query: string): boolean {
  const q = searchKey(query);
  if (!q) return false;
  return [entry.id, entry.ngcName, entry.name, ...entry.commonNames, ...(entry.aliases ?? [])]
    .some((d) => searchKey(d) === q);
}

/**
 * A `name` field is a "real" common name if it doesn't match any known
 * catalog-identifier pattern. Regex covers: Messier, M, NGC, IC, UGC, PGC,
 * ESO, Sharpless/Sh2, Melotte, Collinder, Abell, Palomar, Terzan, vdB, LDN,
 * LBN, Ced, PK, Caldwell, Hickson, Arp, VV, DDO, Mrk. Each allows digits,
 * dashes, and letter suffixes ("NGC4565A", "Sh2-155", "M40").
 */
const CATALOG_ID_RE =
  /^(messier|m|ngc|ic|ugc|pgc|eso|sh\s*2?|sharpless|mel|cr|abell|palomar|terzan|vdb|ldn|lbn|ced|pk|caldwell|hickson|arp|vv|ddo|mrk)\s*[-\d]+[a-z]?\s*$/i;

function isCatalogIdName(name: string): boolean {
  return CATALOG_ID_RE.test(name.trim());
}

/**
 * Resolve the display names for a catalog entry.
 *
 * `short` is always the short scientific identifier (M42, NGC7000, IC434) —
 * the large label shown in the row. `common` is the human-friendly name only
 * if one exists; returns `null` for entries whose `name` is just a catalog
 * identifier placeholder (e.g. `"Messier 40"` when the real Messier 40 has
 * no common name).
 */
/**
 * Format an object's display title as "M104 (Sombrero Galaxy)" — scientific
 * ID first, common name in parentheses only when it differs from the ID.
 *
 * @param catalogId  The catalog/scientific identifier (e.g. "M 104", "NGC4594")
 * @param objectName The stored display/common name (e.g. "Sombrero Galaxy")
 * @param fallback   Used when both above are absent (typically the raw objectId)
 */
export function formatObjectTitle(
  catalogId: string | null | undefined,
  objectName: string | null | undefined,
  fallback: string
): string {
  const short = (catalogId || fallback).toUpperCase().replace(/\s+/g, '');
  const common = (objectName || '').trim();

  if (!common) return short;
  if (common.toUpperCase().replace(/\s+/g, '') === short) return short;
  if (isCatalogIdName(common)) return short;

  return `${short} (${common})`;
}
