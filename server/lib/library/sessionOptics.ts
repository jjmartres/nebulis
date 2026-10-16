/**
 * Which optical train shot a session: the telescope plus, for a rig with
 * several configurations (an OTA used natively and through a reducer), which
 * one. The same target is often imaged through more than one, and their data
 * must not be mixed (different focal length, field and sampling), so the
 * object page and the observations list group nights by it.
 *
 * Same seam as sessionLocation.ts, with the same precedence:
 *
 *  1. An explicit `opticalConfigId` on the session (the user's choice on the
 *     observation page or in the folder import), as long as it belongs to the
 *     session's telescope. Retagging the telescope makes a choice for the old
 *     one moot rather than wrong.
 *  2. The focal length the session's FITS recorded (FOCALLEN), matched to the
 *     telescope's configurations within 5 %. ASIAIR, NINA and the smart
 *     scopes all write it, so most nights sort themselves, including old
 *     nights imported after the reducer went on.
 *  3. The telescope's only configuration, when it has exactly one.
 *
 * Otherwise no configuration, but the FITS focal length is still reported so
 * the UI can say "609 mm" for a rig with no configuration set up.
 *
 * The FITS focal length is cached on `librarySessions` (fileFocalMm /
 * focalResolved): one header read per session, ever, until new files arrive
 * (see invalidateSessionFocal). The configurations are NOT cached: editing a
 * configuration's focal length takes effect on the next read.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { parseFilename } from '../telescopeFiles.js';
import { parseFitsHeader } from '../fitsParser.js';
import { headerNumber } from '../fitsWcs.js';
import { getAllProfiles } from '../telescopes.js';
import { getOpticalConfigsForProfile, type TelescopeOpticalConfig } from '../telescopeOpticalConfigs.js';
import { resolveContainedObjectDir } from './objects.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { resolverFor } from './libraryFiles.js';

export type OpticsSource = 'manual' | 'fits' | 'only';

export interface SessionOptics {
  /** Null when no configuration applies. */
  configId: string | null;
  configName: string | null;
  /** The configuration's focal length, else the FITS one, else null. */
  focalLengthMm: number | null;
  source: OpticsSource | null;
  /** What the FITS recorded, reported even when a choice outranks it. */
  fileFocalMm: number | null;
}

/** The facts on a session row this needs. */
export interface SessionOpticsRow {
  opticalConfigId: string | null;
  fileFocalMm: number | null;
  focalResolved: number;
}

const stmts = {
  read: db.prepare<[string, string], SessionOpticsRow>(
    'SELECT opticalConfigId, fileFocalMm, focalResolved FROM librarySessions WHERE objectId = ? AND date = ?',
  ),
  writeFocal: db.prepare<[number | null, string, string]>(
    'UPDATE librarySessions SET fileFocalMm = ?, focalResolved = 1 WHERE objectId = ? AND date = ?',
  ),
  invalidate: db.prepare<[string, string]>(
    'UPDATE librarySessions SET focalResolved = 0 WHERE objectId = ? AND date = ?',
  ),
  setConfig: db.prepare<[string | null, string, string]>(
    'UPDATE librarySessions SET opticalConfigId = ? WHERE objectId = ? AND date = ?',
  ),
  unresolved: db.prepare<[number], { objectId: string; date: string }>(
    'SELECT objectId, date FROM librarySessions WHERE focalResolved = 0 LIMIT ?',
  ),
};

const FITS_HEADER_BYTES = 28800;
/** Two focal lengths within this ratio are the same optical train: FOCALLEN
 *  is often the nominal value, a reducer is never within 5 % of native. */
const FOCAL_TOLERANCE = 0.05;

/** FOCALLEN (mm) from a FITS header, or null. */
export function readFitsFocal(fitsPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fitsPath, 'r');
    const buf = Buffer.alloc(FITS_HEADER_BYTES);
    const read = fs.readSync(fd, buf, 0, FITS_HEADER_BYTES, 0);
    if (read < 80) return null;
    const header = parseFitsHeader(read === FITS_HEADER_BYTES ? buf : buf.subarray(0, read));
    const focal = headerNumber(header.values, 'FOCALLEN', 'FOCAL');
    return focal !== undefined && focal > 0 && focal < 100_000 ? focal : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * The focal length this session's own FITS recorded, or null. Cache-first:
 * only the first look at a session opens a file. Sub-frames are preferred
 * (a stacked FITS from some software drops the capture keywords).
 */
