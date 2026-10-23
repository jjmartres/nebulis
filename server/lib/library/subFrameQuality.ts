/**
 * Library — sub-frame quality for one observation (object + night).
 *
 * Ties the pixel measurement (../subQuality.ts) to the library:
 *
 *   - which subs belong to the night (managed files walked off disk through
 *     resolverFor, linked files from their rows, like the observation cards);
 *   - a per-file cache of measurements in `subFrameMetrics`, keyed by the
 *     file's library path and invalidated by size + mtime, so a night is
 *     measured once;
 *   - an in-process background job per night, measuring one file at a time
 *     and yielding between files so requests keep being served;
 *   - the user's manual accept/reject in `subFrameReview`, which wins over
 *     the computed grade;
 *   - grading relative to the night, per FITS FILTER, and a CSV export.
 *
 * Measurement runs on the main thread like the satellite-trail detector does
 * (≈0.3 s for an 8 MP frame); yielding between files keeps that bounded.
 */
import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { log } from '../logger.js';
import { getLibraryDir } from '../libraryPath.js';
import { parseFitsHeader } from '../fitsParser.js';
import { parseFilename, FITS_EXTENSIONS } from '../telescopeFiles.js';
import { trailDetector } from '../trailDetector.js';
import { measureSubFrame, gradeGroup, type SubFrameMeasurement, type SubFrameFlag, type SubFrameGradeLevel } from '../subQuality.js';
import { getLibraryFilesForObject, resolverFor, sessionDateForRow } from './libraryFiles.js';
import { listObjectFiles, getObjectLayout } from './libraryLayout.js';
import { resolveLibraryFile } from './fileResolver.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS subFrameMetrics (
    relPath      TEXT PRIMARY KEY,
    bytes        INTEGER NOT NULL,
    mtimeMs      INTEGER NOT NULL,
    width        INTEGER,
    height       INTEGER,
    background   REAL,
    noise        REAL,
    stars        INTEGER,
    hfr          REAL,
    fwhm         REAL,
    eccentricity REAL,
    filter       TEXT,
    exposureSec  REAL,
    dateObs      TEXT,
    error        TEXT,
    measuredAt   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subFrameReview (
    relPath   TEXT PRIMARY KEY,
    rejected  INTEGER NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

interface MetricsRow extends Partial<SubFrameMeasurement> {
  relPath: string;
  bytes: number;
  mtimeMs: number;
  filter: string | null;
  exposureSec: number | null;
  dateObs: string | null;
  error: string | null;
}

const stmts = {
  getMetrics: db.prepare<[string], MetricsRow>('SELECT * FROM subFrameMetrics WHERE relPath = ?'),
  putMetrics: db.prepare(
    `INSERT OR REPLACE INTO subFrameMetrics
       (relPath, bytes, mtimeMs, width, height, background, noise, stars, hfr, fwhm, eccentricity,
        filter, exposureSec, dateObs, error, measuredAt)
     VALUES (@relPath, @bytes, @mtimeMs, @width, @height, @background, @noise, @stars, @hfr, @fwhm, @eccentricity,
        @filter, @exposureSec, @dateObs, @error, @measuredAt)`,
  ),
  getReview: db.prepare<[string], { rejected: number }>('SELECT rejected FROM subFrameReview WHERE relPath = ?'),
  setReview: db.prepare('INSERT OR REPLACE INTO subFrameReview (relPath, rejected, updatedAt) VALUES (?, ?, ?)'),
  clearReview: db.prepare('DELETE FROM subFrameReview WHERE relPath = ?'),
  folder: db.prepare<[string], { folderName: string }>('SELECT folderName FROM libraryObjects WHERE objectId = ?'),
};

// ─── Which subs belong to the night ─────────────────────────────────────────

export interface NightSubFrame {
  /** Library path (`<folder>/…` or `@src/<id>/…`). */
  relPath: string;
  fileName: string;
  abs: string;
}

export function listNightSubFrames(objectId: string, night: string): NightSubFrame[] {
  const out: NightSubFrame[] = [];
  const isFits = (name: string) => FITS_EXTENSIONS.has(path.extname(name).toLowerCase());

  const folderName = stmts.folder.get(objectId)?.folderName;
  if (folderName) {
    const objDir = path.join(getLibraryDir(), folderName);
    if (fs.existsSync(objDir)) {
      const identity = resolverFor(objectId);
      for (const entry of listObjectFiles(objDir, getObjectLayout(objectId))) {
        if (!isFits(entry.fileName)) continue;
        if (identity.role(entry.relPath) !== 'sub' && parseFilename(entry.fileName).type !== 'sub') continue;
        if (identity.session(entry.relPath) !== night) continue;
        out.push({ relPath: `${folderName}/${entry.relPath}`, fileName: entry.fileName, abs: path.join(objDir, entry.relPath) });
      }
    }
  }
  for (const row of getLibraryFilesForObject(objectId)) {
    if (!row.sourceId || row.missingSince || !isFits(row.fileName)) continue;
    if (row.role !== 'sub' && parseFilename(row.fileName).type !== 'sub') continue;
    if (sessionDateForRow(row) !== night) continue;
    const resolved = resolveLibraryFile(row.relPath);
    if (resolved) out.push({ relPath: row.relPath, fileName: row.fileName, abs: resolved.abs });
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
}

// ─── Measuring one file ─────────────────────────────────────────────────────

/** Cached metrics when size + mtime still match, else null. */
function cachedMetrics(sub: NightSubFrame): MetricsRow | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(sub.abs); } catch { return null; }
  const row = stmts.getMetrics.get(sub.relPath);
  return row && row.bytes === stat.size && row.mtimeMs === Math.floor(stat.mtimeMs) ? row : null;
}

