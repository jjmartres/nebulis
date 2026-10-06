/**
 * Deciding what to archive.
 *
 * **The archive holds everything in the library folder.** That is the promise the
 * feature makes, so completeness is decided by construction and not by a list of
 * things worth keeping: an object folder is walked in full, and so is every other
 * top-level folder of the library (`_archive/` calibration frames, the shared
 * `RESTACKED/`, and any stray folder no object row claims; the folder of an object
 * the user deleted is not stray, and stays out). The only things left
 * out are bookkeeping Nebulis rebuilds itself, and they are named here so the list
 * cannot grow by accident:
 *
 *   - dot-prefixed entries: `.thumbs/` (a cache of generated previews) and
 *     `.nebulis-files.json` (the per-file index, rebuilt from the database),
 *   - OS junk (`.DS_Store`, `Thumbs.db`, AppleDouble `._x`),
 *   - symlinks, which are never followed, and
 *   - files of linked folders, which live in the user's own folder, not the library.
 *
 * An earlier version walked session folders only and kept files with a known
 * image extension. That silently dropped `<object>/processed/` (the user's finished
 * images), `_archive/` and `RESTACKED/`, and any `.json`/`.xisf`/`.txt` file inside
 * a session, from what was sold as the backup.
 *
 * `resolverFor(...).role` is the same classifier that decides which files are
 * subframes for import, for deletion, and for the manifest. A second definition
 * of "is this a subframe" here would eventually disagree with the first, and the
 * disagreement would surface either as subframes surviving a "don't archive
 * subframes" setting, or as a local-removal pass deleting a file it had not
 * archived.
 *
 * Two rules matter and are not configurable:
 *
 *  - **The layout is mirrored.** A candidate's path inside the archive is its
 *    object folder name followed by its path inside that folder, so the disk
 *    looks like the library and can be pointed at directly by Siril or
 *    PixInsight. This is Decision 7 of the contract.
 *  - **A file is sourced through a contained path.** The object directory is
 *    resolved with `resolveContainedObjectDir`, never rebuilt by joining
 *    `getLibraryDir()` to a folder name. Four audit criticals came from doing the
 *    latter.
 *
 * Nothing here writes, and nothing here throws on a bad object: one unreadable
 * folder produces a warning rather than abandoning an eleven-object run.
 */

import fs from 'fs';
import path from 'path';

import db from '../db.js';
import { getLibraryObjectNames, resolveContainedObjectDir } from '../library/objects.js';
import { isReservedObjectDir } from '../library/libraryLayout.js';
import { LINKED_SOURCE_DIR_NAME } from '../library/archiveFolders.js';
import { resolverFor, type LibraryFileRole } from '../library/libraryFiles.js';
import { getLibraryDir } from '../libraryPath.js';
import { isHiddenOrSystemFile, parseFilename } from '../telescopeFiles.js';
import { cutoffMs } from './archiveAge.js';
import type { ArchiveConfig } from './archiveConfig.js';

export interface ArchiveCandidate {
  objectId: string;
  /** The on-disk object folder name, which is also the archive's folder name. */
  folderName: string;
  /** Path relative to the object folder, posix-style. `<session>/<file>` when
   *  the object is stored nested. */
  relPath: string;
  fileName: string;
  sessionFolder: string | null;
  /** Absolute path in the library. Read-only; the source is never modified. */
  sourcePath: string;
  /** Path relative to the archive root. Mirrors the library layout. */
  archiveRelPath: string;
  bytes: number;
  /** The source's mtime at selection, recorded with its digest so a later run can
   *  tell an unchanged file from a touched one without hashing it. */
  mtimeMs: number;
  /** Set by the copy engine once the file is verified on the archive. */
  sha256?: string;
  role: LibraryFileRole;
}

export interface ArchiveSelection {
  candidates: ArchiveCandidate[];
  bytesTotal: number;
  objectsConsidered: number;
  /** Files left behind by the "exclude subframes" setting. Counted so the UI can
   *  say what it is not copying, rather than the total quietly differing. */
  subframesSkipped: number;
  /** Files left behind by `copyMinAgeEnabled` because they have not reached
   *  `copyMinAgeDays` yet. Counted for the same reason as `subframesSkipped`: a
   *  run that copies nothing because everything is too new should be able to say
   *  so, rather than looking indistinguishable from an empty library. */
  tooYoungSkipped: number;
  /** Files that belong to a linked folder, left out on purpose: they are the
   *  user's own originals in a folder they manage, and the archive mirrors the
   *  managed library. Counted so the run can say so, and so an object whose files
   *  are all linked is not reported as a missing folder. */
  linkedSkipped: number;
  /** Per-object problems that did not stop the selection. */
  warnings: string[];
}

