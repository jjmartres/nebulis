/**
 * Whether the local library still holds a file the archive also holds.
 *
 * One definition, shared by the browser (to say what restore can bring back), by
 * retention (which may only prune an archived file that duplicates a local one) and
 * by local removal. Retention used to trust the manifest alone, so an object
 * deleted from the library, or subframes removed locally after archiving, left the
 * archive as the only copy and the next retention pass deleted it.
 */

import fs from 'fs';
import path from 'path';

import { getLibraryObjectNames, resolveContainedObjectDir } from '../library/objects.js';
import { getLibraryDir } from '../libraryPath.js';
import { LINKED_SOURCE_DIR_NAME } from '../library/archiveFolders.js';

/** Folder name to live object id, for the objects the library currently has. */
export type LocalObjectIndex = Map<string, string>;

export function buildLocalObjectIndex(): LocalObjectIndex {
  const index: LocalObjectIndex = new Map();
  for (const object of getLibraryObjectNames()) index.set(object.folderName, object.objectId);
  return index;
}

/** Where a recorded file would live in the library, or null when it is not inside
 *  its own object folder. The second check matters: `resolveContainedObjectDir`
 *  alone allows a sibling object reached through `..`. */
export function localPathFor(objectId: string, objDir: string, relPath: string): string | null {
  const segments = relPath.split('/');
  if (segments.length === 0 || segments.some(s => s === '' || s === '.' || s === '..')) return null;
  const abs = resolveContainedObjectDir(objectId, ...segments);
  if (!abs || !abs.startsWith(objDir + path.sep)) return null;
  return abs;
}

/**
 * Where a file of a top-level library folder that is NOT an object would live: `_archive/` calibration frames, the
 * shared `RESTACKED/`, or a folder that is no longer an object. The archive records these with an empty `objectId`.
 *
 * Returns null unless the folder name is one ordinary segment (not dot-prefixed, not the linked-source namespace)
 * and the result is a strict descendant of that folder, inside the library. A manifest is a file on a removable
 * disk, so both names in it are untrusted input.
 */
export function rootFolderPathFor(folderName: string, relPath: string): string | null {
  if (!folderName || folderName.startsWith('.') || folderName === LINKED_SOURCE_DIR_NAME) return null;
  if (folderName.includes('/') || folderName.includes('\\') || path.basename(folderName) !== folderName) return null;
  const segments = relPath.split('/');
  if (segments.length === 0 || segments.some(s => s === '' || s === '.' || s === '..')) return null;
  const root = path.resolve(getLibraryDir());
  const folder = path.resolve(root, folderName);
  if (!folder.startsWith(root + path.sep)) return null;
  const abs = path.resolve(folder, ...segments);
  return abs.startsWith(folder + path.sep) ? abs : null;
}

export function isRegularFile(filePath: string | null): boolean {
  if (filePath === null) return false;
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * True only when the object is still in the library under this folder name and the
 * file is a regular file in its folder.
 *
 * `recordedObjectId` is what the manifest says lived in the folder when it was
 * archived. A different live object under the same folder name is not the object
 * that was archived, so its files do not count as a copy. An empty recorded id
 * (written by an older build) falls back to the folder name alone.
 */
export function hasLocalCopy(
  index: LocalObjectIndex,
  folderName: string,
  recordedObjectId: string,
  relPath: string,
): boolean {
  const objectId = index.get(folderName);
  // Not an object: a top-level library folder recorded with no object id.
  if (!objectId) return recordedObjectId === '' && isRegularFile(rootFolderPathFor(folderName, relPath));
  if (recordedObjectId !== '' && recordedObjectId !== objectId) return false;
  const objDir = resolveContainedObjectDir(objectId);
  if (!objDir) return false;
  return isRegularFile(localPathFor(objectId, objDir, relPath));
}