export function measureAndStore(sub: NightSubFrame): MetricsRow {
  const stat = fs.statSync(sub.abs);
  const base = {
    relPath: sub.relPath,
    bytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    measuredAt: new Date().toISOString(),
  };
  let row: MetricsRow;
  try {
    const buf = fs.readFileSync(sub.abs);
    const header = parseFitsHeader(buf.subarray(0, Math.min(buf.length, 2880 * 10)));
    const rawExp = header.values['EXPTIME'] ?? header.values['EXPOSURE'];
    const exp = typeof rawExp === 'number' ? rawExp : Number.parseFloat(String(rawExp ?? ''));
    const filter = header.values['FILTER'];
    const dateObs = header.values['DATE-OBS'];
    const m = measureSubFrame(trailDetector.parseFitsPixels(buf));
    row = {
      ...base, ...m,
      filter: filter === undefined ? null : String(filter).trim() || null,
      exposureSec: Number.isFinite(exp) && exp > 0 ? exp : null,
      dateObs: dateObs === undefined ? null : String(dateObs),
      error: null,
    };
  } catch (err) {
    row = {
      ...base,
      width: undefined, height: undefined, background: undefined, noise: undefined,
      stars: undefined, hfr: undefined, fwhm: undefined, eccentricity: undefined,
      filter: null, exposureSec: null, dateObs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  stmts.putMetrics.run({
    width: null, height: null, background: null, noise: null, stars: null, hfr: null, fwhm: null, eccentricity: null,
    ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === undefined ? null : v])),
  });
  return row;
}

// ─── Background job per night ───────────────────────────────────────────────

export interface QualityJob {
  total: number;
  done: number;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  cancelled: boolean;
}

const jobs = new Map<string, QualityJob>();
const jobKey = (objectId: string, night: string) => `${objectId}\u0000${night}`;

export function getQualityJob(objectId: string, night: string): QualityJob | null {
  return jobs.get(jobKey(objectId, night)) ?? null;
}

/** Start (or return the running) measurement job for a night. Only files
 *  without fresh cached metrics are measured, unless `force`. */
export function startQualityJob(objectId: string, night: string, opts: { force?: boolean } = {}): QualityJob {
  const key = jobKey(objectId, night);
  const existing = jobs.get(key);
  if (existing?.running) return existing;

  const subs = listNightSubFrames(objectId, night).filter(s => opts.force || !cachedMetrics(s));
  const job: QualityJob = {
    total: subs.length, done: 0, running: subs.length > 0,
    startedAt: new Date().toISOString(), finishedAt: subs.length > 0 ? null : new Date().toISOString(), cancelled: false,
  };
  jobs.set(key, job);

  const step = (i: number) => {
    if (job.cancelled || i >= subs.length) {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      return;
    }
    try {
      measureAndStore(subs[i]);
    } catch (err) {
      log.warn({ relPath: subs[i].relPath, err: err instanceof Error ? err.message : String(err) }, '[subFrameQuality] measure failed');
    }
    job.done = i + 1;
    setImmediate(() => step(i + 1));
  };
  if (job.running) setImmediate(() => step(0));
  return job;
}

export function cancelQualityJob(objectId: string, night: string): boolean {
  const job = jobs.get(jobKey(objectId, night));
  if (!job?.running) return false;
  job.cancelled = true;
  return true;
}

