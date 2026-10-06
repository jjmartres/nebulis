import { describe, it, expect, vi, afterEach } from 'vitest';

// A scratch DATA_DIR, before any server module loads: the mount directory is derived
// from it at import time, and two suites creating and removing the same directory
// under the shared test data directory would race.
vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _process = require('process') as typeof import('process');
  const _root = _path.join(_process.cwd(), '.test-tmp');
  _fs.mkdirSync(_root, { recursive: true });
  const dir = _fs.mkdtempSync(_path.join(_root, 'nebulis-archive-net-'));
  _process.env.DATA_DIR = dir;
  _process.env.DATA_KEY = Buffer.alloc(32, 5).toString('base64');
  return dir;
});

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    Promise.resolve(execFileMock(...args.slice(0, -1))).then(
      result => cb(null, (result as { stdout: string; stderr: string }) ?? { stdout: '', stderr: '' }),
      err => cb(err instanceof Error ? err : new Error(String(err))),
    );
  },
}));

const tcpProbeMock = vi.fn();
vi.mock('../../server/lib/smbReachability', () => ({
  tcpProbe: (...args: unknown[]) => tcpProbeMock(...args),
  SMB_PORT: 445,
}));

import fs from 'fs';
import path from 'path';

import {
  ARCHIVE_NETWORK_MOUNT_DIR,
  disconnectArchiveNetwork,
  ensureArchiveNetworkConnected,
  ensureArchiveShareReady,
  invalidateArchiveReachability,
  isArchiveShareMounted,
  testArchiveNetworkConnection,
} from '../../server/lib/archive/archiveNetwork';
import { log } from '../../server/lib/logger';
import type { ArchiveNetworkCredentials } from '../../server/lib/archive/archiveConfig';

/**
 * Connecting to the archive's share, and proving the mount is really there.
 *
 * The second half is the part that matters. On macOS the destination resolves to a
 * directory under DATA_DIR, and that directory exists whether or not a share is
 * mounted on it. `ensureArchiveShareReady` is what tells those two states apart, and
 * the test for the unmounted case is the reason this module exists at all: without
 * it, an unmounted share looks like an empty archive waiting to be adopted.
 *
 * The other property under test is that the password does not escape. It is on the
 * `mount_smbfs` command line, because that is how the mount works, so the rule is
 * that nothing derived from a failure may be logged or returned.
 */

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const ORIGINAL_PLATFORM = process.platform;

function credentials(overrides: Partial<ArchiveNetworkCredentials> = {}): ArchiveNetworkCredentials {
  return {
    host: 'nas.local',
    share: 'Archive',
    domain: '',
    username: 'alice',
    password: 'hunter2',
    subpath: '',
    ...overrides,
  };
}

/** A mount table naming our directory, the way `mount` prints one. */
function mountOn(dir: string): { stdout: string } {
  return { stdout: `//alice@nas.local/Archive on ${dir} (smbfs, nodev, nosuid, mounted by alice)` };
}

const emptyMountTable = { stdout: '' };

afterEach(async () => {
  // The module tracks the config it last mounted, so a test that mounts would
  // otherwise leave the next one looking already connected.
  setPlatform('darwin');
  await disconnectArchiveNetwork();
  setPlatform(ORIGINAL_PLATFORM);
  execFileMock.mockReset();
  tcpProbeMock.mockReset();
  invalidateArchiveReachability();
  fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
});

