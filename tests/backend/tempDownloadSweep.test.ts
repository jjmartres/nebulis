import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';

/**
 * MEDIUM 2, from auditreport.md: temp download ZIPs
 * (`os.tmpdir()/nebulis-<uuid>.zip`) were leaked two ways.
 *
 *  1. Eviction at the 200-entry cap dropped the map entry without unlinking
 *     `meta.filePath`, and the 10-minute sweeper only iterates entries still in
 *     the map, so those files were never reclaimed.
 *  2. The map is in-memory, so a restart orphaned every ZIP the previous process
 *     had handed out: the tokens died with the process and nothing ever looked
 *     at the files again.
 *
 * This file covers the boot sweep, which has to run at MODULE LOAD (before the
 * router is imported) to be useful. `vi.hoisted` creates the fixtures first.
 */
const fixtures = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const _crypto = require('crypto') as typeof import('crypto');

  const orphanUuid = _crypto.randomUUID();
  const siblingUuid = _crypto.randomUUID();
  const dir = _os.tmpdir();

  // A previous process's leftover ZIP (name shape the route writes).
  const orphan = _path.join(dir, `nebulis-${orphanUuid}.zip`);
  // A non-UUID name with the same prefix: must NOT be swept (someone else could
  // own it, and the sweep is deliberately narrow).
  const sibling = _path.join(dir, `nebulis-${siblingUuid}-manual.zip`);
  // An unrelated file: obviously untouched.
  const unrelated = _path.join(dir, `nebulis-${siblingUuid}.txt`);

  _fs.writeFileSync(orphan, 'previous process leftover');
  _fs.writeFileSync(sibling, 'keep me');
  _fs.writeFileSync(unrelated, 'keep me too');

  return { orphan, sibling, unrelated, orphanUuid, siblingUuid };
});

// Importing the router runs the boot sweep as a module side effect.
await import('../../server/routes/library');

afterAll(() => {
  for (const p of [fixtures.orphan, fixtures.sibling, fixtures.unrelated]) {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
});

describe('temp download ZIP lifecycle', () => {
  it('sweeps an orphaned nebulis-<uuid>.zip left by a previous process', () => {
    expect(fixtures.orphanUuid).not.toBe(fixtures.siblingUuid); // distinct fixtures
    expect(fs.existsSync(fixtures.orphan)).toBe(false);
  });

  it('leaves a same-prefix file with a non-UUID name alone', () => {
    expect(fs.existsSync(fixtures.sibling)).toBe(true);
  });

  it('leaves non-zip files alone', () => {
    expect(fs.existsSync(fixtures.unrelated)).toBe(true);
  });
});
