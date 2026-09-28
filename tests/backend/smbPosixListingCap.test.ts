import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { smbListDir } from '../../server/lib/smb.posix';

/**
 * HIGH 15, from auditreport.md: `smbListDir` ran
 * `execFileAsync('smbclient', args, { timeout: 15000 })` with no `maxBuffer`,
 * so Node's 1 MiB default applied to the whole `ls` listing that is parsed from
 * stdout. A larger directory aborted the child with
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which `classifySmbError` reduced to a
 * generic "SMB connection failed" — so a big flat folder (generic/ASIAIR
 * layouts, or _archive) silently discovered nothing.
 *
 * Runs the REAL `execFile` against a fake `smbclient` on PATH that prints a
 * listing comfortably over 1 MiB, so the test exercises Node's actual stdout
 * cap rather than asserting on an option object.
 */
const ENTRY_COUNT = 20_000; // ~1.5 MB of listing, well past the old 1 MiB cap
const PROFILE = { hostname: '10.0.0.5', shareName: 'EMMC Images' };

let fakeBinDir = '';
let originalPath: string | undefined;

beforeAll(() => {
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-fake-smbclient-'));
  const script = path.join(fakeBinDir, 'smbclient');
  // Emits the listing on stdout and exits 0, like a successful `smbclient ls`.
  fs.writeFileSync(
    script,
    `#!/bin/sh\n` +
      `i=0\n` +
      `while [ $i -lt ${ENTRY_COUNT} ]; do\n` +
      `  printf '  M%06d_Stacked_150_10.0s_LP.jpg      A   %08d  Sat Mar 29 01:23:45 2026\\n' "$i" "$((i + 1000))"\n` +
      `  i=$((i + 1))\n` +
      `done\n`,
    'utf8',
  );
  fs.chmodSync(script, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('posix smbclient listing cap', () => {
  it('parses a listing larger than the 1 MiB default stdout cap', async () => {
    const entries = await smbListDir('MyWorks', PROFILE);
    expect(entries.length).toBe(ENTRY_COUNT);

    // Spot-check the parsed shape (the fake writes M000000, M000001, ...).
    expect(entries[0].name).toBe('M000000_Stacked_150_10.0s_LP.jpg');
    expect(entries[ENTRY_COUNT - 1].name).toBe(`M${String(ENTRY_COUNT - 1).padStart(6, '0')}_Stacked_150_10.0s_LP.jpg`);
    expect(entries[0].type).toBe('file');
    expect(entries[0].size).toBe(1000);
  });
});
