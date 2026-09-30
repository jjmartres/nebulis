import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../server/lib/paths';
import { getLibraryDir } from '../../server/lib/libraryPath';
import {
  ARCHIVE_NETWORK_MOUNT_DIR,
  resolveNetworkArchiveRoot,
  uncRootOf,
} from '../../server/lib/archive/archiveNetwork';
import { isWithinRoot, resolveContainedArchivePath } from '../../server/lib/archive/archivePath';
import { resolveArchiveDestination } from '../../server/lib/archive/archiveDestination';
import {
  DEFAULT_ARCHIVE_CONFIG,
  type ArchiveConfig,
  type ArchiveNetworkConfig,
} from '../../server/lib/archive/archiveConfig';

/**
 * Containment for a network archive destination.
 *
 * The archive's retention pass deletes whatever the destination's manifest names
 * under the root it is given, so this is the highest-ranked risk in the contract:
 * the root is *derived* on this path (mount directory plus a share subpath) rather
 * than typed by the user and validated as one string. A subpath that climbs out, or
 * a symlink inside the share pointing elsewhere, would move the root.
 *
 * The local half of the rule is asserted here too, through the dispatcher, because
 * the point of a dispatcher is that it did not weaken the rule it shares.
 */

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function network(overrides: Partial<ArchiveNetworkConfig> = {}): ArchiveNetworkConfig {
  return { host: 'nas.local', share: 'Archive', domain: '', username: '', hasPassword: false, subpath: '', ...overrides };
}

function configWith(overrides: Partial<ArchiveConfig>): ArchiveConfig {
  return { ...DEFAULT_ARCHIVE_CONFIG, ...overrides };
}

beforeEach(() => {
  fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
});

