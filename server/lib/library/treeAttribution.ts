/**
 * Linked-library folders — file-first object attribution.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `folderScan.ts`'s `collectObjectSources` decides which *folders* are objects,
 * then takes everything under them. That works when the object level is always
 * exactly one hop below the chosen root, which is true of a telescope's own
 * output but not of a library a user has organised by hand: a real report had
 * `MyWorks/1. Seestar S50/1. Caldwell Objects/C 1 - Polarissima Cluster/...`,
 * three folders deep, and the old logic read the root's direct children —
 * "1. Seestar S50" — as the objects.
 *
 * This module inverts the question: instead of deciding which folders are
 * objects, it decides an object for every FILE, by walking upward from the
 * file until something identifies one. Folder depth stops mattering, because
 * nothing here assumes the object sits at a fixed distance from the root.
 *
 * Pure: takes a flat list of relative paths (posix separators, already
 * filtered to real, importable files by the caller — see `sourceWalk.ts`) and
 * returns an attribution per file. No filesystem access, so the same fixtures
 * exercise the exact logic that will run against a real 300 GB tree.
 */
import { identifyObjectFromFolderName } from './objectIdentification.js';
import { isSubFolder, normalizeObjectId } from '../telescopeFiles.js';
import { targetFromFileName, isNonObjectFolder, telescopeKindFromFolderName } from './objectDiscovery.js';
import { extractTargetFromSessionFolder, isDwarfSessionFolder } from '../walkers/dwarfWalker.js';
import { getStartrailsObjectId, isStartrailsFolder } from './dwarfStartrails.js';
import type { TelescopeKind } from '../types/telescopeKind.js';

export type AttributionSource = 'override' | 'folder' | 'filename' | 'custom';

export type AttributionOverride =
  | { action: 'assign'; objectId: string }
  | { action: 'ignore' };

export interface AttributionOptions {
  /** Per-directory decisions the review screen recorded for *this* scan,
   *  keyed by the directory's path relative to the scan root (posix, '' for
   *  the root itself). Checked nearest-ancestor-first, ahead of every other
   *  signal. Not persisted across a later rescan — see contract Release 1
   *  scope: that persistence is `librarySourceOverrides`, a later release. */
  overrides?: ReadonlyMap<string, AttributionOverride>;
}

export interface AttributedFile {
  relPath: string;
  /** Canonical library objectId (e.g. "M31"), or null when nothing identifies
   *  this file and it isn't part of a single-object custom folder either. */
  objectId: string | null;
  source: AttributionSource | null;
  /** Nearest device-model ancestor folder's kind, e.g. from "Seestar S50 Pro". */
  telescopeKind: TelescopeKind | null;
  /** Set when a folder-identified file's own filename names a different
   *  object. The folder wins (policy: the user's own organisation over the
   *  device's filename), but the disagreement is surfaced rather than
   *  silently dropped. */
  disagreement: { folderObjectId: string; filenameObjectId: string } | null;
  /** True for a calibration/junk ancestor or an 'ignore' override: this file
   *  is deliberately left out, distinct from merely unresolved. */
  excluded: boolean;
}

