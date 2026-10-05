/**
 * Catalog-number ordering for library objects: M1 < M2 < M31 < C1 < NGC 188 < NGC 7000,
 * rather than string order ("M10" < "M2") or display-name order (Andromeda < Orion).
 * Also supplies the catalog "family" used by the Library's Group-by.
 */

export type CatalogFamily = 'M' | 'C' | 'NGC' | 'IC' | 'Sh2' | 'Other';

/** Display order of families, and the order sections appear when grouped. */
export const CATALOG_FAMILY_ORDER: CatalogFamily[] = ['M', 'C', 'NGC', 'IC', 'Sh2', 'Other'];

const FAMILY_PATTERNS: { family: CatalogFamily; re: RegExp }[] = [
  { family: 'M',   re: /^M[\s-]?(\d+)(.*)$/i },
  { family: 'C',   re: /^(?:C|CALDWELL)[\s-]?(\d+)(.*)$/i },
  { family: 'NGC', re: /^NGC[\s-]?(\d+)(.*)$/i },
  { family: 'IC',  re: /^IC[\s-]?(\d+)(.*)$/i },
  { family: 'Sh2', re: /^(?:SH2|SHARPLESS)[\s-]?(\d+)(.*)$/i },
];

export interface ParsedDesignation {
  family: CatalogFamily;
  /** Position of the family in CATALOG_FAMILY_ORDER. */
  rank: number;
  /** Catalog number; NaN for 'Other' (compared as text). */
  number: number;
  suffix: string;
}

export function parseDesignation(catalogId: string): ParsedDesignation {
  const id = catalogId.trim();
  for (const { family, re } of FAMILY_PATTERNS) {
    const m = re.exec(id);
    if (m) {
      return {
        family,
        rank: CATALOG_FAMILY_ORDER.indexOf(family),
        number: parseInt(m[1], 10),
        suffix: m[2].trim().toLowerCase(),
      };
    }
  }
  return { family: 'Other', rank: CATALOG_FAMILY_ORDER.indexOf('Other'), number: Number.NaN, suffix: '' };
}

export function catalogFamilyOf(catalogId: string): CatalogFamily {
  return parseDesignation(catalogId).family;
}

/** Comparator over catalog IDs. Falls back to a numeric-aware text compare for 'Other'. */
export function compareDesignations(a: string, b: string): number {
  const pa = parseDesignation(a);
  const pb = parseDesignation(b);
  if (pa.rank !== pb.rank) return pa.rank - pb.rank;
  if (pa.family === 'Other') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return pa.number - pb.number || pa.suffix.localeCompare(pb.suffix);
}
