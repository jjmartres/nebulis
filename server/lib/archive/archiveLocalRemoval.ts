/**
 * Removing local subframes once their archived copy is verified.
 *
 * This is the only place the feature deletes from the user's library, permanently,
 * on the strength of a claim that a copy exists somewhere else. That claim has to
 * be *verified* rather than assumed, because the failure mode is one this codebase
 * has already suffered: the Dwarf RESTACKED migration inferred "already present"
 * from a path relationship, then removed the source, and the only copy of the
 * user's data was gone.
 *
 * So a local file is removed only when all of the following hold:
 *
 *   - the setting is on (`removeLocalAfter` is off by default),
 *   - the destination is a usable root whose marker identifies it as this
 *     install's archive,
 *   - the manifest records the file as a subframe, which is the library's own
 *     classification taken at archive time,
 *   - the archived copy exists, is a regular file, and matches the local file by
 *     size *and* digest (`verifyArchivedCopy`, the same function the copy engine
 *     uses to decide a file is already archived), and
 *   - the local path is still a regular file inside its own object folder.
 *
 * Anything that fails one of those is counted as skipped and left alone. The
 * deletion itself goes through the library's own `deleteLocalFilesByRelPath`, so
 * the file rows, the object's file count, and the per-object manifest stay
 * consistent: a library that lists files which are not on disk is its own kind of
 * bug.
 */

import type { Stats } from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { getLibraryObjectNames, resolveContainedObjectDir } from '../library/objects.js';
import { deleteLocalFilesByRelPath } from '../library/observations.js';
import { resolveContainedArchivePath } from './archivePath.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { readArchiveManifest } from './archiveManifest.js';
import { verifyArchivedCopy } from './archiveCopy.js';
import type { ArchiveConfig } from './archiveConfig.js';

export interface LocalRemovalResult {
  /** False when the setting is off or the disk could not be used, which is
   *  different from running and finding nothing to do. */
  ran: boolean;
  removed: number;
  /** Subframes left in place because their archived copy could not be verified,
   *  or the local path was no longer a regular file. */
  skipped: number;
  bytesRemoved: number;
  failures: string[];
}

const DID_NOT_RUN: Omit<LocalRemovalResult, 'failures'> = {
  ran: false,
  removed: 0,
  skipped: 0,
  bytesRemoved: 0,
};

export interface LocalRemovalOptions {
  /** Test seam: runs after a file verified and before it is deleted, which is the
   *  window in which the file could be edited or replaced. */
  afterVerify?: (localAbs: string) => void | Promise<void>;
}

/** The parts of a stat that say "still the same file": size and mtime. */
function sameFile(a: Stats, b: Stats): boolean {
  return a.isFile() && b.isFile() && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Remove every local subframe whose archived copy verifies.
 *
 * Each file is verified and deleted in turn, so an interrupted run leaves every
 * removed file with a verified copy and every other file untouched.
 *
 * Idempotent by construction: a second call finds the subframes already gone and
 * removes nothing more, because the manifest is the same list both times.
 */
export async function removeVerifiedLocalSubframes(
  config: ArchiveConfig,
  options: LocalRemovalOptions = {},
): Promise<LocalRemovalResult> {
  if (!config.removeLocalAfter) return { ...DID_NOT_RUN, failures: [] };

  // The archived copy is what justifies each local delete, so an unreachable or
  // foreign destination has to refuse rather than fail open.
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) {
    return { ...DID_NOT_RUN, failures: [`${readiness.warning} Nothing was removed locally.`] };
  }
  const root = readiness.root;

  const manifest = readArchiveManifest(root, config.archiveId);
  const objectIdByFolder = new Map<string, string>();
  for (const object of getLibraryObjectNames()) objectIdByFolder.set(object.folderName, object.objectId);

  const failures: string[] = [];
  let removed = 0;
  let skipped = 0;
  let bytesRemoved = 0;

  for (const [folderName, entry] of Object.entries(manifest.objects)) {
    const objectId = objectIdByFolder.get(folderName);
    // The object is gone locally, so there is nothing to remove. It is also not an
    // error: the archive is the backup precisely for that case.
    if (!objectId) continue;

    const objDir = resolveContainedObjectDir(objectId);
    if (!objDir) {
      failures.push(`${folderName}: its folder does not resolve inside the library.`);
      continue;
    }

    for (const file of entry.files) {
      if (!file.isSubframe) continue;

      const archiveRelPath = `${folderName}/${file.relPath}`;
      const archivedAbs = resolveContainedArchivePath(root, ...archiveRelPath.split('/'));
      if (archivedAbs === null) {
        skipped++;
        continue;
      }

      const segments = file.relPath.split('/');
      const localAbs = resolveContainedObjectDir(objectId, ...segments);
      if (!localAbs || !localAbs.startsWith(objDir + path.sep)) {
        // Not inside this object's own folder. `resolveContainedObjectDir` alone
        // would allow a sibling object reached through `..`.
        skipped++;
        continue;
      }

      // Verify one file and delete it straight away. Verifying everything first and
      // deleting afterwards leaves minutes to hours between "this matched" and "now
      // remove it", long enough for the user to re-stack over a subframe or for the
      // archive disk to be pulled. Size and mtime are read before and after the
      // digest, and any difference means the file is not what was verified.
      let before: Stats;
      try {
        before = await fsp.lstat(localAbs);
      } catch {
        skipped++;
        continue;
      }
      if (!before.isFile()) {
        skipped++;
        continue;
      }

      const verification = await verifyArchivedCopy(localAbs, archivedAbs);
      if (!verification.ok) {
        // Not verified, so the local file stays. This is the whole point.
        skipped++;
        continue;
      }

      await options.afterVerify?.(localAbs);

      let after: Stats;
      try {
        after = await fsp.lstat(localAbs);
      } catch {
        skipped++;
        continue;
      }
      if (!sameFile(before, after)) {
        skipped++;
        continue;
      }

      const result = deleteLocalFilesByRelPath(objectId, [file.relPath]);
      if (result.deleted === 1) {
        removed++;
        bytesRemoved += after.size;
      } else {
        // The library refused, which it does for anything no longer a regular file.
        failures.push(`${objectId}: ${file.relPath} was verified but could not be removed.`);
      }
    }
  }

  return { ran: true, removed, skipped, bytesRemoved, failures };
}
