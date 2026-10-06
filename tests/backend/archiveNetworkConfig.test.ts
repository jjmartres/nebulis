import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';

import db from '../../server/lib/db';
import { ARCHIVE_SETTINGS_COLUMNS, ensureArchiveColumns } from '../../server/lib/archive/archiveColumns';
import {
  DEFAULT_ARCHIVE_CONFIG,
  getArchiveConfig,
  getArchiveNetworkCredentials,
  setArchiveConfig,
} from '../../server/lib/archive/archiveConfig';

/**
 * The network half of the archive configuration, and the write-only password.
 *
 * Two things are being protected here, and neither is visible in the UI.
 *
 * First, the migration. A network destination that exists in the fresh-install
 * `CREATE TABLE` but not in `ensureArchiveColumns` leaves every upgraded install
 * without the column, and the first read throws. The scratch-database case below is
 * the only way to see that, because the suite's own database already has them.
 *
 * Second, the password. It is sealed with `secretBox` and readable only through
 * `getArchiveNetworkCredentials`, which the connect step calls. A patch can set it
 * and can clear it, and an empty one means "keep" rather than "use no password":
 * silently downgrading a working share to a guest connection is the failure that
 * rule exists to prevent.
 */

const NETWORK_COLUMNS = [
  'archiveLocationType',
  'archiveNetworkHost',
  'archiveNetworkShare',
  'archiveNetworkDomain',
  'archiveNetworkUsername',
  'archiveNetworkPasswordSealed',
  'archiveNetworkSubpath',
];

/** The suite shares one `appSettings` row across files (see tests/setup.ts), and a
 *  stored password survives a reset to the defaults by design, so establishing a
 *  clean state means clearing it explicitly. */
function resetArchiveConfig(): void {
  setArchiveConfig({
    ...DEFAULT_ARCHIVE_CONFIG,
    network: { ...DEFAULT_ARCHIVE_CONFIG.network, clearPassword: true },
  });
}

function rawSealedPassword(): string {
  const row = db.prepare('SELECT archiveNetworkPasswordSealed AS sealed FROM appSettings WHERE id = 1').get() as
    | { sealed: unknown }
    | undefined;
  return typeof row?.sealed === 'string' ? row.sealed : '';
}

beforeEach(resetArchiveConfig);

/** The row is shared with every other suite in the run (see tests/setup.ts), and a
 *  stored password deliberately survives a reset to the defaults, so this file has to
 *  hand the row back the way it found it. Without this, `archiveConfig.test.ts`'s
 *  "a fresh install equals DEFAULT_ARCHIVE_CONFIG" passes or fails depending on which
 *  file the runner happened to schedule first. */
afterAll(resetArchiveConfig);

describe('the network columns — the upgrade path', () => {
  it('adds every network column to a database that has none', () => {
    const scratch = new Database(':memory:');
    try {
      scratch.prepare('CREATE TABLE appSettings (id INTEGER PRIMARY KEY CHECK (id = 1))').run();
      ensureArchiveColumns(scratch);
      const names = (scratch.prepare('PRAGMA table_info(appSettings)').all() as Array<{ name: string }>).map(c => c.name);
      for (const column of NETWORK_COLUMNS) {
        expect(names, `${column} is missing from the migration`).toContain(column);
      }
    } finally {
      scratch.close();
    }
  });

  it('declares them in the column list once, with a default for every one', () => {
    // The list is what `ensureArchiveColumns` walks and what db.ts's CREATE TABLE
    // mirrors, so a column declared without a default would read back undefined on
    // an upgraded database rather than as the safe value.
    for (const column of NETWORK_COLUMNS) {
      const declared = ARCHIVE_SETTINGS_COLUMNS.find(c => c.name === column);
      expect(declared, `${column} is not declared`).toBeDefined();
      expect(declared?.ddl).toMatch(/NOT NULL DEFAULT/);
    }
  });
});

describe('a fresh install', () => {
  it('reports a local destination with no network details', () => {
    const config = getArchiveConfig();
    expect(config.locationType).toBe('local');
    expect(config.network).toEqual({ host: '', share: '', domain: '', username: '', hasPassword: false, subpath: '' });
  });

  it('is reproduced exactly by a reset that also clears the password', () => {
    // The reset helper is what every other suite's "fresh install" depends on, so it
    // has to be able to produce one. A reset that leaves a sealed password behind is
    // the reason this needs asserting rather than assuming.
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });
    resetArchiveConfig();

    expect(getArchiveConfig()).toEqual(DEFAULT_ARCHIVE_CONFIG);
    expect(rawSealedPassword()).toBe('');
  });
});

