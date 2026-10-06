import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

import db from '../../server/lib/db';
import { ARCHIVE_SETTINGS_COLUMNS, ensureArchiveColumns } from '../../server/lib/archive/archiveColumns';
import {
  ArchiveConfigError,
  DEFAULT_ARCHIVE_CONFIG,
  getArchiveConfig,
  setArchiveConfig,
} from '../../server/lib/archive/archiveConfig';

/**
 * Archive configuration: the schema migration and the config read/write path.
 *
 * Two things are being protected here.
 *
 * First, the upgrade path. Every existing install runs the guarded `ALTER TABLE`
 * block in `db.ts` on boot, so an archive column that is added to the fresh-install
 * `CREATE TABLE` but forgotten in the migration leaves existing users without it,
 * and the first read throws. That failure only appears on an upgraded database,
 * which is exactly what a test suite running against a fresh one never sees.
 *
 * Second, the defaults. `removeLocalAfter` deletes subframes from the user's
 * library, and `scheduleEnabled` starts writing to a disk unattended. Both must
 * default to off and must stay off, so a fresh install archives nothing and
 * deletes nothing until a human turns it on.
 */

function columnsOf(database: DatabaseType, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

/**
 * The suite shares a single `appSettings` row across test files (see
 * tests/setup.ts), and the schedule tests in particular leave a destination and a
 * last-run stamp behind. "A fresh install" therefore has to be established rather
 * than assumed, or these assertions depend on which file ran first.
 */
beforeEach(() => {
  // `clearPassword` matters: the defaults do not carry a password, and a stored one
  // deliberately survives a reset, so without it this "fresh install" depends on which
  // suite ran first.
  setArchiveConfig({
    ...DEFAULT_ARCHIVE_CONFIG,
    network: { ...DEFAULT_ARCHIVE_CONFIG.network, clearPassword: true },
  });
});

/**
 * `db.ts` states that the fresh-install `CREATE TABLE` and `ARCHIVE_SETTINGS_COLUMNS`
 * are kept in step by this file, and until now nothing checked it: the migration test
 * below drives `ensureArchiveColumns` against a scratch table, which proves the list
 * works but not that a new install gets the same columns. A column added to the list
 * and forgotten in `db.ts` would leave fresh installs missing it, which no test that
 * runs against an existing database can see.
 */
describe('the fresh-install schema and the column list', () => {
  it('declares every archive column in db.ts\'s CREATE TABLE as well', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'db.ts'), 'utf8');
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS appSettings');
    expect(start, 'the appSettings CREATE TABLE was not found').toBeGreaterThan(-1);
    const end = source.indexOf('\n  );', start);
    expect(end, 'the appSettings CREATE TABLE has no end').toBeGreaterThan(start);
    const createTable = source.slice(start, end);

    for (const column of ARCHIVE_SETTINGS_COLUMNS) {
      expect(createTable, `${column.name} is missing from the fresh-install schema`).toContain(column.name);
    }
  });
});

