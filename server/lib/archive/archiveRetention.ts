/**
 * Retention: pruning the archive's own contents after a configured age.
 *
 * This is the only part of the feature that deletes something the user did not
 * ask it to delete at that moment, and the contract ranks "retention pointed at
 * the wrong directory" as the feature's highest risk. So the design is built
 * around what it will *not* touch, and every one of those properties has a test:
 *
 *   - **Only what the manifest names.** The record written by `archiveCopy` is the
 *     sole source of what may be removed. A file the user dropped into an archive
 *     folder is not in the record and is left alone, however old it is.
 *   - **Only inside the root, and only regular files.** Every path goes through
 *     `resolveContainedArchivePath`, and `lstat` (not `stat`) decides whether it
 *     is a file, so a recorded path that has since become a symlink is refused
 *     rather than followed.
 *   - **Only on our own disk.** The marker is re-checked when the plan is built
 *     *and* again when it is applied, because a plan can sit in front of a user
 *     and the disk behind it can change.
 *   - **Never the bookkeeping.** The marker and the manifest are refused by name,
 *     whatever a plan claims.
 *   - **Only copies that duplicate a local file.** An archived file whose object is
 *     gone from the library, or whose local file is missing (removed after
 *     archiving, or never restored), is the only copy left. It is reported as kept
 *     and never planned, and the check is repeated at apply time.
 *   - **Nothing at all** when retention is off, when the disk is not ours, or when
 *     the manifest cannot be read. `readArchiveManifest` degrades to an empty
 *     record, and an empty record has nothing to remove, so a damaged file on a
 *     removable disk disables pruning rather than licensing it.
 *
 * `planArchiveRetention` is the dry run. It is pure with respect to the disk: it
 * reads and returns data, and removing anything requires an explicit second call.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { resolveContainedArchivePath } from './archivePath.js';
import { ARCHIVE_MARKER_FILENAME } from './archiveMarker.js';
import { ensureArchiveDestinationReady } from './archiveDestination.js';
import { ARCHIVE_MANIFEST_FILENAME, readArchiveManifest, readArchiveManifestResult, writeArchiveManifest, type ArchiveManifest } from './archiveManifest.js';
import { cutoffMs } from './archiveAge.js';
import { buildLocalObjectIndex, hasLocalCopy, localPathFor } from './archiveLocalCopy.js';
import { verifyArchivedCopy } from './archiveCopy.js';
import { resolveContainedObjectDir } from '../library/objects.js';
import type { ArchiveConfig } from './archiveConfig.js';

export type RetentionMode = 'whole-object' | 'subframes-only';

export interface RetentionPlanItem {
  folderName: string;
  /** The timestamp the age was measured from: when this object was last
   *  archived. An object still receiving captures therefore stays young. */
  archivedAt: string;
  /** Paths relative to the archive root. */
  files: string[];
  bytes: number;
}

export interface RetentionPlan {
  mode: RetentionMode;
  root: string;
  items: RetentionPlanItem[];
  filesTotal: number;
  bytesTotal: number;
  warnings: string[];
}

export interface RetentionResult {
  removed: number;
  bytesRemoved: number;
  failures: string[];
}

function emptyPlan(mode: RetentionMode, warnings: string[] = []): RetentionPlan {
  return { mode, root: '', items: [], filesTotal: 0, bytesTotal: 0, warnings };
}

/**
 * What retention would remove, without removing anything.
 *
 * Empty means "nothing is due" and also "nothing may be done here", and the
 * warnings say which.
 */