describe('resolveNetworkArchiveRoot — what it refuses', () => {
  it('refuses a destination with no server or no share', () => {
    expect(resolveNetworkArchiveRoot(network({ host: '' }))).toEqual({ ok: false, reason: 'incomplete' });
    expect(resolveNetworkArchiveRoot(network({ share: '   ' }))).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('refuses a subpath that climbs out of the share', () => {
    setPlatform('darwin');
    for (const subpath of ['..', '../..', 'Nebulis/../../etc', 'a/../../../b']) {
      expect(resolveNetworkArchiveRoot(network({ subpath })), subpath).toEqual({
        ok: false,
        reason: 'invalid-subpath',
      });
    }
  });

  it('refuses a subpath that is absolute in either platform spelling', () => {
    setPlatform('darwin');
    for (const subpath of ['/etc', '\\Windows', 'C:\\Windows', 'C:/Windows']) {
      expect(resolveNetworkArchiveRoot(network({ subpath })), subpath).toEqual({
        ok: false,
        reason: 'invalid-subpath',
      });
    }
  });

  it('refuses a subpath that a symlink inside the mount directory points outside', () => {
    // The case a purely lexical check misses: "starts with the mount directory" is
    // true for the string and false for the directory it names.
    setPlatform('darwin');
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });
    const outside = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), 'nebulis-archive-escape-'));
    const link = path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'escape');
    fs.symlinkSync(outside, link, 'dir');

    try {
      expect(resolveNetworkArchiveRoot(network({ subpath: 'escape' }))).toEqual({
        ok: false,
        reason: 'escapes-mount',
      });
      // And a path *through* the link, which is the shape a real share would have.
      expect(resolveNetworkArchiveRoot(network({ subpath: 'escape/deeper' }))).toEqual({
        ok: false,
        reason: 'escapes-mount',
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveNetworkArchiveRoot — what it accepts', () => {
  it('resolves to the mount directory plus the subpath on macOS', () => {
    setPlatform('darwin');
    expect(resolveNetworkArchiveRoot(network({ subpath: 'Nebulis-Archive' }))).toEqual({
      ok: true,
      root: path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Nebulis-Archive'),
      kind: 'mount',
    });
  });

  it('resolves the share root when there is no subpath', () => {
    setPlatform('darwin');
    expect(resolveNetworkArchiveRoot(network({ subpath: '' }))).toEqual({
      ok: true,
      root: ARCHIVE_NETWORK_MOUNT_DIR,
      kind: 'mount',
    });
  });

  it('builds a UNC path on Windows, which is absolute there', () => {
    setPlatform('win32');
    const result = resolveNetworkArchiveRoot(network({ subpath: 'Nebulis-Archive' }));
    expect(result).toEqual({
      ok: true,
      root: '\\\\nas.local\\Archive\\Nebulis-Archive',
      kind: 'unc',
    });
    // The contract's claim, asserted rather than assumed: a UNC destination must be
    // absolute rather than refused as a relative path.
    expect(path.win32.isAbsolute(result.ok ? result.root : '')).toBe(true);
  });

  it('normalises a Windows-style subpath on either platform', () => {
    setPlatform('darwin');
    expect(resolveNetworkArchiveRoot(network({ subpath: 'Nebulis\\Archive' }))).toEqual({
      ok: true,
      root: path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Nebulis/Archive'),
      kind: 'mount',
    });
    expect(uncRootOf(network())).toBe('\\\\nas.local\\Archive');
  });
});

describe('isWithinRoot', () => {
  it('accepts the root itself and its descendants, and refuses its siblings', () => {
    const root = path.join(DATA_DIR, 'network-archive-mount');
    fs.mkdirSync(root, { recursive: true });

    expect(isWithinRoot(root, root)).toBe(true);
    expect(isWithinRoot(root, path.join(root, 'child'))).toBe(true);
    expect(isWithinRoot(root, DATA_DIR)).toBe(false);
    expect(isWithinRoot(root, path.join(DATA_DIR, 'elsewhere'))).toBe(false);
  });

  it('refuses a path whose parent is a symlink out of the root', () => {
    const root = path.join(DATA_DIR, 'network-archive-mount');
    fs.mkdirSync(root, { recursive: true });
    const outside = fs.mkdtempSync(path.join(path.dirname(path.resolve(DATA_DIR)), 'nebulis-within-escape-'));
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir');

    try {
      expect(isWithinRoot(root, path.join(root, 'link'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveArchiveDestination — the dispatcher', () => {
  it('reports an unconfigured install as unconfigured rather than as a bad path', () => {
    const resolved = resolveArchiveDestination(configWith({ path: '' }));
    expect(resolved.ok).toBe(false);
    expect(resolved.kind).toBe('unconfigured');
  });

  it('keeps the local overlap rule exactly as it was', () => {
    // The library directory and the data directory are both refused, and they are
    // refused through the dispatcher, so a network branch cannot have loosened them.
    for (const candidate of [getLibraryDir(), DATA_DIR, path.dirname(DATA_DIR)]) {
      const resolved = resolveArchiveDestination(configWith({ path: candidate }));
      expect(resolved.ok, candidate).toBe(false);
      expect(resolved.kind, candidate).toBe('local');
    }
  });

  it('accepts a local path on an external volume', () => {
    // A sibling of DATA_DIR would *contain* it, and is correctly refused by the
    // overlap rule (asserted in the test above). A path outside the tree entirely is
    // the ordinary case: another mounted disk.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-archive-volume-'));
    try {
      const resolved = resolveArchiveDestination(configWith({ path: elsewhere }));
      expect(resolved.ok).toBe(true);
      expect(resolved.kind).toBe('local');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports a network destination as network, and its reasons in words', () => {
    setPlatform('darwin');
    const good = resolveArchiveDestination(
      configWith({ locationType: 'network', network: network({ subpath: 'Nebulis-Archive' }) }),
    );
    expect(good.ok).toBe(true);
    expect(good.kind).toBe('network');
    expect(good.ok && good.root).toBe(path.join(ARCHIVE_NETWORK_MOUNT_DIR, 'Nebulis-Archive'));

    const bad = resolveArchiveDestination(configWith({ locationType: 'network', network: network({ host: '' }) }));
    expect(bad.ok).toBe(false);
    expect(bad.kind).toBe('network');
    expect(bad.ok === false && bad.warning).toMatch(/server and a share/);
  });

  it('does not apply the local path rule to a network destination', () => {
    // The resolved network root is under DATA_DIR by construction. If the local rule
    // were applied to it, a network destination could never be configured at all,
    // which is exactly the confusion the two-function split exists to prevent.
    setPlatform('darwin');
    const resolved = resolveArchiveDestination(configWith({ locationType: 'network', network: network() }));
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.root.startsWith(DATA_DIR)).toBe(true);
  });
});

describe('a network root still contains what is written under it', () => {
  it('resolves object paths under the share and refuses a traversal segment', () => {
    setPlatform('darwin');
    const resolved = resolveNetworkArchiveRoot(network({ subpath: 'Nebulis-Archive' }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    fs.mkdirSync(resolved.root, { recursive: true });

    expect(resolveContainedArchivePath(resolved.root, 'M 31', 'sub.fit')).toBe(
      path.join(resolved.root, 'M 31', 'sub.fit'),
    );
    expect(resolveContainedArchivePath(resolved.root, '..')).toBeNull();
    expect(resolveContainedArchivePath(resolved.root, 'M 31', '..', '..', 'etc')).toBeNull();
  });
});
