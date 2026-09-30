import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../server/lib/paths';
import {
  ARCHIVE_MARKER_FILENAME,
  newArchiveId,
  parseArchiveMarker,
  readArchiveMarker,
  writeArchiveMarker,
} from '../../server/lib/archive/archiveMarker';

/**
 * Archive disk identity.
 *
 * The marker is what makes a destination "sticky": the same disk plugged in at a
 * different mount point is still our archive, and a different disk plugged in at
 * the same mount point is not. Getting this wrong is how an archive becomes a
 * second library, or worse, how a retention pass ends up pruning a disk that
 * belongs to something else.
 *
 * Modelled on `libraryPath.ts`'s library marker, with one deliberate difference:
 * that parser returns `null` for both "absent" and "invalid", which is enough for
 * its `isLibraryAvailable()` check but not enough here. The contract requires the
 * states to be distinguishable, because they call for different responses:
 * absent means "set up a new archive", foreign means "offer to adopt", and
 * unreadable or invalid means "refuse and tell the user" rather than silently
 * treating a disk as empty and writing over it.
 */

function scratchDir(prefix = 'nebulis-archive-test-marker-'): string {
  return fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), prefix));
}

describe('parseArchiveMarker', () => {
  it('accepts a well-formed marker and copies its fields', () => {
    const marker = parseArchiveMarker(
      JSON.stringify({ archiveId: 'abc', createdAt: '2026-01-01T00:00:00.000Z', appVersion: '2.1.0' }),
    );
    expect(marker).toEqual({
      archiveId: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      appVersion: '2.1.0',
      note: undefined,
    });
  });

  it('rejects a marker whose archiveId is not a non-empty string', () => {
    // The library marker had exactly this bug: `libraryId: 42` satisfied an
    // `'libraryId' in parsed` test and flowed into an id comparison as a number.
    for (const archiveId of [42, null, '', true, [], {}]) {
      expect(
        parseArchiveMarker(JSON.stringify({ archiveId })),
        `expected archiveId ${JSON.stringify(archiveId)} to be rejected`,
      ).toBeNull();
    }
  });

  it('rejects non-JSON and non-object payloads', () => {
    for (const text of ['', 'not json', '[1,2]', '"a string"', 'null', '42']) {
      expect(parseArchiveMarker(text), `expected ${JSON.stringify(text)} to be rejected`).toBeNull();
    }
  });

  it('ignores unknown fields rather than failing on them', () => {
    // Forward compatibility: a newer build may write fields this one does not
    // know about, and that must not make the disk look foreign.
    const marker = parseArchiveMarker(JSON.stringify({ archiveId: 'abc', futureField: { a: 1 } }));
    expect(marker?.archiveId).toBe('abc');
  });
});

describe('readArchiveMarker — the four states', () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports absent when there is no marker file', () => {
    expect(readArchiveMarker(dir, 'our-id').state).toBe('absent');
  });

  it('reports match when the marker id equals ours', () => {
    writeArchiveMarker(dir, 'our-id');
    const result = readArchiveMarker(dir, 'our-id');
    expect(result.state).toBe('match');
    if (result.state === 'match') expect(result.marker.archiveId).toBe('our-id');
  });

  it('reports foreign, and names the id it found, when the marker belongs to another archive', () => {
    writeArchiveMarker(dir, 'someone-elses-id');
    const result = readArchiveMarker(dir, 'our-id');
    expect(result.state).toBe('foreign');
    // The foreign id is returned so the UI can say which archive it found
    // rather than showing a bare failure.
    if (result.state === 'foreign') expect(result.marker.archiveId).toBe('someone-elses-id');
  });

  it('reports foreign rather than match when we have no id of our own yet', () => {
    // An install with archiving unconfigured must never implicitly adopt a disk
    // that already holds an archive. Adoption is an explicit action.
    writeArchiveMarker(dir, 'existing-id');
    expect(readArchiveMarker(dir, '').state).toBe('foreign');
  });

  it('reports invalid when the file exists but is not a marker we recognise', () => {
    for (const text of ['not json', JSON.stringify({ archiveId: 42 }), JSON.stringify({})]) {
      fs.writeFileSync(path.join(dir, ARCHIVE_MARKER_FILENAME), text, 'utf8');
      expect(
        readArchiveMarker(dir, 'our-id').state,
        `expected ${JSON.stringify(text)} to read as invalid`,
      ).toBe('invalid');
    }
  });

  it('reports unreadable when the marker cannot be read at all', () => {
    // A directory in the marker's place is the portable way to make the read
    // fail with something other than ENOENT (EISDIR on POSIX).
    fs.mkdirSync(path.join(dir, ARCHIVE_MARKER_FILENAME));
    expect(readArchiveMarker(dir, 'our-id').state).toBe('unreadable');
  });

  it('distinguishes unreadable from invalid, which call for different responses', () => {
    // Both mean "do not write here", but only one is the user's fault and only
    // one is fixed by deleting a file, so they must not collapse into one state.
    fs.mkdirSync(path.join(dir, ARCHIVE_MARKER_FILENAME));
    const unreadable = readArchiveMarker(dir, 'our-id').state;
    fs.rmdirSync(path.join(dir, ARCHIVE_MARKER_FILENAME));
    fs.writeFileSync(path.join(dir, ARCHIVE_MARKER_FILENAME), 'garbage', 'utf8');
    const invalid = readArchiveMarker(dir, 'our-id').state;
    expect(unreadable).not.toBe(invalid);
  });
});

describe('reading never mutates the destination', () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not create a marker when none is present', () => {
    readArchiveMarker(dir, 'our-id');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('leaves a foreign marker byte-identical', () => {
    writeArchiveMarker(dir, 'someone-elses-id');
    const file = path.join(dir, ARCHIVE_MARKER_FILENAME);
    const before = fs.readFileSync(file);
    readArchiveMarker(dir, 'our-id');
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('leaves an invalid marker byte-identical', () => {
    const file = path.join(dir, ARCHIVE_MARKER_FILENAME);
    fs.writeFileSync(file, 'garbage', 'utf8');
    const before = fs.readFileSync(file);
    readArchiveMarker(dir, 'our-id');
    expect(fs.readFileSync(file)).toEqual(before);
  });
});

describe('writeArchiveMarker', () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through readArchiveMarker as a match', () => {
    const id = newArchiveId();
    writeArchiveMarker(dir, id);
    const result = readArchiveMarker(dir, id);
    expect(result.state).toBe('match');
  });

  it('records when the archive was created and what wrote it', () => {
    writeArchiveMarker(dir, 'abc');
    const marker = parseArchiveMarker(fs.readFileSync(path.join(dir, ARCHIVE_MARKER_FILENAME), 'utf8'));
    expect(marker?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof marker?.note).toBe('string');
    expect(marker?.note?.length).toBeGreaterThan(0);
  });

  it('overwrites an existing marker only when explicitly asked to', () => {
    // This is the mechanism adoption will use, so it must actually replace.
    writeArchiveMarker(dir, 'old-id');
    writeArchiveMarker(dir, 'new-id');
    expect(readArchiveMarker(dir, 'new-id').state).toBe('match');
    expect(readArchiveMarker(dir, 'old-id').state).toBe('foreign');
  });
});

describe('newArchiveId', () => {
  it('returns a non-empty, unique id', () => {
    const a = newArchiveId();
    const b = newArchiveId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
