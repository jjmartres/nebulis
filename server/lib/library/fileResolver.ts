/**
 * Library — the one place a raw `relPath` string becomes an absolute path.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before this module, the containment check every read route needs (`path.resolve`
 * onto the library root, then confirm the result still starts with that root) was
 * duplicated across `GET /file` (via `getLocalFile` in `objects.ts`), `GET
 * /video`, `GET /file/thumbnail`, `GET /fits-thumbnail`, `GET /tiff-thumbnail`
 * (`server/routes/library.ts`), plus a few more found during the full audit
 * (`gallery.ts`'s `safeGalleryImagePath`, `objects.ts`'s `getLocalFitsHeader`,
 * `POST /satellite/detect`) — several of them unauthenticated.
 *
 * ── The `@src/` branch and why it never joins a request path onto a source root ──
 * A linked (non-copied) library source's files live outside `getLibraryDir()`
 * entirely, on whatever drive the user pointed Nebulis at. Their `libraryFiles.
 * relPath` values use the reserved form `@src/<sourceId>/<opaque-suffix>`
 * (`LINKED_SOURCE_DIR_NAME`, `archiveFolders.ts`) so they can flow through every
 * existing `?path=` call site unchanged.
 *
 * `GET /library/file` and its thumbnail/video/FITS siblings are unauthenticated
 * (`server/middleware/auth.ts`'s bypass list), so this resolver never trusts the
 * request's own string beyond deciding *which branch* to take. For a `@src/`
 * path, the ONLY way to get an absolute path is: look up that exact string in
 * `libraryFiles.relPath` (a unique column), and if a row exists, use ITS stored
 * `sourceId` and `sourcePath` — values Nebulis itself wrote during a scan/rescan,
 * never derived from the incoming request — to find the source and build the
 * real path. A `@src/` string with no matching row (a guess, a stale id, a
 * traversal attempt appended after a real prefix) resolves to nothing. This is
 * why `attributeFiles`/`sourceWalk` compute `sourcePath` once, up front, rather
 * than this module re-deriving "the part after `@src/<id>/`" from whatever the
 * caller handed it — that would mean trusting the request's own path math for a
 * security boundary, exactly what the five-plus duplicated checks above already
 * got wrong once by copy-paste drift, not by design.
 */
import path from 'path';
import { getLibraryDir } from '../libraryPath.js';
import { LINKED_SOURCE_DIR_NAME } from './archiveFolders.js';
import db from '../db.js';

export interface ResolvedLibraryFile {
  /** Absolute filesystem path. Guaranteed to be inside the library root (or,
   *  for a linked source, inside that source's own root). */
  abs: string;
  /** Which linked source owns this file, or null for the managed library. */
  sourceId: string | null;
}

/** Thrown by a mutating library operation (delete, rename, ...) when it's
 *  asked to act on a linked source's file. Nebulis never writes to, renames,
 *  or deletes a file it didn't copy — see the contract's Open Question 1 and
 *  the module doc above. Route handlers catch this by name and answer with a
 *  403 and this stable code, rather than the generic 500 an unexpected error
 *  gets; a refusal is not a server failure. */
export class LinkedFileReadOnlyError extends Error {
  readonly code = 'LINKED_FILE_READONLY';
  constructor(relPath: string) {
    super(`"${relPath}" belongs to a linked library source. Deleting a file from a linked folder needs an explicit confirmation.`);
    this.name = 'LinkedFileReadOnlyError';
  }
}

const LINKED_PREFIX = `${LINKED_SOURCE_DIR_NAME}/`;

const getLinkedFileRow = db.prepare<[string], { sourceId: string | null; sourcePath: string | null }>(
  'SELECT sourceId, sourcePath FROM libraryFiles WHERE relPath = ?',
);
const getSourceRow = db.prepare<[string], { rootPath: string; enabled: number }>(
  'SELECT rootPath, enabled FROM librarySources WHERE id = ?',
);

/** Contain `candidate` (already `path.resolve`d) inside `root`, trailing-separator
 *  compared so a sibling directory whose name merely starts with `root`'s can't
 *  satisfy a bare `startsWith`. Shared by both branches below. */
function isContainedIn(candidate: string, root: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(rootWithSep);
}

function resolveLinkedFile(relPath: string): ResolvedLibraryFile | null {
  const row = getLinkedFileRow.get(relPath);
  if (!row || !row.sourceId || !row.sourcePath) return null; // no such indexed file — refuse, don't guess

  const source = getSourceRow.get(row.sourceId);
  if (!source || !source.enabled) return null; // unknown or disabled source — refuse

  const root = path.resolve(source.rootPath);
  const abs = path.resolve(root, row.sourcePath);
  // Defense in depth: sourcePath is Nebulis's own recorded value (see the module
  // doc), never the request's, but a source root that changed on disk since the
  // scan (or a symlink inside it) still gets a real containment check rather
  // than trusting the stored value blindly.
  if (abs !== root && !isContainedIn(abs, root)) return null;
  return { abs, sourceId: row.sourceId };
}

/**
 * Resolve a library-relative path (as carried in a `libraryFiles.relPath` value,
 * or a request's raw `?path=`) to an absolute path, refusing anything that would
 * resolve outside the library root — or, for a `@src/<sourceId>/...` value,
 * outside that linked source's own root. See the module doc for why the `@src/`
 * branch never joins the request path directly.
 *
 * Returns null on refusal rather than throwing, matching the call sites this
 * replaces (each treated "outside the root" / "no such file" as "reject the
 * request", not an exceptional error).
 */
export function resolveLibraryFile(relPath: string): ResolvedLibraryFile | null {
  if (relPath.startsWith(LINKED_PREFIX)) return resolveLinkedFile(relPath);

  const LIBRARY_DIR = getLibraryDir();
  const absPath = path.resolve(LIBRARY_DIR, relPath);
  if (!isContainedIn(absPath, LIBRARY_DIR)) return null;
  return { abs: absPath, sourceId: null };
}
