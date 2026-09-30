/**
 * Decide what a file already sitting at an import's destination name actually is.
 *
 * The folder import used to treat "a file with this name is already there" as "this source file was
 * already imported", or, when the sizes differed, as "a truncated copy from an interrupted run" to
 * overwrite in place. Two different files that happen to share a name and a night (per-night
 * subfolders that reuse names, two backups merged) hit one of those two branches, so the second
 * file was either skipped or silently overwrote the first.
 *
 * The answer comes from the bytes:
 *  - identical: the same content is already there. A harmless duplicate, skip it.
 *  - partial:   the existing file is a strict prefix of the source. An interrupted earlier copy, heal it.
 *  - different: another file owns this name. Keep both; the caller gives the newcomer a numeric suffix.
 */
import fs from 'fs';

export type ExistingCopyVerdict = 'identical' | 'partial' | 'different';

const CHUNK = 1024 * 1024;

export async function classifyExistingCopy(existingPath: string, sourcePath: string): Promise<ExistingCopyVerdict> {
  const existing = await fs.promises.stat(existingPath);
  const source = await fs.promises.stat(sourcePath);
  if (existing.size > source.size) return 'different';

  const a = await fs.promises.open(existingPath, 'r');
  try {
    const b = await fs.promises.open(sourcePath, 'r');
    try {
      const bufA = Buffer.allocUnsafe(CHUNK);
      const bufB = Buffer.allocUnsafe(CHUNK);
      let offset = 0;
      while (offset < existing.size) {
        const want = Math.min(CHUNK, existing.size - offset);
        const [ra, rb] = await Promise.all([
          a.read(bufA, 0, want, offset),
          b.read(bufB, 0, want, offset),
        ]);
        if (ra.bytesRead !== want || rb.bytesRead !== want) return 'different';
        if (!bufA.subarray(0, want).equals(bufB.subarray(0, want))) return 'different';
        offset += want;
      }
    } finally { await b.close(); }
  } finally { await a.close(); }

  return existing.size === source.size ? 'identical' : 'partial';
}