describe('ensureArchiveColumns — the upgrade path', () => {
  let scratch: DatabaseType;

  beforeEach(() => {
    scratch = new Database(':memory:');
    // The state an existing install is in before this feature existed: an
    // appSettings table carrying none of the archive columns.
    scratch.prepare('CREATE TABLE appSettings (id INTEGER PRIMARY KEY CHECK (id = 1))').run();
  });

  afterEach(() => {
    scratch.close();
  });

  it('adds every archive column to a database that has none', () => {
    ensureArchiveColumns(scratch);
    const present = columnsOf(scratch, 'appSettings');
    for (const column of ARCHIVE_SETTINGS_COLUMNS) {
      expect(present, `expected ${column.name} to be added`).toContain(column.name);
    }
  });

  it('is idempotent, so a second boot does not fail', () => {
    ensureArchiveColumns(scratch);
    const first = columnsOf(scratch, 'appSettings').sort();
    expect(() => ensureArchiveColumns(scratch)).not.toThrow();
    expect(columnsOf(scratch, 'appSettings').sort()).toEqual(first);
  });

  it('adds only what is missing from a partially-migrated database', () => {
    // A build that shipped some of these columns, or a migration interrupted
    // halfway. The guard is per column, so this must converge rather than throw.
    ensureArchiveColumns(scratch);
    scratch.prepare('ALTER TABLE appSettings DROP COLUMN archiveRetentionDays').run();
    ensureArchiveColumns(scratch);
    expect(columnsOf(scratch, 'appSettings')).toContain('archiveRetentionDays');
  });

  it('leaves existing rows intact and readable', () => {
    scratch.prepare('INSERT INTO appSettings (id) VALUES (1)').run();
    ensureArchiveColumns(scratch);
    const row = scratch.prepare('SELECT * FROM appSettings WHERE id = 1').get() as Record<string, unknown>;
    expect(row.id).toBe(1);
    expect(row.archivePath).toBe('');
    expect(row.archiveRemoveLocalAfter).toBe(0);
  });

  it('declares every column NOT NULL with a default, so no read can yield undefined', () => {
    ensureArchiveColumns(scratch);
    const info = scratch.prepare('PRAGMA table_info(appSettings)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    for (const column of ARCHIVE_SETTINGS_COLUMNS) {
      const found = info.find(c => c.name === column.name);
      expect(found, `${column.name} missing`).toBeDefined();
      expect(found?.notnull, `${column.name} must be NOT NULL`).toBe(1);
      expect(found?.dflt_value, `${column.name} must have a default`).not.toBeNull();
    }
  });

  /**
   * The retention switch defaults to off, which is right for a fresh install and
   * wrong for one that upgrades into it with a period already set: switching pruning
   * off underneath a user who had configured it is a silent behaviour change. The
   * backfill is what keeps those rows meaning what they meant.
   */
  describe('the retention switch backfill', () => {
    it('arms pruning for a row that already had a period', () => {
      scratch.prepare('ALTER TABLE appSettings ADD COLUMN archiveRetentionDays INTEGER NOT NULL DEFAULT 0').run();
      scratch.prepare('INSERT INTO appSettings (id, archiveRetentionDays) VALUES (1, 30)').run();
      ensureArchiveColumns(scratch);
      const row = scratch.prepare('SELECT archiveRetentionEnabled FROM appSettings WHERE id = 1').get() as {
        archiveRetentionEnabled: number;
      };
      expect(row.archiveRetentionEnabled).toBe(1);
    });

    it('leaves pruning off for a row whose period was 0', () => {
      scratch.prepare('ALTER TABLE appSettings ADD COLUMN archiveRetentionDays INTEGER NOT NULL DEFAULT 0').run();
      scratch.prepare('INSERT INTO appSettings (id, archiveRetentionDays) VALUES (1, 0)').run();
      ensureArchiveColumns(scratch);
      const row = scratch.prepare('SELECT archiveRetentionEnabled FROM appSettings WHERE id = 1').get() as {
        archiveRetentionEnabled: number;
      };
      expect(row.archiveRetentionEnabled).toBe(0);
    });

    it('does not re-arm pruning on a later boot, so a user who turned it off stays off', () => {
      scratch.prepare('ALTER TABLE appSettings ADD COLUMN archiveRetentionDays INTEGER NOT NULL DEFAULT 0').run();
      scratch.prepare('INSERT INTO appSettings (id, archiveRetentionDays) VALUES (1, 30)').run();
      ensureArchiveColumns(scratch);
      scratch.prepare('UPDATE appSettings SET archiveRetentionEnabled = 0 WHERE id = 1').run();
      ensureArchiveColumns(scratch);
      const row = scratch.prepare('SELECT archiveRetentionEnabled FROM appSettings WHERE id = 1').get() as {
        archiveRetentionEnabled: number;
      };
      expect(row.archiveRetentionEnabled).toBe(0);
    });
  });
});