export interface AttributionResult {
  files: AttributedFile[];
  /** Directory paths (posix, relative to the scan root, '' excluded since the
   *  root itself is never reported as a container) whose descendants resolve
   *  to two or more distinct objects. Informational: the review screen uses
   *  this to explain why a directory isn't shown as an object, but nothing in
   *  this module *consumes* it as an input — a directory is never treated as
   *  "the container" until after every file's own signals are exhausted. */
  containers: Set<string>;
  /** Folder names that identified each object, for learning nicknames from
   *  ("C 1 - Polarissima Cluster"). Folder-identified objects only. */
  folderNames: Map<string, Set<string>>;
  /** Human name for each custom (uncatalogued) objectId, keyed by that id. The
   *  id itself is space-free, because the library's boot migration strips
   *  spaces from any objectId and would otherwise rename it out from under a
   *  rescan; the folder's own spelling survives here for display. */
  customNames: Map<string, string>;
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function segmentsOf(dirPath: string): string[] {
  return dirPath === '' ? [] : dirPath.split('/');
}

/** Ancestor directory paths of `dirPath`, nearest first, down to and including
 *  the root (`''`). `dirPath` itself is included as the first entry. */
function ancestorsNearestFirst(dirPath: string): string[] {
  const segments = segmentsOf(dirPath);
  const out: string[] = [];
  for (let i = segments.length; i >= 0; i--) {
    out.push(segments.slice(0, i).join('/'));
  }
  return out;
}

/** The nearest ancestor directory (including `dirPath` itself) that is not
 *  itself a device-model folder. Used only for the container/custom fallback,
 *  so a bare device folder full of stray files doesn't spawn a custom object
 *  literally named after the telescope. */
function meaningfulAncestorDir(dirPath: string): string {
  const segments = segmentsOf(dirPath);
  for (let i = segments.length; i > 0; i--) {
    // A `_sub` folder is the raw-frame companion of the object folder above
    // it, never an object of its own. Left alone it minted a second, junk
    // object ("C2025 A6_sub") beside the real one for any target the catalog
    // does not name.
    if (isSubFolder(segments[i - 1])) continue;
    if (!telescopeKindFromFolderName(segments[i - 1])) {
      return segments.slice(0, i).join('/');
    }
  }
  return '';
}

interface FolderClimbResult {
  objectId: string | null;
  source: 'override' | 'folder' | null;
  excluded: boolean;
  /** The folder name that identified the object, when the signal was a folder. */
  folderName?: string;
}

/** Climb from the file's immediate parent up to the scan root, nearest first.
 *  The first ancestor that decides anything (an override, a junk/calibration
 *  folder, or a folder name that identifies a catalog object) wins; anything
 *  that decides nothing is transparent and the climb continues past it. */
function climbForFolderSignal(
  dirPath: string,
  overrides: ReadonlyMap<string, AttributionOverride>,
): FolderClimbResult {
  const segments = segmentsOf(dirPath);
  for (let depth = segments.length; depth >= 0; depth--) {
    const ancestorPath = segments.slice(0, depth).join('/');
    // An override is a decision about a folder and everything beneath it that nothing nearer decides,
    // with one exception: the ROOT's override ('') covers only the files sitting directly in the root.
    // The review screen offers it for the root's own loose files; inherited by the whole tree it would
    // also swallow or relabel every subfolder that resolved on its own (Planetary_Photo/...).
    const override = depth > 0 || segments.length === 0 ? overrides.get(ancestorPath) : undefined;
    if (override) {
      return override.action === 'ignore'
        ? { objectId: null, source: null, excluded: true }
        : { objectId: override.objectId, source: 'override', excluded: false };
    }
    if (depth === 0) break; // the root itself carries no folder name to test
    const name = segments[depth - 1];
    // A Dwarf STARTRAILS folder holds captures that observe no target: each subfolder is one capture, and
    // the copy import folds all of them into one shared "DWARF Star Trails" object. Do the same here, for a
    // file that sits inside a capture folder. A file loose in STARTRAILS itself stays excluded, exactly as
    // the copy import leaves it, and so does anything under a non-observation folder above STARTRAILS.
    if (isStartrailsFolder(name) && depth < segments.length) {
      if (segments.slice(0, depth - 1).some(isNonObjectFolder)) return { objectId: null, source: null, excluded: true };
      return { objectId: getStartrailsObjectId(), source: 'folder', excluded: false };
    }
    if (isNonObjectFolder(name)) return { objectId: null, source: null, excluded: true };
    const dwarfTarget = dwarfSessionTarget(name);
    const identified = identifyObjectFromFolderName(dwarfTarget ?? name);
    if (identified) {
      // A folder that names an object does not rescue a file from a non-observation folder ABOVE it
      // (RESTACKED/M31/..., startrails/M42/...): the whole subtree holds no observations, exactly as the
      // folder-import wizard treats it at every level.
      if (segments.slice(0, depth - 1).some(isNonObjectFolder)) return { objectId: null, source: null, excluded: true };
      return { objectId: identified.targetObjectId, source: 'folder', excluded: false, folderName: dwarfTarget ?? name };
    }
  }
  return { objectId: null, source: null, excluded: false };
}

/** Nearest device-model ancestor's telescope kind, or null. Independent of
 *  `climbForFolderSignal`: a device folder is transparent to object
 *  identification but still worth tagging (Step 5 stamps it onto the
 *  resulting session), so this scans every ancestor regardless of where the
 *  folder-signal climb stopped. */
function nearestTelescopeKind(dirPath: string): TelescopeKind | null {
  const segments = segmentsOf(dirPath);
  for (let i = segments.length - 1; i >= 0; i--) {
    const kind = telescopeKindFromFolderName(segments[i]);
    if (kind) return kind;
  }
  return null;
}

/** The target a Dwarf session folder names ("DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_..." ->
 *  "C2025R3PANSTARRS"), or null for any other folder. The copy import groups every session of one target
 *  into one object by exactly this rule; reading the whole folder name instead made each session its own
 *  object and buried the target behind "EXP_15_GAIN_60_<timestamp>". */
function dwarfSessionTarget(folderName: string): string | null {
  return isDwarfSessionFolder(folderName) ? extractTargetFromSessionFolder(folderName) : null;
}

/** The nearest Dwarf session folder at or above `dirPath`, as its target, or null. A file nested inside a
 *  session folder still belongs to that session's target. */
function nearestDwarfTarget(dirPath: string): string | null {
  const segments = segmentsOf(dirPath);
  for (let i = segments.length - 1; i >= 0; i--) {
    const target = dwarfSessionTarget(segments[i]);
    if (target) return target;
  }
  return null;
}

/** The object a filename alone names, canonicalized through the same catalog
 *  resolution `identifyObjectFromFolderName` uses for folder names — a raw
 *  parsed target like "C 1" or "NGC 6910" goes through identical designation
 *  and alias handling either way, so "M 31" always means the same object
 *  whether it came from a folder or a filename. */
function filenameSignal(fileName: string): string | null {
  const target = targetFromFileName(fileName);
  if (!target) return null;
  return identifyObjectFromFolderName(target)?.targetObjectId ?? null;
}

export function attributeFiles(
  relPaths: readonly string[],
  options: AttributionOptions = {},
): AttributionResult {
  const overrides = options.overrides ?? new Map<string, AttributionOverride>();

  interface WorkingFile {
    relPath: string;
    dirPath: string;
    fileName: string;
    objectId: string | null;
    source: AttributionSource | null;
    telescopeKind: TelescopeKind | null;
    disagreement: { folderObjectId: string; filenameObjectId: string } | null;
    excluded: boolean;
    folderName?: string;
  }

  const working: WorkingFile[] = relPaths.map(relPath => {
    const dirPath = dirOf(relPath);
    const fileName = relPath.slice(dirPath.length > 0 ? dirPath.length + 1 : 0);
    const telescopeKind = nearestTelescopeKind(dirPath);

    const climb = climbForFolderSignal(dirPath, overrides);
    if (climb.excluded) {
      return {
        relPath, dirPath, fileName, telescopeKind,
        objectId: null, source: null, disagreement: null, excluded: true,
      };
    }

    const fromFilename = filenameSignal(fileName);

    if (climb.objectId) {
      const disagreement = climb.source === 'folder' && fromFilename && fromFilename !== climb.objectId
        ? { folderObjectId: climb.objectId, filenameObjectId: fromFilename }
        : null;
      return {
        relPath, dirPath, fileName, telescopeKind,
        objectId: climb.objectId, source: climb.source, disagreement, excluded: false,
        folderName: climb.folderName,
      };
    }

    if (fromFilename) {
      return {
        relPath, dirPath, fileName, telescopeKind,
        objectId: fromFilename, source: 'filename', disagreement: null, excluded: false,
      };
    }

    // Neither signal resolved. Left as tentatively unresolved; the
    // container/custom pass below decides its fate from its neighbours.
    return {
      relPath, dirPath, fileName, telescopeKind,
      objectId: null, source: null, disagreement: null, excluded: false,
    };
  });

  // ── Directory descendant-object sets, for the container/custom pass and the
  //    informational `containers` output. Built once from every file that
  //    already resolved an objectId (folder or filename signal), attributing
  //    it to every ancestor directory including the root.
  const descendantObjects = new Map<string, Set<string>>();
  for (const file of working) {
    if (!file.objectId || file.excluded) continue;
    for (const ancestor of ancestorsNearestFirst(file.dirPath)) {
      const set = descendantObjects.get(ancestor) ?? new Set<string>();
      set.add(file.objectId);
      descendantObjects.set(ancestor, set);
    }
  }

  const containers = new Set<string>();
  for (const [dirPath, objects] of descendantObjects) {
    if (dirPath !== '' && objects.size >= 2) containers.add(dirPath);
  }

  // Still-unresolved files: fold into their nearest meaningful ancestor's lone
  // object, mint a custom object if that ancestor has no resolved descendants
  // at all, or leave unresolved if that ancestor is a container (>=2 objects).
  //
  // Two different folders can share a basename ("MyWorks/A/Comet" and
  // "MyWorks/B/Comet"), so the custom id is keyed by the full directory path
  // first and only the *display* name is the basename; a collision on that
  // display name gets the same disambiguating "(2)" suffix folderScan.ts's
  // collectObjectSources already uses for the same reason.
  const customObjectIdByDir = new Map<string, string>();
  const customNameUseCount = new Map<string, number>();
  const customNames = new Map<string, string>();
  const folderNames = new Map<string, Set<string>>();
  for (const f of working) {
    if (!f.objectId || !f.folderName) continue;
    const set = folderNames.get(f.objectId) ?? new Set<string>();
    set.add(f.folderName);
    folderNames.set(f.objectId, set);
  }
  for (const file of working) {
    if (file.objectId !== null || file.excluded) continue;

    const dir = meaningfulAncestorDir(file.dirPath);
    const objects = descendantObjects.get(dir);

    if (objects && objects.size === 1) {
      file.objectId = [...objects][0];
      file.source = 'custom'; // joined an existing object via the folder, not named by it
      continue;
    }
    if (objects && objects.size >= 2) {
      continue; // a real container: stays unresolved, not folded into any one object
    }

    // Zero resolved descendants at this level: this folder (or the scan root,
    // for dir === '') is its own uncatalogued object. Every session folder of
    // one Dwarf target is the same object, so those share a key (and the
    // target is the display name) instead of one object per session.
    const dwarfTarget = nearestDwarfTarget(file.dirPath);
    const customKey = dwarfTarget ? `dwarf:${normalizeObjectId(dwarfTarget).toLowerCase()}` : dir;
    let objectId = customObjectIdByDir.get(customKey);
    if (!objectId) {
      const segments = segmentsOf(dir);
      const baseName = dwarfTarget ?? (segments.length > 0 ? segments[segments.length - 1] : 'Unsorted');
      const idBase = normalizeObjectId(baseName);
      const uses = (customNameUseCount.get(idBase) ?? 0) + 1;
      customNameUseCount.set(idBase, uses);
      objectId = uses === 1 ? idBase : `${idBase}_${uses}`;
      customObjectIdByDir.set(customKey, objectId);
      customNames.set(objectId, uses === 1 ? baseName : `${baseName} (${uses})`);
    }
    file.objectId = objectId;
    file.source = 'custom';
  }

  return {
    files: working.map(f => ({
      relPath: f.relPath,
      objectId: f.objectId,
      source: f.source,
      telescopeKind: f.telescopeKind,
      disagreement: f.disagreement,
      excluded: f.excluded,
    })),
    containers,
    folderNames,
    customNames,
  };
}