export async function planArchiveRetention(config: ArchiveConfig, now: Date): Promise<RetentionPlan> {
  const mode: RetentionMode = config.retentionSubframesOnly ? 'subframes-only' : 'whole-object';

  // 0 means keep forever, which is the default. Nothing to plan.
  if (config.retentionDays <= 0) return emptyPlan(mode);

  // Nothing is planned against a destination that is not ours: not an unconfigured
  // one, not a disk holding someone else's archive, and not a share that is not
  // connected. Even a `foreign` archive full of our own files is not ours to prune,
  // because the id is what says so.
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) {
    return emptyPlan(mode, [
      readiness.kind === 'unconfigured'
        ? 'No archive destination is configured.'
        : `${readiness.warning} Nothing will be pruned.`,
    ]);
  }
  const root = readiness.root;

  const manifest = readArchiveManifest(root, config.archiveId);
  const cutoff = cutoffMs(config.retentionDays, now);
  const localIndex = buildLocalObjectIndex();

  const items: RetentionPlanItem[] = [];
  const warnings: string[] = [];
  let filesTotal = 0;
  let bytesTotal = 0;

  for (const [folderName, entry] of Object.entries(manifest.objects)) {
    const lastArchivedMs = Date.parse(entry.lastArchivedAt);
    // An unparseable date is treated as "not due" rather than "due", so a bad
    // value cannot make something expire immediately.
    if (!Number.isFinite(lastArchivedMs) || lastArchivedMs > cutoff) continue;

    const chosen = mode === 'subframes-only' ? entry.files.filter(f => f.isSubframe) : entry.files;

    const files: string[] = [];
    let bytes = 0;
    let onlyCopies = 0;
    for (const file of chosen) {
      const archiveRelPath = `${folderName}/${file.relPath}`;
      if (!hasLocalCopy(localIndex, folderName, entry.objectId, file.relPath)) {
        // Nothing in the library duplicates this file, so the archive is the only
        // copy. Pruning it would be deleting the user's data, not tidying a backup.
        onlyCopies++;
        continue;
      }
      const abs = resolveContainedArchivePath(root, ...archiveRelPath.split('/'));
      if (abs === null) {
        warnings.push(`${archiveRelPath}: outside the archive root, so it will not be pruned.`);
        continue;
      }
      let stat: fs.Stats;
      try {
        // lstat, so a path that is now a symlink is reported as what it is rather
        // than as whatever it points at.
        stat = fs.lstatSync(abs);
      } catch {
        // Already gone. Nothing to plan for it.
        continue;
      }
      if (!stat.isFile()) {
        warnings.push(`${archiveRelPath}: no longer a regular file, so it will not be pruned.`);
        continue;
      }
      files.push(archiveRelPath);
      bytes += stat.size;
    }

    if (onlyCopies > 0) {
      warnings.push(`${folderName}: ${onlyCopies} archived file${onlyCopies === 1 ? ' is' : 's are'} the only copy, so ${onlyCopies === 1 ? 'it was' : 'they were'} kept.`);
    }
    if (files.length === 0) continue;
    items.push({ folderName, archivedAt: entry.lastArchivedAt, files, bytes });
    filesTotal += files.length;
    bytesTotal += bytes;
  }

  return { mode, root: root, items, filesTotal, bytesTotal, warnings };
}

/** The archive's own filenames, which no plan may remove. */
function isArchiveBookkeeping(baseName: string): boolean {
  return (
    baseName === ARCHIVE_MARKER_FILENAME ||
    baseName === ARCHIVE_MANIFEST_FILENAME ||
    // Anything else dot-prefixed is not a capture either, and the archive is the
    // only writer of dot-files here.
    baseName.startsWith('.')
  );
}

/**
 * Apply a plan that was previously built or shown to a user.
 *
 * Everything is re-checked rather than trusted: the destination still resolves,
 * the marker still identifies this install's archive, every path is still
 * contained, and every path is still a regular file. A plan is data, and data can
 * be stale or hand-edited.
 */