describe('getArchiveConfig — an unconfigured install', () => {
  it('reports a coherent empty state rather than throwing', () => {
    // A fresh install has never opened the Archive settings page. Reading must
    // work so the UI can render "not configured" instead of an error.
    const config = getArchiveConfig();
    expect(config.path).toBe('');
    expect(config.archiveId).toBe('');
    expect(config.scope).toBe('all');
    expect(config.selectedObjects).toEqual([]);
  });

  it('has every destructive or unattended behaviour switched off', () => {
    const config = getArchiveConfig();
    expect(config.enabled).toBe(false);
    expect(config.scheduleEnabled).toBe(false);
    expect(config.removeLocalAfter).toBe(false);
    expect(config.includeSubframes).toBe(false);
    // 0 means "keep forever", so a fresh install prunes nothing.
    expect(config.retentionDays).toBe(0);
    expect(config.retentionEnabled).toBe(false);
    expect(config.retentionSubframesOnly).toBe(false);
    // 0 means "no minimum", so a fresh install copies everything immediately.
    expect(config.copyMinAgeDays).toBe(0);
    expect(config.copyMinAgeEnabled).toBe(false);
  });

  it('starts on the simplest schedule, so an untouched install means one run a day', () => {
    const config = getArchiveConfig();
    expect(config.scheduleMode).toBe('daily');
    expect(config.scheduleMinute).toBe(0);
    expect(config.scheduleIntervalHours).toBe(24);
    expect(config.scheduleCron).toBe('');
  });

  it('does not write while reading', () => {
    const before = db.prepare('SELECT * FROM appSettings WHERE id = 1').get();
    getArchiveConfig();
    expect(db.prepare('SELECT * FROM appSettings WHERE id = 1').get()).toEqual(before);
  });

  it('matches the exported defaults, so the UI and the DB cannot disagree', () => {
    expect(getArchiveConfig()).toEqual(DEFAULT_ARCHIVE_CONFIG);
  });
});

