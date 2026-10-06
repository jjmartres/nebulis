/**
 * Extra names for a library object, learned from how the user labelled its
 * folder ("C 1 - Polarissima Cluster" -> "Polarissima Cluster").
 *
 * The catalog often knows an object only by its NGC/IC id, while people name
 * folders after the popular name. Keeping that name lets search find the object
 * by it and lets the card and the review screens show it, instead of the
 * object looking like something the user never imported.
 *
 * Pure: takes names and the object's catalog facts, does no I/O.
 */
import { identifyObjectFromFolderName } from './objectIdentification.js';
import { isSubFolder } from '../telescopeFiles.js';

const MAX_NICKNAMES = 8;

/** Letters and digits only, lowercased: "Bode's Galaxy" and "Bodes galaxy" match. */
const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The names a set of folder names adds for `objectId`. A folder contributes
 * only when it reads "<designation> <separator> <name>" and the designation
 * part identifies this same object; anything else is not a name for it.
 * Names the catalog already gives (its own name, its ids and aliases) are
 * dropped so nothing is shown twice.
 */
export function nicknamesFromFolderNames(
  folderNames: Iterable<string>,
  objectId: string,
  known: { catalogName: string; aliases: readonly string[] },
): string[] {
  const knownSquashed = [objectId, known.catalogName, ...known.aliases].map(squash).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of folderNames) {
    if (isSubFolder(raw)) continue;
    const m = raw.trim().match(/^(.+?)\s+[-–—:]\s+(.+)$/);
    if (!m) continue;
    const [, before, after] = m;
    if (identifyObjectFromFolderName(before)?.objectId !== objectId) continue;

    const name = after.trim();
    const key = squash(name);
    if (name.length < 2 || name.length > 60 || !key || !/\p{L}/u.test(name)) continue;
    // A second designation is not a name ("M 31 - NGC 224").
    if (identifyObjectFromFolderName(name)) continue;
    if (knownSquashed.some(k => k === key || k.includes(key))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, MAX_NICKNAMES);
}

/** Merge new names into the stored JSON list, case- and punctuation-insensitive. */
export function mergeNicknames(stored: string | null, add: readonly string[]): string[] {
  let current: string[] = [];
  try {
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) current = parsed.filter((v): v is string => typeof v === 'string');
  } catch { /* corrupt value: start over */ }
  const seen = new Set(current.map(squash));
  for (const n of add) {
    const k = squash(n);
    if (k && !seen.has(k)) { seen.add(k); current.push(n); }
  }
  return current.slice(0, MAX_NICKNAMES);
}

export function parseNicknames(stored: string | null): string[] {
  return mergeNicknames(stored, []);
}
