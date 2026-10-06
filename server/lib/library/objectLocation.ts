/**
 * Library — "where do these files actually live" resolution.
 *
 * Powers the object and session "Show file location" panels: the absolute path
 * on disk (or the network share) for an object folder or one session's folder.
 *
 * Paths are for a person to copy into a file manager or terminal. Nothing here
 * reads or writes files beyond an existence check.
 */
import fs from 'node:fs';
import path from 'node:path';

import db from '../db.js';
import { getLibraryDir, isNetworkLocation, getLibraryLocationInfo } from '../libraryPath.js';
import { getFolderName, resolveContainedObjectDir } from './objects.js';
import { getLocalFiles } from './observations.js';

export interface DiskLocation {
  /** '<folder>' or '<folder>/<session subdir>', relative to the library root. */
  relPath: string;
  /** Absolute path a file manager / terminal opens. */
  path: string;
  exists: boolean;
}

/** Where a linked source's files for this object (or session) sit on the
 *  user's own disk. The files are not in the managed library at all. */
export interface LinkedLocation {
  sourceId: string;
  sourceLabel: string;
  /** Absolute folder holding the files, inside the linked source's root. */
  path: string;
  exists: boolean;
}

export interface ObjectLocation {
  storage: 'local' | 'network';
  /** Absolute library root. Network locations show the UNC / mount path here. */
  libraryRoot: string;
  /** The object folder itself. */
  object: DiskLocation;
  /** One session's folder, when a date is given and it could be resolved. */
  session: DiskLocation | null;
  /** One entry per linked source that holds files for this object (or, when a
   *  date is given, that session). Empty for an object that is only managed. */
  linked: LinkedLocation[];
}

/** Directory portion of a relative file path, '' for a file at the folder root. */
function dirOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

/** The session's own subdirectory under the object folder, or '' when the
 *  session's files sit directly in the object folder (the flat SeeStar case). */
function sessionSubdir(objectId: string, date: string): string {
  const files = getLocalFiles(objectId, date).filter(f => !f.isThumbnail);
  if (files.length === 0) return '';
  const dirs = new Set(files.map(f => dirOf(f.path)));
  // f.path is '<folder>/<rest>'; strip the leading folder segment.
  const folderName = getFolderName(objectId);
  const rels = [...dirs].map(d =>
    d === folderName ? '' : d.startsWith(folderName + '/') ? d.slice(folderName.length + 1) : d,
  );
  // Use the shared prefix so a session split across sub-subdirs still resolves
  // to the directory that contains them all.
  return rels.reduce((a, b) => {
    if (a === '' || b === '') return '';
    const as = a.split('/');
    const bs = b.split('/');
    const out: string[] = [];
    for (let i = 0; i < Math.min(as.length, bs.length); i++) {
      if (as[i] !== bs[i]) break;
      out.push(as[i]);
    }
    return out.join('/');
  });
}

function diskLocation(relPath: string): DiskLocation {
  const abs = path.join(getLibraryDir(), relPath);
  let exists = false;
  try {
    exists = fs.existsSync(abs);
  } catch {
    exists = false;
  }
  return { relPath, path: abs, exists };
}

/** The deepest folder shared by every path, '' when they only share the root. */
function commonDir(dirs: string[]): string {
  if (dirs.length === 0) return '';
  const split = dirs.map(d => (d === '' ? [] : d.split('/')));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    if (split.some(parts => parts[i] !== split[0][i])) break;
    out.push(split[0][i]);
  }
  return out.join('/');
}

function linkedLocations(objectId: string, date?: string): LinkedLocation[] {
  const rows = db.prepare<[string, string | null, string | null], { sourceId: string; sourcePath: string; label: string; rootPath: string }>(
    `SELECT f.sourceId AS sourceId, f.sourcePath AS sourcePath, s.label AS label, s.rootPath AS rootPath
       FROM libraryFiles f JOIN librarySources s ON s.id = f.sourceId
      WHERE f.objectId = ? AND f.sourceId IS NOT NULL AND f.sourcePath IS NOT NULL
        AND (? IS NULL OR f.captureDate = ?)`,
  ).all(objectId, date ?? null, date ?? null);

  const bySource = new Map<string, { label: string; rootPath: string; dirs: string[] }>();
  for (const r of rows) {
    const entry = bySource.get(r.sourceId) ?? { label: r.label, rootPath: r.rootPath, dirs: [] };
    entry.dirs.push(dirOf(r.sourcePath));
    bySource.set(r.sourceId, entry);
  }
  return [...bySource.entries()].map(([sourceId, e]) => {
    const abs = path.join(e.rootPath, commonDir(e.dirs));
    let exists = false;
    try { exists = fs.existsSync(abs); } catch { /* unreadable */ }
    return { sourceId, sourceLabel: e.label, path: abs, exists };
  });
}

export async function getObjectLocation(objectId: string, date?: string): Promise<ObjectLocation> {
  // Only ever describe a directory that is genuinely inside the library. The
  // folder name falls back to the raw id on a DB miss, so `path.join(root, id)`
  // used to answer with an absolute path outside the library plus an exists
  // oracle for it. An unresolvable id now reports an empty, non-existent
  // location instead of a real path.
  const objDir = resolveContainedObjectDir(objectId);
  const folderName = objDir ? getFolderName(objectId) : '';
  const object = objDir
    ? diskLocation(folderName)
    : { relPath: '', path: '', exists: false };

  let session: DiskLocation | null = null;
  if (date && objDir) {
    const sub = sessionSubdir(objectId, date);
    session = diskLocation(sub ? `${folderName}/${sub}` : folderName);
  }

  let networkRoot: string | null = null;
  if (isNetworkLocation()) {
    const { host, share, subpath } = (await getLibraryLocationInfo()).network;
    if (host) {
      networkRoot = `\\\\${host}\\${share}${subpath ? `\\${subpath.replace(/^[\\/]+/, '')}` : ''}`;
    }
  }

  return {
    storage: isNetworkLocation() ? 'network' : 'local',
    libraryRoot: networkRoot ?? getLibraryDir(),
    object,
    session,
    linked: linkedLocations(objectId, date),
  };
}
