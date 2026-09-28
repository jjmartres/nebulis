import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';

// Redirect DATA_DIR / LIBRARY_DIR to a temp dir before any server module loads
// (paths.ts captures them at import time). Mirrors folderImport.test.ts.
const TEST_DATA_DIR = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-importlock-test-'));
  process.env.DATA_DIR = dir;
  return dir;
});

// selectActiveTransport runs before the inner try/catch in both runImport and
// syncSessionSubFrames. Before the Phase 2 fix, a throw here propagated all
// the way out with nobody releasing the lock, permanently 409-ing every
// future import until a server restart.
vi.mock('../../server/lib/telescopeTransports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/telescopeTransports')>();
  return {
    ...actual,
    selectActiveTransport: () => { throw new Error('simulated selectActiveTransport failure'); },
  };
});

import { runImport, syncSessionSubFrames, claimImportLock, releaseImportLock, getImportStatus, forceReleaseStaleLock } from '../../server/lib/library/import';
import { createProfile } from '../../server/lib/telescopes';

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('import lock — unleakable claim/release', () => {
  it('runImport releases the lock even when selectActiveTransport throws before the inner try', async () => {
    const profile = createProfile({ name: 'Throws SeeStar', kind: 'other', hostname: '10.0.0.5' });

    // Route handlers claim the lock before dispatching; simulate that here.
    expect(claimImportLock()).toBe(true);

    await expect(
      runImport(undefined, undefined, { telescopeId: profile.id }),
    ).rejects.toThrow('simulated selectActiveTransport failure');

    // The lock must be released, not stuck — a fresh claim must succeed.
    expect(claimImportLock()).toBe(true);
    releaseImportLock();
  });

  it('syncSessionSubFrames releases the lock even when selectActiveTransport throws before the inner try', async () => {
    const profile = createProfile({ name: 'Throws SeeStar 2', kind: 'other', hostname: '10.0.0.6' });

    expect(claimImportLock()).toBe(true);

    await expect(
      syncSessionSubFrames('M42', '2026-06-21', { telescopeId: profile.id }),
    ).rejects.toThrow('simulated selectActiveTransport failure');

    expect(claimImportLock()).toBe(true);
    releaseImportLock();
  });
});

/**
 * HIGH 14, from auditreport.md. The two tests above only pass because a fresh
 * process has `importStatus.runId === null`: `releaseImportLock(null)` compares
 * `null !== importStatus.runId`, which is false against null, so it releases by
 * accident. With a runId left over from an earlier run the comparison is
 * `null !== '<stale id>'`, the release early-returns, and the lock stays held
 * until the stale-lock watchdog fires. The precondition is therefore a
 * NON-NULL runId on the shared status, which is what these tests pin.
 */
describe('import lock — owner id exists from the moment the lock is held', () => {
  it('claimImportLock mints a runId for the owner', () => {
    // Pre-fix this was null until a run function's own status reset, which is
    // exactly the window in which a throw leaked the lock.
    expect(claimImportLock()).toBe(true);
    const id = getImportStatus().runId;
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    releaseImportLock(id);
    expect(getImportStatus().running).toBe(false);
  });

  it('releases with the claimed id even when a previous run left a stale one behind', () => {
    // Run 1 claims and releases, leaving its id on the shared status.
    expect(claimImportLock()).toBe(true);
    const first = getImportStatus().runId;
    releaseImportLock(first);

    // Run 2 claims (minting its own id), then "throws before its status reset":
    // the outer finally releases with the id it captured at try-entry.
    expect(claimImportLock()).toBe(true);
    const second = getImportStatus().runId;
    expect(second).not.toBe(first);
    releaseImportLock(second);

    // Released, so the next claim succeeds. Pre-fix this was where a wedged
    // lock showed up as `false`.
    expect(getImportStatus().running).toBe(false);
    expect(claimImportLock()).toBe(true);
    releaseImportLock();
  });

  it('a force-released run waking up later cannot release a newer run’s lock', () => {
    // The invariant the runId guard exists to protect, unchanged by the fix:
    // the watchdog force-releases a hung run, a new run claims, then the old
    // run's finally fires with its stale id and must be a no-op.
    expect(claimImportLock()).toBe(true);
    const stale = getImportStatus().runId;

    forceReleaseStaleLock('simulated watchdog release');
    expect(getImportStatus().running).toBe(false);

    expect(claimImportLock()).toBe(true);
    const current = getImportStatus().runId;
    expect(current).not.toBe(stale);

    releaseImportLock(stale);
    expect(getImportStatus().running).toBe(true); // still the newer run's lock
    releaseImportLock(current);
    expect(getImportStatus().running).toBe(false);
  });
});