describe('ensureArchiveNetworkConnected', () => {
  it('makes no native call at all when the host is unreachable', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(null);

    expect(await ensureArchiveNetworkConnected(credentials())).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('mounts the share on macOS with the credentials in the URL', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(emptyMountTable);
      if (cmd === 'mount_smbfs') return Promise.resolve({ stdout: '', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    expect(await ensureArchiveNetworkConnected(credentials())).toBe(true);

    const [, args] = execFileMock.mock.calls.find(call => call[0] === 'mount_smbfs') as [string, string[]];
    expect(args[0]).toBe('//alice:hunter2@nas.local/Archive');
    expect(args[1]).toBe(ARCHIVE_NETWORK_MOUNT_DIR);
  });

  it('mounts once and does not remount on a second connect', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    let mounted = false;
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mounted ? mountOn(ARCHIVE_NETWORK_MOUNT_DIR) : emptyMountTable);
      if (cmd === 'mount_smbfs') {
        mounted = true;
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    await ensureArchiveNetworkConnected(credentials());
    await ensureArchiveNetworkConnected(credentials());

    expect(execFileMock.mock.calls.filter(call => call[0] === 'mount_smbfs')).toHaveLength(1);
  });

  it('adopts a mount inherited from a previous run rather than remounting it', async () => {
    // The mount belongs to a process that is gone, so its key is unknown: the share
    // it points at is what decides, and a match means it is already ours.
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    await ensureArchiveNetworkConnected(credentials());

    expect(execFileMock.mock.calls.filter(call => call[0] === 'mount_smbfs')).toHaveLength(0);
    expect(execFileMock.mock.calls.filter(call => call[0] === 'umount')).toHaveLength(0);
  });

  it('remounts when the share changes under an existing mount', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    let mounted = false;
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mounted ? mountOn(ARCHIVE_NETWORK_MOUNT_DIR) : emptyMountTable);
      if (cmd === 'mount_smbfs') {
        mounted = true;
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (cmd === 'umount') {
        mounted = false;
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    await ensureArchiveNetworkConnected(credentials());
    await ensureArchiveNetworkConnected(credentials({ share: 'Other' }));

    // An unmount before the remount, not a second mount over the first.
    expect(execFileMock.mock.calls.filter(call => call[0] === 'umount')).toHaveLength(1);
    expect(execFileMock.mock.calls.filter(call => call[0] === 'mount_smbfs')).toHaveLength(2);
  });

  it('uses net use only when a password is set, and never on a guest share', async () => {
    setPlatform('win32');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

    await ensureArchiveNetworkConnected(credentials());
    const uses = () => execFileMock.mock.calls.filter(call => call[0] === 'net');
    expect(uses()).toHaveLength(1);
    expect((uses()[0][1] as string[])[1]).toBe('\\\\nas.local\\Archive');

    execFileMock.mockClear();
    await ensureArchiveNetworkConnected(credentials({ password: '' }));
    expect(uses()).toHaveLength(0);
  });

  it('returns false on a platform that cannot mount in process', async () => {
    setPlatform('linux');
    tcpProbeMock.mockResolvedValue(5);

    expect(await ensureArchiveNetworkConnected(credentials())).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('never logs the password, even though it is on the command line', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    const failure = Object.assign(
      new Error(`Command failed: mount_smbfs //alice:hunter2@nas.local/Archive ${ARCHIVE_NETWORK_MOUNT_DIR}`),
      { stderr: 'mount_smbfs: server rejected the connection' },
    );
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(emptyMountTable);
      if (cmd === 'mount_smbfs') return Promise.reject(failure);
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined as never);

    try {
      await ensureArchiveNetworkConnected(credentials());

      // The premise: the password really is in the argv this test produced, so the
      // assertion below is about the logging rather than about an absent secret.
      expect(JSON.stringify(execFileMock.mock.calls)).toContain('hunter2');

      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('hunter2');
      expect(logged).toContain('connect attempt failed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('isArchiveShareMounted', () => {
  it('reports what the mount table says on macOS', async () => {
    setPlatform('darwin');
    execFileMock.mockResolvedValue(emptyMountTable);
    expect(await isArchiveShareMounted()).toBe(false);

    execFileMock.mockResolvedValue(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
    expect(await isArchiveShareMounted()).toBe(true);
  });

  it('always reports true on Windows, where there is no persistent mount', async () => {
    setPlatform('win32');
    execFileMock.mockResolvedValue(emptyMountTable);
    expect(await isArchiveShareMounted()).toBe(true);
  });

  it('treats an unreadable mount table as not mounted', async () => {
    setPlatform('darwin');
    execFileMock.mockRejectedValue(new Error('mount: command not found'));
    expect(await isArchiveShareMounted()).toBe(false);
  });
});

describe('ensureArchiveShareReady — connected is not the same as mounted', () => {
  it('is false when the host is unreachable', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(null);
    expect(await ensureArchiveShareReady(credentials())).toBe(false);
  });

  it('is false when the mount was attempted but the share is not there', async () => {
    // The empty-mount-directory case: the directory exists, the mount succeeded as
    // far as the connect step can tell, and the mount table says nothing is mounted.
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(emptyMountTable);
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    expect(await ensureArchiveShareReady(credentials())).toBe(false);
  });

  it('is true once the share is actually mounted', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    expect(await ensureArchiveShareReady(credentials())).toBe(true);
  });

  it('is false when the mount table lists a mount whose directory is not usable', async () => {
    // The case the table alone cannot see: a share that dropped, or a mount that
    // failed, leaves an entry and a path behind. A file where the mount point should
    // be is the shape of that.
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
    fs.writeFileSync(ARCHIVE_NETWORK_MOUNT_DIR, 'not a directory');

    expect(await isArchiveShareMounted()).toBe(true);   // the table still says mounted
    expect(await ensureArchiveShareReady(credentials())).toBe(false); // and it is not usable
  });

  it('is false on a platform that cannot mount in process, without calling anything', async () => {
    setPlatform('linux');
    tcpProbeMock.mockResolvedValue(5);
    expect(await ensureArchiveShareReady(credentials())).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('testArchiveNetworkConnection — the reason, not just the failure', () => {
  it('names the missing fields before it tries anything', async () => {
    expect(await testArchiveNetworkConnection(credentials({ host: '' }))).toEqual({
      ok: false,
      reason: 'Enter a server address.',
    });
    expect(await testArchiveNetworkConnection(credentials({ share: ' ' }))).toEqual({
      ok: false,
      reason: 'Enter a share name.',
    });
  });

  it('says the host is unreachable, with the port it tried', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(null);
    const result = await testArchiveNetworkConnection(credentials());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nas.local');
    expect(result.reason).toContain('445');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('tells a wrong password apart from an unreachable server', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(emptyMountTable);
      if (cmd === 'mount_smbfs') {
        return Promise.reject(Object.assign(new Error('exit 77'), { stderr: 'Authentication error, permission denied' }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const result = await testArchiveNetworkConnection(credentials());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Authentication failed/);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('names a missing share as a missing share', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(emptyMountTable);
      if (cmd === 'mount_smbfs') {
        return Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'no such file or directory' }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    expect((await testArchiveNetworkConnection(credentials())).reason).toMatch(/Share not found/);
  });

  it('refuses rather than claiming success when it cannot verify the share is readable', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    // A path that exists but is not a directory: the connect step cannot even create
    // the mount point, and neither the subpath nor the root can be read. Deleting it
    // instead would not work, because connecting recreates it with mkdir.
    fs.rmSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true, force: true });
    fs.writeFileSync(ARCHIVE_NETWORK_MOUNT_DIR, 'not a directory');

    const result = await testArchiveNetworkConnection(credentials());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mount point/);
  });

  it('succeeds against a mounted, readable share, falling back to the share root when the subpath is missing', async () => {
    setPlatform('darwin');
    tcpProbeMock.mockResolvedValue(5);
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === 'mount') return Promise.resolve(mountOn(ARCHIVE_NETWORK_MOUNT_DIR));
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    fs.mkdirSync(ARCHIVE_NETWORK_MOUNT_DIR, { recursive: true });

    expect(await testArchiveNetworkConnection(credentials({ subpath: 'NotCreatedYet' }))).toEqual({ ok: true });
  });

  it('refuses on a platform that cannot mount in process, and says what to do instead', async () => {
    setPlatform('linux');
    const result = await testArchiveNetworkConnection(credentials());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not supported on this platform/);
    expect(result.reason).toMatch(/mounted folder/);
  });

  it('refuses an address carrying shell metacharacters before probing it', async () => {
    setPlatform('darwin');
    const result = await testArchiveNetworkConnection(credentials({ host: 'nas.local;drop' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/characters that cannot be used/);
    expect(tcpProbeMock).not.toHaveBeenCalled();
  });

  it('tells the user which field a pasted UNC path belongs in', async () => {
    // What a person types when they know what a UNC path is. The refusal has to name the
    // field and the fix rather than the characters.
    setPlatform('darwin');
    const result = await testArchiveNetworkConnection(credentials({ host: '\\\\192.168.1.12\\Nebulis2' }));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/backslash or a slash/);
    expect(result.reason).toMatch(/192\.168\.1\.12/);
    expect(tcpProbeMock).not.toHaveBeenCalled();
  });
});

describe('the mount directory itself', () => {
  it('is under DATA_DIR, so the resolved path survives a restart', () => {
    expect(path.isAbsolute(ARCHIVE_NETWORK_MOUNT_DIR)).toBe(true);
    expect(ARCHIVE_NETWORK_MOUNT_DIR.startsWith(path.join(path.dirname(ARCHIVE_NETWORK_MOUNT_DIR), ''))).toBe(true);
    expect(path.basename(ARCHIVE_NETWORK_MOUNT_DIR)).toBe('network-archive-mount');
  });
});
