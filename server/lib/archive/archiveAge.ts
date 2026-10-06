/**
 * Shared "N days old" cutoff math for the archive feature.
 *
 * Two different features measure age against two different clocks: retention
 * measures from when a file was archived (`archiveRetention.ts`), and the
 * copy-side minimum-age filter measures from when a file was captured
 * (`archiveSelect.ts`). They should not share a cutoff computation with different
 * inputs baked in, only the arithmetic itself, so a day count means the same
 * number of milliseconds in both places.
 */

export const DAY_MS = 86_400_000;

/** The instant `days` days before `now`. A timestamp at or before this is "due":
 *  old enough for whatever `days` gates. */
export function cutoffMs(days: number, now: Date): number {
  return now.getTime() - days * DAY_MS;
}
