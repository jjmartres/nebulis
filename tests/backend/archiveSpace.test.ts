import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../server/lib/paths';
import {
  ARCHIVE_SPACE_HEADROOM_BYTES,
  availableBytes,
  bytesStillNeeded,
  hasRoomFor,
} from '../../server/lib/archive/archiveSpace';

/**
 * The free-space preflight.
 *
 * The contract lists filling the archive disk as a risk that "needs a preflight
 * free-space check and a clear failure rather than a half-written file". The clear
 * failure was already covered by the `.part` discipline; this is the preflight.
 *
 * The decision is a pure function so it can be tested without filling a disk, which
 * matters: a test that needs a full volume is a test that never runs. `bytesStillNeeded`
 * is exercised against a real temporary directory, because the whole point of it is the
 * filesystem lookup.
 */

const created: string[] = [];

function scratchDir(prefix = 'nebulis-archive-test-space-'): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('hasRoomFor', () => {
  it('allows a run that fits with headroom to spare', () => {
    expect(hasRoomFor(1_000, ARCHIVE_SPACE_HEADROOM_BYTES + 1_000)).toBe(true);
  });

  it('refuses a run that would not leave the headroom', () => {
    // Fits exactly, but with nothing left over. Filling a volume to the last byte is
    // the thing the headroom exists to prevent.
    expect(hasRoomFor(1_000, ARCHIVE_SPACE_HEADROOM_BYTES + 999)).toBe(false);
  });

  it('refuses a run far larger than the disk', () => {
    expect(hasRoomFor(500 * 1024 ** 3, 100 * 1024 ** 3)).toBe(false);
  });

  it('allows a run when the free space could not be determined', () => {
    // An unreadable statfs is not evidence that the disk is full. A run that refuses
    // because it could not ask is worse than one that tries and reports the failure.
    expect(hasRoomFor(Number.MAX_SAFE_INTEGER, null)).toBe(true);
  });

  it('allows a no-op run on a disk with almost nothing free', () => {
    // A re-run over a complete archive copies nothing, and must not be blocked by a
    // disk that is nearly full: that would make the guard worse than useless.
    expect(hasRoomFor(0, 1)).toBe(true);
  });
});

describe('bytesStillNeeded', () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir();
  });

  it('counts a file whose destination does not exist', async () => {
    const needed = await bytesStillNeeded([{ bytes: 100, destination: path.join(dir, 'absent.bin') }]);
    expect(needed).toBe(100);
  });

  it('does not count a file already present at the same size', async () => {
    const destination = path.join(dir, 'present.bin');
    fs.writeFileSync(destination, 'x'.repeat(100));
    expect(await bytesStillNeeded([{ bytes: 100, destination }])).toBe(0);
  });

  it('counts a file present at the wrong size, because it will be re-copied', async () => {
    const destination = path.join(dir, 'short.bin');
    fs.writeFileSync(destination, 'x'.repeat(10));
    expect(await bytesStillNeeded([{ bytes: 100, destination }])).toBe(100);
  });

  it('sums across files', async () => {
    const destination = path.join(dir, 'present.bin');
    fs.writeFileSync(destination, 'x'.repeat(100));
    const needed = await bytesStillNeeded([
      { bytes: 100, destination },
      { bytes: 250, destination: path.join(dir, 'absent-a.bin') },
      { bytes: 1, destination: path.join(dir, 'absent-b.bin') },
    ]);
    expect(needed).toBe(251);
  });

  it('counts a directory sitting where the file belongs, because a copy would fail there', async () => {
    const destination = path.join(dir, 'adir');
    fs.mkdirSync(destination);
    expect(await bytesStillNeeded([{ bytes: 100, destination }])).toBe(100);
  });
});

describe('availableBytes', () => {
  it('reports free space for a real directory', async () => {
    const dir = scratchDir();
    const free = await availableBytes(dir);
    expect(free).not.toBeNull();
    expect(free as number).toBeGreaterThan(0);
  });

  it('reports null for a path that cannot be read, rather than guessing', async () => {
    expect(await availableBytes(path.join(DATA_DIR, 'does-not-exist-anywhere'))).toBeNull();
  });
});
