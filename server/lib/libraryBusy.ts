/**
 * One exclusive "the library is being worked on" lock, shared by everything that
 * reads or rewrites a lot of the library at once: copy import and sub-frame sync,
 * linked-folder scans, the archive run, archive restore and pruning, sub-frame
 * purge, Library Health repair and reorganize.
 *
 * Each of those used to check only the parts it knew about (the archive looked at
 * the import flag when it started, nothing looked at the archive), so an archive
 * pass that deleted local sub-frames could overlap an import writing them. Holding
 * one lock for the whole operation is what makes them exclude each other.
 *
 * Dependency-free on purpose, like `libraryMaintenance.ts`: import, the archive and
 * the routes all use it and none of them may end up in an import cycle through it.
 * `libraryMaintenance.ts` (the migration flag) stays separate because it also
 * drives a 503 middleware; a migration is not something to queue behind.
 */

export type LibraryWork =
  | 'import'
  | 'archive'
  | 'restore'
  | 'retention'
  | 'linked-scan'
  | 'purge'
  | 'repair'
  | 'reorganize';

interface Holder {
  kind: LibraryWork;
}

let holder: Holder | null = null;

/**
 * Take the lock. Returns the release function, or null when something else holds
 * it. The release is idempotent and only ever frees the acquisition it came from.
 */
export function acquireLibraryLock(kind: LibraryWork): (() => void) | null {
  if (holder !== null) return null;
  // The object's identity is what a release checks, so a stale release cannot
  // free a newer holder.
  const mine: Holder = { kind };
  holder = mine;
  return () => {
    if (holder === mine) holder = null;
  };
}

/** What is holding the lock right now, or null when the library is free. */
export function currentLibraryWork(): LibraryWork | null {
  return holder?.kind ?? null;
}

export function isLibraryBusy(): boolean {
  return holder !== null;
}

const WORK_LABEL: Record<LibraryWork, string> = {
  import: 'An import or sync',
  archive: 'An archive run',
  restore: 'An archive restore',
  retention: 'Archive pruning',
  'linked-scan': 'A linked folder scan',
  purge: 'A sub-frame purge',
  repair: 'A library repair',
  reorganize: 'A library reorganize',
};

/** The reason a request was refused, in words the user can act on. */
export function libraryBusyMessage(work: LibraryWork | null = currentLibraryWork()): string {
  if (work === null) return 'The library is busy. Try again in a moment.';
  return `${WORK_LABEL[work]} is running. Try again when it finishes.`;
}

/**
 * The 409 body for a refused request. An import keeps the `IMPORT_RUNNING` code the
 * clients already handle; any other holder is `LIBRARY_BUSY` with its own wording,
 * so a scan or an archive run is never reported as an import.
 */
export function libraryBusyRefusal(importMessage: string): { code: string; message: string } {
  const work = currentLibraryWork();
  if (work === null || work === 'import') return { code: 'IMPORT_RUNNING', message: importMessage };
  return { code: 'LIBRARY_BUSY', message: libraryBusyMessage(work) };
}
