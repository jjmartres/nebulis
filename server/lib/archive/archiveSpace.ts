/**
 * Free-space preflight for the archive.
 *
 * The contract lists "filling the archive disk, or the local disk during a restore"
 * as a risk that "needs a preflight free-space check and a clear failure rather than a
 * half-written file". The second half of that was already true: a copy lands under a
 * `.part` name and is only renamed once verified, so a full disk leaves no truncated
 * file wearing a real name. This is the first half.
 *
 * The amount to check is what *still needs copying*, not the size of the whole
 * selection. A re-run over an archive that is already complete copies almost nothing
 * and must not be refused because the disk is nearly full; refusing there would make
 * the guard worse than useless. So a file whose destination already exists at the same
 * size is not counted. A same-size file with different contents would be re-copied and
 * is therefore under-counted, which is the right direction to be wrong in: the copy
 * then fails on ENOSPC and is reported, rather than the preflight blocking a run that
 * would have succeeded.
 *
 * Headroom is deliberately generous. Filling a volume to the last byte is bad on every
 * platform, and on macOS filling the boot volume is disruptive well beyond this
 * application.
 */

import fsp from 'fs/promises';

/** Space to leave free beyond what the run needs. */
export const ARCHIVE_SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;

const STATFS_TIMEOUT_MS = 5_000;

/** Resolve a promise or give up, so a stale network mount cannot hang a run. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Free bytes available to this process at `targetPath`, or null when it cannot be
 * determined.
 *
 * Null means "unknown", and every caller treats unknown as "do not block": an
 * unreadable statfs is not evidence that the disk is full, and a run that refuses
 * because it could not ask is worse than one that tries and reports the failure.
 */
export async function availableBytes(targetPath: string): Promise<number | null> {
  try {
    const stats = await withTimeout(fsp.statfs(targetPath), STATFS_TIMEOUT_MS);
    // `bavail` is blocks available to an unprivileged process, which is what the run
    // actually gets. Not `bfree`, which includes the reserved blocks root may use.
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * Whether a run needing `neededBytes` should proceed.
 *
 * Pure, so the decision can be tested without filling a disk.
 */
export function hasRoomFor(neededBytes: number, available: number | null): boolean {
  if (available === null) return true;
  // A run that would write nothing is never refused. A re-run over a complete archive
  // copies nothing, and blocking it because the disk is nearly full would make this
  // guard actively harmful. The estimate can under-count a same-size file whose
  // contents differ, so a little may still be written; that copy then fails on ENOSPC
  // and is reported, which is a clean outcome rather than a truncated file.
  if (neededBytes === 0) return true;
  return neededBytes + ARCHIVE_SPACE_HEADROOM_BYTES <= available;
}

/**
 * The bytes a run would actually write: the selected sizes whose destination is not
 * already present at the same size.
 *
 * `resolveDestination` is how the caller turns a candidate into a contained path, so
 * this cannot be used to build a path itself.
 */
export async function bytesStillNeeded(
  sizesAndDestinations: Array<{ bytes: number; destination: string }>,
): Promise<number> {
  let needed = 0;
  for (const item of sizesAndDestinations) {
    try {
      const existing = await fsp.stat(item.destination);
      if (existing.isFile() && existing.size === item.bytes) continue;
    } catch {
      // Absent, which is the ordinary case.
    }
    needed += item.bytes;
  }
  return needed;
}