export function fitsFocalForSession(objectId: string, date: string, cached?: SessionOpticsRow): number | null {
  const row = cached ?? stmts.read.get(objectId, date);
  if (row && row.focalResolved === 1) return row.fileFocalMm;

  const objDir = resolveContainedObjectDir(objectId);
  let focal: number | null = null;
  if (objDir && fs.existsSync(objDir)) {
    const identity = resolverFor(objectId);
    let firstFits: string | null = null;
    let firstSub: string | null = null;
    for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
      const parsed = parseFilename(entry.fileName);
      if (parsed.isThumbnail) continue;
      const ext = parsed.extension?.toLowerCase();
      if (ext !== '.fit' && ext !== '.fits') continue;
      if (identity.session(entry.relPath) !== date) continue;
      firstFits ??= entry.relPath;
      if (identity.role(entry.relPath) === 'sub' || parsed.type === 'sub') {
        firstSub = entry.relPath;
        break;
      }
    }
    const pick = firstSub ?? firstFits;
    focal = pick ? readFitsFocal(path.join(objDir, pick)) : null;
  }
  try { stmts.writeFocal.run(focal, objectId, date); } catch { /* best-effort */ }
  return focal;
}

/** New files on a session may carry a focal length the old ones did not. */
export function invalidateSessionFocal(objectId: string, date: string): void {
  try { stmts.invalidate.run(objectId, date); } catch { /* best-effort */ }
}

/** The configuration a focal length belongs to, or null when none is within
 *  tolerance or two are equally close. */
export function matchConfigByFocal(configs: TelescopeOpticalConfig[], focal: number | null): TelescopeOpticalConfig | null {
  if (focal === null || configs.length === 0) return null;
  let best: TelescopeOpticalConfig | null = null;
  let bestDiff = Infinity;
  let tie = false;
  for (const c of configs) {
    const diff = Math.abs(c.focalLengthMm - focal) / c.focalLengthMm;
    if (diff < bestDiff - 1e-9) {
      best = c;
      bestDiff = diff;
      tie = false;
    } else if (Math.abs(diff - bestDiff) <= 1e-9) {
      tie = true;
    }
  }
  return best && !tie && bestDiff <= FOCAL_TOLERANCE ? best : null;
}

/** Configurations by telescope id, built once for a list. */
export function opticalConfigsByProfile(): Map<string, TelescopeOpticalConfig[]> {
  return new Map(getAllProfiles().map(p => [p.id, getOpticalConfigsForProfile(p.id)]));
}

/**
 * Resolve a session's optics from its row (see the module doc). Pure given
 * the configurations, so list views resolve every night from one lookup;
 * `fileFocalMm` is whatever the caller has (cached or freshly read).
 */
export function resolveSessionOptics(
  telescopeId: string | null,
  row: { opticalConfigId: string | null; fileFocalMm: number | null } | null,
  configsByProfile: Map<string, TelescopeOpticalConfig[]>,
): SessionOptics {
  const fileFocalMm = row?.fileFocalMm ?? null;
  const configs = telescopeId ? configsByProfile.get(telescopeId) ?? [] : [];
  const pick = (c: TelescopeOpticalConfig, source: OpticsSource): SessionOptics => ({
    configId: c.id, configName: c.name, focalLengthMm: c.focalLengthMm, source, fileFocalMm,
  });

  const chosen = row?.opticalConfigId ? configs.find(c => c.id === row.opticalConfigId) : undefined;
  if (chosen) return pick(chosen, 'manual');
  const byFocal = matchConfigByFocal(configs, fileFocalMm);
  if (byFocal) return pick(byFocal, 'fits');
  if (configs.length === 1) return pick(configs[0]!, 'only');
  return { configId: null, configName: null, focalLengthMm: fileFocalMm, source: null, fileFocalMm };
}

/**
 * Key that groups sessions shot through the same optical train: the
 * telescope plus the configuration, or the rounded FITS focal length when no
 * configuration applies (two unconfigured focal lengths must not merge).
 */
export function rigKey(telescopeId: string | null, optics: SessionOptics): string {
  const train = optics.configId ?? (optics.fileFocalMm !== null ? `${Math.round(optics.fileFocalMm)}mm` : '-');
  return `${telescopeId ?? '-'}|${train}`;
}

/**
 * Set (or clear, with null) the optical configuration of a session. Returns
 * false when the session does not exist. The caller checks the config
 * belongs to the session's telescope.
 */
export function setSessionOpticalConfig(objectId: string, date: string, configId: string | null): boolean {
  return stmts.setConfig.run(configId, objectId, date).changes > 0;
}

// ─── Background fill ────────────────────────────────────────────────────────

let backfillRunning = false;

/**
 * Read the FITS focal length of every session not looked at yet, a batch at a
 * time between other work, so the observations list can group the whole
 * library without each night waiting for its object page to be opened.
 * Each session costs one header read, once.
 */
export function backfillSessionFocals(batch = 25): void {
  if (backfillRunning) return;
  backfillRunning = true;
  const step = () => {
    let rows: { objectId: string; date: string }[] = [];
    try {
      rows = stmts.unresolved.all(batch);
      for (const r of rows) fitsFocalForSession(r.objectId, r.date);
    } catch {
      rows = [];
    }
    if (rows.length === batch) setTimeout(step, 50);
    else backfillRunning = false;
  };
  setTimeout(step, 0);
}