/** Test helper: wait for a night's job to finish. */
export async function waitForQualityJob(objectId: string, night: string): Promise<void> {
  while (jobs.get(jobKey(objectId, night))?.running) await new Promise(r => setImmediate(r));
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface SubFrameQualityRow {
  relPath: string;
  fileName: string;
  filter: string | null;
  exposureSec: number | null;
  dateObs: string | null;
  measured: boolean;
  error: string | null;
  stars: number | null;
  hfr: number | null;
  fwhm: number | null;
  eccentricity: number | null;
  background: number | null;
  noise: number | null;
  grade: SubFrameGradeLevel | null;
  flags: SubFrameFlag[];
  weight: number | null;
  /** The user's decision, or null to follow the grade. */
  manual: 'accepted' | 'rejected' | null;
  /** Final: manual decision when set, else rejected when graded poor. */
  accepted: boolean;
}

export interface SubFrameQualityReport {
  objectId: string;
  night: string;
  job: QualityJob | null;
  total: number;
  measured: number;
  accepted: number;
  /** Medians per filter over measured subs. */
  groups: { filter: string | null; count: number; hfr: number | null; stars: number | null }[];
  frames: SubFrameQualityRow[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function getQualityReport(objectId: string, night: string): SubFrameQualityReport {
  const subs = listNightSubFrames(objectId, night);
  const rows: SubFrameQualityRow[] = subs.map(sub => {
    const m = cachedMetrics(sub);
    const review = stmts.getReview.get(sub.relPath);
    const ok = m !== null && m.error === null && m.stars != null && m.background != null;
    return {
      relPath: sub.relPath,
      fileName: sub.fileName,
      filter: m?.filter ?? null,
      exposureSec: m?.exposureSec ?? null,
      dateObs: m?.dateObs ?? null,
      measured: ok,
      error: m?.error ?? null,
      stars: ok ? m.stars ?? null : null,
      hfr: ok ? m.hfr ?? null : null,
      fwhm: ok ? m.fwhm ?? null : null,
      eccentricity: ok ? m.eccentricity ?? null : null,
      background: ok ? m.background ?? null : null,
      noise: ok ? m.noise ?? null : null,
      grade: null,
      flags: [],
      weight: null,
      manual: review ? (review.rejected ? 'rejected' : 'accepted') : null,
      accepted: review ? !review.rejected : true,
    };
  });

  const byFilter = new Map<string, SubFrameQualityRow[]>();
  for (const r of rows.filter(r => r.measured)) {
    const k = r.filter ?? '';
    const g = byFilter.get(k);
    if (g) g.push(r); else byFilter.set(k, [r]);
  }
  const groups: SubFrameQualityReport['groups'] = [];
  for (const [k, group] of byFilter) {
    const grades = gradeGroup(group.map(r => ({ stars: r.stars!, hfr: r.hfr, eccentricity: r.eccentricity, background: r.background! })));
    group.forEach((r, i) => {
      r.grade = grades[i].grade;
      r.flags = grades[i].flags;
      r.weight = grades[i].weight;
      if (r.manual === null) r.accepted = r.grade !== 'poor';
    });
    const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
    groups.push({
      filter: k || null,
      count: group.length,
      hfr: round(median(group.map(r => r.hfr).filter((v): v is number => v !== null)), 2),
      stars: round(median(group.map(r => r.stars!)), 0),
    });
  }

  return {
    objectId,
    night,
    job: getQualityJob(objectId, night),
    total: rows.length,
    measured: rows.filter(r => r.measured).length,
    accepted: rows.filter(r => r.accepted).length,
    groups: groups.sort((a, b) => (a.filter ?? '').localeCompare(b.filter ?? '')),
    frames: rows,
  };
}

/** Set (true/false) or clear (null) the user's decision for one sub. */
export function setSubFrameReview(relPath: string, rejected: boolean | null): void {
  if (rejected === null) stmts.clearReview.run(relPath);
  else stmts.setReview.run(relPath, rejected ? 1 : 0, new Date().toISOString());
}

const CSV_COLUMNS = [
  'file', 'path', 'filter', 'exposure_s', 'date_obs', 'stars', 'hfr', 'fwhm', 'eccentricity',
  'background', 'noise', 'grade', 'flags', 'weight', 'decision', 'accepted',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One line per sub; `accepted` is the column a processing script filters on. */
export function qualityReportCsv(report: SubFrameQualityReport): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of report.frames) {
    lines.push([
      r.fileName, r.relPath, r.filter, r.exposureSec, r.dateObs, r.stars, r.hfr, r.fwhm, r.eccentricity,
      r.background, r.noise, r.grade, r.flags.join(' '), r.weight, r.manual ?? 'auto', r.accepted ? 1 : 0,
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