/**
 * Best-effort capture date for a candidate, in epoch milliseconds.
 *
 * Prefers the session folder's date, present for every nested object regardless
 * of which device wrote it: `canonicalSessionFolder` (the fallback every layout
 * without its own device-named folder uses) always starts with `YYYY-MM-DD`, and
 * a device that does name its own folder (Dwarf) produces something that does
 * not match that shape, which is exactly when this falls through. Next is the
 * date `parseFilename` reads out of the file's own name, for a flat object with
 * no session folder at all (SeeStar). Last is the file's own mtime, which is
 * always available but the least trustworthy: it reflects when the file was
 * written to this disk, not when it was captured, and can be disturbed by a
 * restore, a re-import, or a filesystem that does not preserve it.
 */
function candidateCapturedMs(sessionFolder: string | null, fileName: string, mtimeMs: number): number {
  if (sessionFolder) {
    const datePart = sessionFolder.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      const parsed = Date.parse(datePart);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const fromFilename = parseFilename(fileName).date;
  if (fromFilename) {
    const parsed = Date.parse(fromFilename);
    if (Number.isFinite(parsed)) return parsed;
  }
  return mtimeMs;
}

/** Deepest folder level a walk will descend. A library is a few levels deep; the cap is only a guard. */
const MAX_WALK_DEPTH = 12;

interface WalkedFile {
  /** Path relative to the walked folder, posix-style. */
  relPath: string;
  fileName: string;
  /** The first-level folder the file sits in, or null when it is directly in the walked folder. */
  sessionFolder: string | null;
}

/**
 * Every regular file under `dir`, except what the header of this module names as
 * bookkeeping. `Dirent` reports a symlink as neither a file nor a directory, so a
 * link is skipped rather than followed out of the library.
 */
function walkFolder(dir: string, prefix = '', depth = 0, out: WalkedFile[] = []): WalkedFile[] {
  if (depth > MAX_WALK_DEPTH) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (isHiddenOrSystemFile(ent.name)) continue;
    const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
    if (ent.isFile()) {
      out.push({ relPath: rel, fileName: ent.name, sessionFolder: prefix === '' ? null : rel.split('/')[0] });
    } else if (ent.isDirectory()) {
      walkFolder(path.join(dir, ent.name), rel, depth + 1, out);
    }
  }
  return out;
}

/** True for a path inside one of an object's reserved folders (`processed/`, `thumbnails/`). These hold the
 *  user's own files but are not sessions, so nothing about them says "sub-frame". */
function isReservedObjectPath(relPath: string): boolean {
  const first = relPath.split('/')[0];
  return relPath.includes('/') && isReservedObjectDir(first);
}

const allObjectFolderNamesStmt = db.prepare<[], { folderName: string }>(
  "SELECT folderName FROM libraryObjects WHERE folderName IS NOT NULL AND folderName != ''",
);

const linkedCountsStmt = db.prepare<[], { objectId: string; n: number }>(
  'SELECT objectId, COUNT(*) AS n FROM libraryFiles WHERE sourceId IS NOT NULL AND missingSince IS NULL GROUP BY objectId',
);

/**
 * Every file that should be copied to the archive for this configuration.
 *
 * Pure with respect to the archive: it reads the library and returns paths. It
 * creates nothing, so it is safe to call for a dry run or a size estimate.
 *
 * `now` defaults to the real clock and exists so the age filter below can be
 * tested against a fixed instant rather than a moving one.
 */
