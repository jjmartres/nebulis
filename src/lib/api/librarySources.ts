import { fetchJSON } from './client';
import type { ImportSkip } from './library';

/** Mirrors ScanSourceResult in server/lib/library/librarySources.ts. */
export interface LinkScanSession {
  date: string;
  fileCount: number;
  bytes: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Where the best of this night's dates came from. */
  source: 'fits' | 'filename' | 'folder' | 'mtime' | 'none';
}

export interface LinkScanObject {
  objectId: string;
  fileCount: number;
  bytes: number;
  sessions: LinkScanSession[];
  unsortedCount: number;
  catalogMatch: {
    objectId: string;
    name: string;
    type: string;
    constellation: string | null;
    magnitude: number | null;
  } | null;
  /** Other catalog designations for the same object ("C1" for NGC188). */
  aliases: string[];
  /** Names the user's own folder labels add ("Polarissima Cluster"). */
  nicknames: string[];
  /** The folder the object came from, as the user knows it ("C 5", "STARTRAILS"). */
  sourceName: string;
  /** Every directory (relative to the scan root, '' for loose files in the root) holding this object's files. */
  dirPaths: string[];
  /** False when the object shares a directory with another object, so it cannot be re-assigned on its own. */
  reassignable: boolean;
}

export interface LinkScanUnresolved {
  dirPath: string;
  fileCount: number;
  bytes: number;
}

export interface LinkScanResult {
  rootPath: string;
  objects: LinkScanObject[];
  unresolved: LinkScanUnresolved[];
  /** Files found but not linked, and why. Same shape and renderer as the copy import's. */
  skipped: ImportSkip[];
  /** Folders left out because they hold no observations. */
  excludedFolders: string[];
  containerDirs: string[];
  disagreements: Array<{ relPath: string; folderObjectId: string; filenameObjectId: string }>;
  totals: { objects: number; files: number; bytes: number };
  truncated: boolean;
  /** Some folders were nested too deep to read. */
  depthLimited: boolean;
}

/** A review-screen decision for one directory, relative to the scan root. */
export type LinkOverride =
  | { dirPath: string; action: 'assign'; objectId: string }
  | { dirPath: string; action: 'ignore' };

export interface LinkedSource {
  id: string;
  label: string;
  rootPath: string;
  enabled: boolean;
  lastScanAt: string | null;
  createdAt: string;
  fileCount: number;
  objectCount: number;
  bytes: number;
  missingCount: number;
  /** The folder could not be read right now (drive unplugged, share down). */
  offline: boolean;
  /** Minutes between automatic rescans. Null is a one-time link, rescanned only by hand. */
  refreshIntervalMin: number | null;
}

export interface RescanResult {
  sourceId: string;
  offline: boolean;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  removed: number;
  truncated: boolean;
  depthLimited: boolean;
  objects: number;
}

interface LinkOptions {
  importSubFrames?: boolean;
  importFits?: boolean;
}

interface CommitOptions extends LinkOptions {
  /** Minutes between automatic rescans; omit for a one-time link. */
  refreshIntervalMin?: number | null;
}

/** Dry run: what would linking this folder index? Reads only. */
export const scanLinkFolder = (rootPath: string, opts: LinkOptions = {}) =>
  fetchJSON<LinkScanResult>('/library/sources/scan', {
    method: 'POST',
    body: JSON.stringify({ rootPath, ...opts }),
  });

/** Link the folder in place. Copies nothing. */
export const linkFolder = (rootPath: string, label: string, overrides: LinkOverride[], opts: CommitOptions = {}) =>
  fetchJSON<{ sourceId: string; objectsLinked: number; filesLinked: number }>('/library/sources', {
    method: 'POST',
    body: JSON.stringify({ rootPath, label, overrides, ...opts }),
  });

export const getLinkedSources = () =>
  fetchJSON<{ sources: LinkedSource[] }>('/library/sources').then(r => r.sources);

/** Change a linked folder's name and/or refresh schedule in one call. `refreshIntervalMin: null` is one-time. */
export const updateLinkedSource = (id: string, update: { label?: string; refreshIntervalMin?: number | null }) =>
  fetchJSON<{ id: string; label: string; refreshIntervalMin: number | null }>(`/library/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });

export const rescanLinkedSource = (id: string) =>
  fetchJSON<RescanResult>(`/library/sources/${encodeURIComponent(id)}/rescan`, { method: 'POST' });

export const unlinkSource = (id: string) =>
  fetchJSON<{ filesUnlinked: number; objectsRetired: string[] }>(`/library/sources/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