describe('setArchiveConfig — network validation', () => {
  it('refuses a network destination with no server', () => {
    expect(() => setArchiveConfig({ locationType: 'network' })).toThrowError(/server address/);
  });

  it('refuses a network destination with a server but no share', () => {
    expect(() => setArchiveConfig({ locationType: 'network', network: { host: 'nas.local' } })).toThrowError(
      /share name/,
    );
  });

  it('accepts the same two fields arriving in either order, because the check is on the result', () => {
    setArchiveConfig({ locationType: 'network', network: { host: 'nas.local', share: 'Archive' } });
    expect(getArchiveConfig().locationType).toBe('network');
    expect(getArchiveConfig().network.share).toBe('Archive');
  });

  it('refuses a server name carrying shell metacharacters, which the mount call would', () => {
    expect(() => setArchiveConfig({ network: { host: 'nas.local;drop' } })).toThrowError(/characters/);
  });

  it('names the server field when a whole UNC path is pasted into it', () => {
    // The mistake everybody makes, and the message has to say which field is wrong and
    // what to do: the address is fine, the field is not.
    expect(() => setArchiveConfig({ network: { host: '\\\\192.168.1.12\\Nebulis2' } })).toThrowError(
      /backslash or a slash/,
    );
  });

  it('refuses a subpath that climbs out of the share', () => {
    for (const subpath of ['..', '../..', 'Nebulis/../../etc', 'a/../../../b']) {
      expect(() => setArchiveConfig({ network: { subpath } }), subpath).toThrowError(/climb out/);
    }
  });

  it('refuses an absolute subpath in either platform spelling', () => {
    for (const subpath of ['/etc', '\\Windows', 'C:\\Windows', 'C:/Windows']) {
      expect(() => setArchiveConfig({ network: { subpath } }), subpath).toThrowError(/relative path/);
    }
  });

  it('accepts an empty subpath, which means the share root', () => {
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', subpath: '' } });
    expect(getArchiveConfig().network.subpath).toBe('');
  });

  it('accepts a nested subpath, which is a folder inside the share', () => {
    setArchiveConfig({ network: { subpath: 'Nebulis/Archive' } });
    expect(getArchiveConfig().network.subpath).toBe('Nebulis/Archive');
  });

  it('refuses an unknown key inside the network object', () => {
    expect(() => setArchiveConfig({ network: { host: 'nas.local', nope: 'x' } as never })).toThrowError(
      /unknown network setting/,
    );
  });

  it('refuses a network object that is not an object', () => {
    expect(() => setArchiveConfig({ network: 'nas.local' as never })).toThrowError(/must be an object/);
  });
});

describe('setArchiveConfig — the password is write-only', () => {
  it('stores it sealed and never hands it back through the config', () => {
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });

    expect(rawSealedPassword()).not.toBe('');
    expect(rawSealedPassword()).not.toContain('hunter2');
    expect(getArchiveConfig().network.hasPassword).toBe(true);
    // The whole config, serialised the way a route would: it must not appear.
    expect(JSON.stringify(getArchiveConfig())).not.toContain('hunter2');
    // And the one function that may read it does.
    expect(getArchiveNetworkCredentials().password).toBe('hunter2');
  });

  it('keeps the stored password when a later save omits it', () => {
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });
    setArchiveConfig({ network: { subpath: 'Archive' } });

    expect(getArchiveNetworkCredentials().password).toBe('hunter2');
    expect(getArchiveConfig().network.hasPassword).toBe(true);
  });

  it('keeps the stored password when a later save sends an empty one', () => {
    // Decision 4. An empty field on a form that never received the password must
    // not mean "connect as a guest" to a share that has one.
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });
    setArchiveConfig({ network: { password: '' } });

    expect(getArchiveNetworkCredentials().password).toBe('hunter2');
  });

  it('clears it only when asked explicitly', () => {
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });
    setArchiveConfig({ network: { clearPassword: true } });

    expect(getArchiveConfig().network.hasPassword).toBe(false);
    expect(getArchiveNetworkCredentials().password).toBe('');
    expect(rawSealedPassword()).toBe('');
  });

  it('ignores hasPassword in a patch, so a config can be handed back unchanged', () => {
    setArchiveConfig({ network: { host: 'nas.local', share: 'Archive', password: 'hunter2' } });
    // What a caller that read the config and changed one field would send.
    setArchiveConfig({ ...getArchiveConfig(), network: { ...getArchiveConfig().network, subpath: 'Nested' } });

    expect(getArchiveNetworkCredentials().password).toBe('hunter2');
    expect(getArchiveConfig().network.subpath).toBe('Nested');
  });
});

describe('switching between destination types', () => {
  it('keeps the network fields while the destination is local', () => {
    // Parity with the library location, which keeps the last-used network values so
    // switching back does not mean retyping them.
    setArchiveConfig({ locationType: 'network', network: { host: 'nas.local', share: 'Archive' } });
    setArchiveConfig({ locationType: 'local', path: '/Volumes/Archive' });

    const config = getArchiveConfig();
    expect(config.locationType).toBe('local');
    expect(config.path).toBe('/Volumes/Archive');
    expect(config.network.host).toBe('nas.local');
  });

  it('refuses to leave a network destination without a server, even by clearing it later', () => {
    setArchiveConfig({ locationType: 'network', network: { host: 'nas.local', share: 'Archive' } });
    expect(() => setArchiveConfig({ network: { host: '' } })).toThrowError(/server address/);
  });
});