export async function applyArchiveRetention(
  config: ArchiveConfig,
  plan: RetentionPlan,
): Promise<RetentionResult> {
  if (plan.items.length === 0) return { removed: 0, bytesRemoved: 0, failures: [] };

  // Re-checked here rather than trusted from the plan, which the caller may have
  // been holding while the disk was swapped or the share dropped.
  const readiness = await ensureArchiveDestinationReady(config);
  if (!readiness.ok) {
    return { removed: 0, bytesRemoved: 0, failures: [readiness.warning] };
  }
  if (readiness.root !== plan.root) {
    return {
      removed: 0,
      bytesRemoved: 0,
      failures: ['The archive destination changed since that plan was made, so nothing was removed.'],
    };
  }
  const root = readiness.root;

  const failures: string[] = [];
  const removedRelPaths: string[] = [];
  let removed = 0;
  let bytesRemoved = 0;

  // Rebuilt now rather than trusted from planning: the local file may have been
  // removed since, and then the archived one is the last copy.
  const localIndex = buildLocalObjectIndex();
  const currentManifest = readArchiveManifest(root, config.archiveId);
  const recordedObjectIds = new Map(
    Object.entries(currentManifest.objects).map(([folder, entry]) => [folder, entry.objectId]),
  );
  // What the record names, so a plan that was held or hand-edited cannot reach a
  // file the archive never wrote.
  const recordedPaths = new Set(
    Object.entries(currentManifest.objects).flatMap(([folder, entry]) => entry.files.map(f => `${folder}/${f.relPath}`)),
  );

  for (const item of plan.items) {
    for (const archiveRelPath of item.files) {
      const slash = archiveRelPath.indexOf('/');
      const folderName = slash === -1 ? '' : archiveRelPath.slice(0, slash);
      const relPath = slash === -1 ? archiveRelPath : archiveRelPath.slice(slash + 1);
      if (!hasLocalCopy(localIndex, folderName, recordedObjectIds.get(folderName) ?? '', relPath)) {
        failures.push(`${archiveRelPath}: no local copy exists, so the archived file was kept.`);
        continue;
      }
      if (!recordedPaths.has(archiveRelPath)) {
        failures.push(`${archiveRelPath}: not in the archive record, so it was left alone.`);
        continue;
      }
      const baseName = archiveRelPath.slice(archiveRelPath.lastIndexOf('/') + 1);
      if (isArchiveBookkeeping(baseName)) {
        failures.push(`${archiveRelPath}: refusing to remove the archive's own bookkeeping.`);
        continue;
      }

      const abs = resolveContainedArchivePath(root, ...archiveRelPath.split('/'));
      if (abs === null) {
        failures.push(`${archiveRelPath}: outside the archive root.`);
        continue;
      }

      // "A local file exists" is not "the archive is redundant". If the local file
      // was replaced, truncated or damaged since it was archived, the archived
      // bytes are the good ones, and pruning them is data loss. The same size and
      // digest check that gates local removal has to pass here too. A file already
      // gone from the archive falls through to the branch below instead.
      const localObjectId = localIndex.get(folderName);
      const objDir = localObjectId ? resolveContainedObjectDir(localObjectId) : null;
      const localAbs = localObjectId && objDir ? localPathFor(localObjectId, objDir, relPath) : null;
      if (localAbs === null) {
        failures.push(`${archiveRelPath}: no local copy exists, so the archived file was kept.`);
        continue;
      }
      if (fs.existsSync(abs)) {
        const verification = await verifyArchivedCopy(localAbs, abs);
        if (!verification.ok) {
          failures.push(`${archiveRelPath}: the local file no longer matches the archived copy (${verification.reason ?? 'unverified'}), so the archived file was kept.`);
          continue;
        }
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(abs);
      } catch {
        // Gone since the plan was built. That is the desired end state.
        removedRelPaths.push(archiveRelPath);
        continue;
      }
      if (!stat.isFile()) {
        // Whatever is at this path now is not the file the record described.
        failures.push(`${archiveRelPath}: no longer a regular file, so it was left alone.`);
        continue;
      }

      try {
        await fsp.unlink(abs);
        removed++;
        bytesRemoved += stat.size;
        removedRelPaths.push(archiveRelPath);
      } catch (err) {
        failures.push(`${archiveRelPath}: ${err instanceof Error ? err.message : 'could not be removed'}`);
      }
    }
  }

  // Tidy directories that became empty, innermost first. `rmdir` fails on a
  // non-empty directory, which is what stops this at any folder that still holds
  // something, and the loop never reaches the archive root itself.
  for (const archiveRelPath of removedRelPaths) {
    let dir = path.dirname(path.join(root, ...archiveRelPath.split('/')));
    while (dir !== root && dir.startsWith(root + path.sep)) {
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  // Update the record, so the next plan does not try to prune the same files
  // again. Whole-object removal drops the entry; subframes-only keeps it with the
  // pruned files gone.
  // An unreadable record is left exactly as it is. Reading it as "empty" and writing
  // that back would erase the account of everything still on the disk.
  const current = readArchiveManifestResult(root, config.archiveId);
  if (current.status === 'unreadable') {
    failures.push(`(manifest): the archive record could not be read (${current.reason}), so it was not updated.`);
    return { removed, bytesRemoved, failures };
  }
  const manifest = current.status === 'ok' ? current.manifest : readArchiveManifest(root, config.archiveId);
  const removedSet = new Set(removedRelPaths);
  const next: ArchiveManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    objects: { ...manifest.objects },
  };
  for (const item of plan.items) {
    const entry = next.objects[item.folderName];
    if (!entry) continue;
    const remaining = entry.files.filter(f => !removedSet.has(`${item.folderName}/${f.relPath}`));
    if (remaining.length === 0) delete next.objects[item.folderName];
    else next.objects[item.folderName] = { ...entry, files: remaining };
  }
  try {
    writeArchiveManifest(root, next);
  } catch (err) {
    failures.push(`(manifest): ${err instanceof Error ? err.message : 'could not update the archive record'}`);
  }

  return { removed, bytesRemoved, failures };
}