describe('setArchiveConfig — round trip and validation', () => {
  afterEach(() => {
    setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  });

  it('round-trips a fully-populated configuration', () => {
    setArchiveConfig({
      enabled: true,
      path: '/Volumes/Archive',
      archiveId: 'archive-1',
      scope: 'selected',
      selectedObjects: ['M31', 'M42'],
      includeSubframes: true,
      scheduleEnabled: true,
      scheduleMode: 'custom',
      scheduleHour: 3,
      scheduleMinute: 45,
      scheduleIntervalHours: 8,
      scheduleCron: '15 3 * * 1',
      retentionDays: 90,
      retentionEnabled: true,
      retentionSubframesOnly: true,
      removeLocalAfter: true,
      copyMinAgeDays: 7,
      copyMinAgeEnabled: true,
    });
    const config = getArchiveConfig();
    expect(config.enabled).toBe(true);
    expect(config.path).toBe('/Volumes/Archive');
    expect(config.archiveId).toBe('archive-1');
    expect(config.scope).toBe('selected');
    expect(config.selectedObjects).toEqual(['M31', 'M42']);
    expect(config.includeSubframes).toBe(true);
    expect(config.scheduleEnabled).toBe(true);
    expect(config.scheduleMode).toBe('custom');
    expect(config.scheduleHour).toBe(3);
    expect(config.scheduleMinute).toBe(45);
    expect(config.scheduleIntervalHours).toBe(8);
    expect(config.scheduleCron).toBe('15 3 * * 1');
    expect(config.retentionDays).toBe(90);
    expect(config.retentionEnabled).toBe(true);
    expect(config.retentionSubframesOnly).toBe(true);
    expect(config.removeLocalAfter).toBe(true);
    expect(config.copyMinAgeDays).toBe(7);
    expect(config.copyMinAgeEnabled).toBe(true);
  });

  it('trims a cron expression rather than storing the whitespace', () => {
    setArchiveConfig({ scheduleMode: 'custom', scheduleCron: '  0 4 * * *  ' });
    expect(getArchiveConfig().scheduleCron).toBe('0 4 * * *');
  });

  it('applies a partial patch without clearing unrelated settings', () => {
    setArchiveConfig({ path: '/Volumes/Archive', retentionDays: 30 });
    setArchiveConfig({ scheduleHour: 5 });
    const config = getArchiveConfig();
    expect(config.path).toBe('/Volumes/Archive');
    expect(config.retentionDays).toBe(30);
    expect(config.scheduleHour).toBe(5);
  });

  it('refuses an unknown scope', () => {
    expect(() => setArchiveConfig({ scope: 'everything' as unknown as 'all' })).toThrow(ArchiveConfigError);
  });

  it('refuses an hour outside 0-23', () => {
    for (const hour of [-1, 24, 1.5, Number.NaN]) {
      expect(() => setArchiveConfig({ scheduleHour: hour }), `hour ${hour}`).toThrow(ArchiveConfigError);
    }
  });

  it('refuses a negative or non-integer retention period', () => {
    for (const days of [-1, 1.5, Number.NaN]) {
      expect(() => setArchiveConfig({ retentionDays: days }), `days ${days}`).toThrow(ArchiveConfigError);
    }
  });

  it('refuses a negative or non-integer minimum age', () => {
    for (const days of [-1, 1.5, Number.NaN]) {
      expect(() => setArchiveConfig({ copyMinAgeDays: days }), `days ${days}`).toThrow(ArchiveConfigError);
    }
  });

  it('refuses a selection that is not a list of object ids', () => {
    for (const selectedObjects of ['M31', [1, 2], [''], [null], {}]) {
      expect(
        () => setArchiveConfig({ selectedObjects: selectedObjects as unknown as string[] }),
        `selection ${JSON.stringify(selectedObjects)}`,
      ).toThrow(ArchiveConfigError);
    }
  });

  it('refuses a non-boolean flag rather than coercing it', () => {
    // `removeLocalAfter: 'false'` is truthy, and coercing it would delete
    // subframes the user asked to keep.
    for (const flag of ['false', 'true', 1, 0]) {
      expect(
        () => setArchiveConfig({ removeLocalAfter: flag as unknown as boolean }),
        `flag ${JSON.stringify(flag)}`,
      ).toThrow(ArchiveConfigError);
    }
  });

  it('refuses a schedule mode outside the three', () => {
    expect(() => setArchiveConfig({ scheduleMode: 'hourly' as unknown as 'daily' })).toThrow(ArchiveConfigError);
  });

  it('refuses a minute outside 0-59 and an interval outside 1-168 hours', () => {
    for (const minute of [-1, 60, 1.5, Number.NaN]) {
      expect(() => setArchiveConfig({ scheduleMinute: minute }), `minute ${minute}`).toThrow(ArchiveConfigError);
    }
    for (const hours of [0, 169, 2.5, Number.NaN]) {
      expect(() => setArchiveConfig({ scheduleIntervalHours: hours }), `hours ${hours}`).toThrow(
        ArchiveConfigError,
      );
    }
  });

  it('accepts the edges of the interval range', () => {
    setArchiveConfig({ scheduleIntervalHours: 1 });
    expect(getArchiveConfig().scheduleIntervalHours).toBe(1);
    setArchiveConfig({ scheduleIntervalHours: 168 });
    expect(getArchiveConfig().scheduleIntervalHours).toBe(168);
  });

  it('refuses an unusable cron expression, and says which field is wrong', () => {
    for (const cron of ['0 4 * *', '60 4 * * *', '0 4 * 13 *', '@daily', '0 4 * * MON']) {
      let thrown: unknown;
      try {
        setArchiveConfig({ scheduleCron: cron });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `cron "${cron}" should be refused`).toBeInstanceOf(ArchiveConfigError);
      if (thrown instanceof ArchiveConfigError) {
        // The point of validating here rather than at the tick is that the user can
        // be told something usable, so the reason has to be there.
        expect(thrown.field).toBe('scheduleCron');
        expect(thrown.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('stores a valid cron expression', () => {
    setArchiveConfig({ scheduleCron: '*/15 2-6 * * 1-5' });
    expect(getArchiveConfig().scheduleCron).toBe('*/15 2-6 * * 1-5');
  });

  it('refuses custom mode while no expression is usable', () => {
    // Start from a mode that is happy with an empty expression, since the previous
    // test in this file may have left the stored mode as custom.
    setArchiveConfig({ scheduleMode: 'daily' });
    setArchiveConfig({ scheduleCron: '' });
    expect(() => setArchiveConfig({ scheduleMode: 'custom' })).toThrow(ArchiveConfigError);
  });

  it('refuses to empty the expression while custom mode is stored', () => {
    setArchiveConfig({ scheduleMode: 'custom', scheduleCron: '0 4 * * *' });
    expect(() => setArchiveConfig({ scheduleCron: '' })).toThrow(ArchiveConfigError);
  });

  it('allows custom mode when an expression was stored earlier', () => {
    setArchiveConfig({ scheduleMode: 'daily' });
    setArchiveConfig({ scheduleCron: '0 4 * * *' });
    setArchiveConfig({ scheduleMode: 'custom' });
    expect(getArchiveConfig().scheduleMode).toBe('custom');
  });

  it('allows the expression and the mode to arrive in either order', () => {
    setArchiveConfig({ scheduleMode: 'custom', scheduleCron: '0 4 * * *' });
    const config = getArchiveConfig();
    expect(config.scheduleMode).toBe('custom');
    expect(config.scheduleCron).toBe('0 4 * * *');
  });

  it('refuses to arm pruning with no period to prune by', () => {
    setArchiveConfig({ retentionDays: 0 });
    expect(() => setArchiveConfig({ retentionEnabled: true })).toThrow(ArchiveConfigError);
  });

  it('allows pruning to be armed when a period was stored earlier', () => {
    setArchiveConfig({ retentionDays: 30 });
    setArchiveConfig({ retentionEnabled: true });
    expect(getArchiveConfig().retentionEnabled).toBe(true);
  });

  it('allows the period and the switch to arrive in either order', () => {
    setArchiveConfig({ retentionEnabled: true, retentionDays: 30 });
    const config = getArchiveConfig();
    expect(config.retentionEnabled).toBe(true);
    expect(config.retentionDays).toBe(30);
  });

  it('refuses to arm the minimum age filter with no day count to wait by', () => {
    setArchiveConfig({ copyMinAgeDays: 0 });
    expect(() => setArchiveConfig({ copyMinAgeEnabled: true })).toThrow(ArchiveConfigError);
  });

  it('allows the minimum age filter to be armed when a day count was stored earlier', () => {
    setArchiveConfig({ copyMinAgeDays: 7 });
    setArchiveConfig({ copyMinAgeEnabled: true });
    expect(getArchiveConfig().copyMinAgeEnabled).toBe(true);
  });

  it('allows the minimum age day count and the switch to arrive in either order', () => {
    setArchiveConfig({ copyMinAgeEnabled: true, copyMinAgeDays: 7 });
    const config = getArchiveConfig();
    expect(config.copyMinAgeEnabled).toBe(true);
    expect(config.copyMinAgeDays).toBe(7);
  });

  it('refuses a non-boolean master switch rather than coercing it', () => {
    for (const flag of ['true', 1, 0]) {
      expect(() => setArchiveConfig({ enabled: flag as unknown as boolean }), `flag ${flag}`).toThrow(
        ArchiveConfigError,
      );
    }
  });

  it('validates before writing anything, so a rejected patch changes nothing', () => {
    setArchiveConfig({ path: '/Volumes/Archive', scheduleHour: 4 });
    expect(() => setArchiveConfig({ scheduleHour: 99, path: '/Volumes/Other' })).toThrow();
    const config = getArchiveConfig();
    expect(config.path).toBe('/Volumes/Archive');
    expect(config.scheduleHour).toBe(4);
  });

  it('does not half-apply the end-state checks either', () => {
    // Both fields are in one patch and the pair is refused, so neither lands: an
    // armed switch with no period is exactly the state this check exists to stop.
    setArchiveConfig({ retentionEnabled: false, retentionDays: 0 });
    expect(() => setArchiveConfig({ retentionEnabled: true, retentionDays: 0 })).toThrow(ArchiveConfigError);
    const config = getArchiveConfig();
    expect(config.retentionEnabled).toBe(false);
    expect(config.retentionDays).toBe(0);
  });

  it('does not half-apply the minimum age end-state check either', () => {
    setArchiveConfig({ copyMinAgeEnabled: false, copyMinAgeDays: 0 });
    expect(() => setArchiveConfig({ copyMinAgeEnabled: true, copyMinAgeDays: 0 })).toThrow(ArchiveConfigError);
    const config = getArchiveConfig();
    expect(config.copyMinAgeEnabled).toBe(false);
    expect(config.copyMinAgeDays).toBe(0);
  });
});

describe('getArchiveConfig — defensive read of stored data', () => {
  afterEach(() => {
    setArchiveConfig(DEFAULT_ARCHIVE_CONFIG);
  });

  it('treats unparseable stored JSON as an empty selection instead of throwing', () => {
    // The column is text on a disk anyone can edit, so a read must degrade
    // rather than take the whole settings page down.
    db.prepare("UPDATE appSettings SET archiveSelectedObjects = 'not json' WHERE id = 1").run();
    expect(getArchiveConfig().selectedObjects).toEqual([]);
  });

  it('drops non-string entries from a stored selection', () => {
    db.prepare(`UPDATE appSettings SET archiveSelectedObjects = '["M31", 42, null, ""]' WHERE id = 1`).run();
    expect(getArchiveConfig().selectedObjects).toEqual(['M31']);
  });

  it('falls back to the safe default for a stored value outside the allowed set', () => {
    db.prepare("UPDATE appSettings SET archiveScope = 'nonsense' WHERE id = 1").run();
    expect(getArchiveConfig().scope).toBe('all');
  });
});
