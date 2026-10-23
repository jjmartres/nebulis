/**
 * Library — measure sub-frame quality on its own after an import.
 *
 * The import paths report the FITS sub-frames they recorded
 * (`noteImportedSubFrames`); the nights those land in are queued and, once
 * the import has finished (the import lock is free) and nothing new has come
 * in for a moment, measured one night at a time through the regular quality
 * job (subFrameQuality.ts). Only files without fresh cached metrics are
 * measured, so a re-sync of a night costs nothing.
 *
 * Gated by Settings → Library → "Measure sub-frame quality after import"
 * (`autoMeasureSubQuality`, on by default), read when the queue runs.
 */
import path from 'path';
import { log } from '../logger.js';
import { getSettingsData } from '../telescopes.js';
import { FITS_EXTENSIONS, parseFilename } from '../telescopeFiles.js';
import { sessionDateForRow } from './libraryFiles.js';
import { startQualityJob, waitForQualityJob } from './subFrameQuality.js';

/** Quiet period after the last recorded sub before measuring starts. */
const SETTLE_MS = 20_000;

export interface ImportedFileRow {
  objectId: string;
  fileName: string;
  /** Absent when the recorder derives it; the filename decides then. */
  role?: string;
  captureDate?: string | null;
  captureTime?: string | null;
  sessionDateOverride?: string | null;
  sourceId?: string | null;
}

const pending = new Map<string, { objectId: string; night: string }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let isImportBusy: () => boolean = () => false;

/** Lets the import module say when an import is still running, without this
 *  module importing it back (import.ts already depends on this one). */
export function setImportBusyProbe(probe: () => boolean): void {
  isImportBusy = probe;
}

function enabled(): boolean {
  return getSettingsData().autoMeasureSubQuality !== false;
}

function schedule(delay = SETTLE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void drain(); }, delay);
  timer.unref?.();
}

/** Called by the import paths with the rows they just recorded. */
export function noteImportedSubFrames(rows: readonly ImportedFileRow[]): void {
  let added = false;
  for (const row of rows) {
    const role = row.role ?? parseFilename(row.fileName).type;
    if (role !== 'sub' || !FITS_EXTENSIONS.has(path.extname(row.fileName).toLowerCase())) continue;
    const night = sessionDateForRow({
      captureDate: row.captureDate ?? null,
      captureTime: row.captureTime ?? null,
      sessionDateOverride: row.sessionDateOverride ?? null,
      sourceId: row.sourceId ?? null,
    });
    if (!night) continue;
    pending.set(`${row.objectId}\u0000${night}`, { objectId: row.objectId, night });
    added = true;
  }
  if (added && enabled()) schedule();
}

async function drain(): Promise<void> {
  if (running) return;
  if (isImportBusy()) { schedule(); return; }
  if (!enabled()) { pending.clear(); return; }
  running = true;
  try {
    while (pending.size > 0) {
      const [key, item] = pending.entries().next().value!;
      pending.delete(key);
      try {
        const job = startQualityJob(item.objectId, item.night);
        if (job.total > 0) {
          log.info({ objectId: item.objectId, night: item.night, frames: job.total }, '[auto-quality] measuring');
          await waitForQualityJob(item.objectId, item.night);
        }
      } catch (err) {
        log.warn({ objectId: item.objectId, night: item.night, err: err instanceof Error ? err.message : String(err) }, '[auto-quality] failed');
      }
      // A new import started meanwhile: let it run, pick up after it.
      if (isImportBusy()) { schedule(); return; }
    }
  } finally {
    running = false;
  }
}

/** For tests: run the queue now and wait for it to empty. */
export async function flushAutoQualityForTests(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  await drain();
}

/** For tests. */
export function pendingAutoQualityNights(): { objectId: string; night: string }[] {
  return [...pending.values()];
}