export function selectArchiveFiles(config: ArchiveConfig, now: Date = new Date()): ArchiveSelection {
  const candidates: ArchiveCandidate[] = [];
  const warnings: string[] = [];
  let bytesTotal = 0;
  let subframesSkipped = 0;
  let tooYoungSkipped = 0;
  let objectsConsidered = 0;
  let linkedSkipped = 0;
  const linkedByObject = new Map(linkedCountsStmt.all().map(r => [r.objectId, r.n]));

  // Computed once, not per file: every candidate is judged against the same
  // instant, so a run does not have files straddle the line as the clock ticks
  // partway through a long selection.
  const cutoff = config.copyMinAgeEnabled && config.copyMinAgeDays > 0 ? cutoffMs(config.copyMinAgeDays, now) : null;

  const wanted = config.scope === 'selected' ? new Set(config.selectedObjects) : null;

  /** Stat one file, apply the age filter, and add it to the selection. `owner.objectId` is empty for a folder
   *  that is not an object. */
  const consider = (owner: { objectId: string; folderName: string }, baseDir: string, entry: WalkedFile, role: LibraryFileRole): void => {
    const sourcePath = path.join(baseDir, entry.relPath);
    let bytes: number;
    let mtimeMs: number;
    try {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) return;
      bytes = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      // A file that vanished or is unreadable between listing and stat is a
      // warning, not a failure: the rest of the run is still worth doing.
      warnings.push(`${owner.objectId || owner.folderName}: could not read ${entry.relPath}.`);
      return;
    }

    if (cutoff !== null) {
      const capturedMs = candidateCapturedMs(entry.sessionFolder, entry.fileName, mtimeMs);
      if (capturedMs > cutoff) {
        tooYoungSkipped++;
        return;
      }
    }

    candidates.push({
      objectId: owner.objectId,
      folderName: owner.folderName,
      relPath: entry.relPath,
      fileName: entry.fileName,
      sessionFolder: entry.sessionFolder,
      sourcePath,
      archiveRelPath: `${owner.folderName}/${entry.relPath}`,
      bytes,
      mtimeMs,
      role,
    });
    bytesTotal += bytes;
  };

  for (const object of getLibraryObjectNames()) {
    if (wanted && !wanted.has(object.objectId)) continue;

    const linkedHere = linkedByObject.get(object.objectId) ?? 0;
    linkedSkipped += linkedHere;

    // Contained resolution, not `path.join(getLibraryDir(), folderName)`.
    const objDir = resolveContainedObjectDir(object.objectId);
    if (!objDir) {
      warnings.push(`${object.objectId}: its folder name does not resolve to a directory inside the library.`);
      continue;
    }
    if (!fs.existsSync(objDir)) {
      // An object made only of linked files has no folder of its own by design.
      if (linkedHere > 0) continue;
      warnings.push(`${object.objectId}: the folder is missing from the library.`);
      continue;
    }

    objectsConsidered++;

    const identity = resolverFor(object.objectId);

    for (const entry of walkFolder(objDir)) {
      // A finished image the user put in processed/ is never a sub-frame, whatever its name resembles.
      const role: LibraryFileRole = isReservedObjectPath(entry.relPath) ? 'unknown' : identity.role(entry.relPath);
      if (role === 'sub' && !config.includeSubframes) {
        subframesSkipped++;
        continue;
      }

      consider(object, objDir, entry, role);
    }
  }

  // Everything else at the top of the library: the calibration frames in `_archive/`, the shared `RESTACKED/`,
  // and any folder that is no longer an object. None of them is an object, so they cannot be picked by a
  // "selected objects" scope; they ride along with a run over everything, which is what "everything" means.
  if (wanted === null) {
    // Every folder an object row claims, deleted or not: an object the user deleted is a decision, and a leftover
    // folder of it must not be brought back into a backup.
    const known = new Set(allObjectFolderNamesStmt.all().map(r => r.folderName));
    const libraryRoot = path.resolve(getLibraryDir());
    let top: fs.Dirent[] = [];
    try {
      top = fs.readdirSync(libraryRoot, { withFileTypes: true });
    } catch {
      top = [];
    }
    for (const dir of top) {
      if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === LINKED_SOURCE_DIR_NAME || known.has(dir.name)) continue;
      const dirPath = path.resolve(libraryRoot, dir.name);
      if (!dirPath.startsWith(libraryRoot + path.sep)) continue;
      for (const entry of walkFolder(dirPath)) consider({ objectId: '', folderName: dir.name }, dirPath, entry, 'unknown');
    }
  }

  // Deterministic order, so progress reporting and any diff of a run's output
  // are stable between runs over an unchanged library.
  candidates.sort((a, b) => a.archiveRelPath.localeCompare(b.archiveRelPath));

  return { candidates, bytesTotal, objectsConsidered, subframesSkipped, tooYoungSkipped, linkedSkipped, warnings };
}
