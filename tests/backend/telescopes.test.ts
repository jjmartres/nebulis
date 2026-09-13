import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAllProfiles,
  getFullSettings,
  createProfile,
  updateProfile,
  deleteProfile,
  getSettingsData,
  updateSettingsData,
  type TelescopeProfile,
} from '../../server/lib/telescopes';
import {
  getOpticalConfigsForProfile,
  addOpticalConfig,
  updateOpticalConfig,
  deleteOpticalConfig,
} from '../../server/lib/telescopeOpticalConfigs';
import db from '../../server/lib/db';

describe('telescopes', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM telescopeProfiles').run();
    db.prepare(`
      INSERT INTO telescopeProfiles (id, name, model, hostname, shareName, username, password, isActive, createdAt)
      VALUES ('test-1', 'Test Scope', 'SeeStar S50', '10.0.0.1', 'EMMC Images', 'guest', '', 0, '2024-01-01T00:00:00Z')
    `).run();
  });

  it('getAllProfiles returns at least one profile by default', () => {
    const profiles = getAllProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles[0].id).toBe('test-1');
  });

  it('createProfile adds a new profile', () => {
    const profile = createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    // Profile id is a randomUUID; createdAt is an ISO 8601 timestamp.
    // `toBeTruthy` previously passed for any non-empty string.
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(profile.name).toBe('Second Scope');
    expect(profile.hostname).toBe('10.0.0.2');
    expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const all = getAllProfiles();
    expect(all).toHaveLength(2);
  });

  it('updateProfile changes fields', () => {
    const updated = updateProfile('test-1', { name: 'Renamed Scope', hostname: '192.168.1.1' });
    expect(updated?.name).toBe('Renamed Scope');
    expect(updated?.hostname).toBe('192.168.1.1');
  });

  it('updateProfile preserves id and createdAt', () => {
    const updated = updateProfile('test-1', {
      id: 'should-not-change',
      createdAt: '2099-01-01T00:00:00Z',
      name: 'Updated Name',
    } as Partial<TelescopeProfile>);
    expect(updated?.id).toBe('test-1');
    expect(updated?.createdAt).toBe('2024-01-01T00:00:00Z');
  });

  it('updateProfile returns null for unknown id', () => {
    const result = updateProfile('nonexistent-id', { name: 'Ghost' });
    expect(result).toBeNull();
  });

  it('deleteProfile removes second profile', () => {
    const second = createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    expect(getAllProfiles()).toHaveLength(2);

    const result = deleteProfile(second.id);
    expect(result).toBe(true);
    expect(getAllProfiles()).toHaveLength(1);
    expect(getAllProfiles()[0].id).toBe('test-1');
  });

  it('deleteProfile returns false if only one profile remains', () => {
    const result = deleteProfile('test-1');
    expect(result).toBe(false);
    expect(getAllProfiles()).toHaveLength(1);
  });

  it('deleteProfile returns false for unknown id', () => {
    createProfile({ name: 'Second Scope', hostname: '10.0.0.2' });
    const result = deleteProfile('nonexistent-id');
    expect(result).toBe(false);
  });

  it('getFullSettings returns settings with telescopes array', () => {
    const settings = getFullSettings();
    // beforeEach inserts exactly one profile (id 'test-1'), so the array
    // length and contents are knowable. `>= 1` would pass for duplicates.
    expect(settings.telescopes).toHaveLength(1);
    expect(settings.telescopes[0].id).toBe('test-1');
  });
});

// ─── Optical configurations (Framing & Mosaic FOV preview) ─────────────────
// One `other`/`asiair` telescope profile can carry several named optical
// configs ("Native", "0.8x Reducer", ...) in telescopeOpticalConfigs, each a
// distinct focal length/sensor/pixel-pitch spec; `activeOpticalConfigId` on
// the profile says which is currently mounted. See
// src/lib/telescopeFov.ts's resolveFov for how the client turns these into
// an actual FOV.
describe('telescope optical configs', () => {
  // A global afterEach (tests/setup.ts) wipes telescopeProfiles between every
  // test in the suite to prevent cross-file leakage, so — like the sibling
  // `describe('telescopes')` block above — this needs its own beforeEach
  // rather than relying on state left over from a previous test.
  // telescopeOpticalConfigs isn't in that shared-table list, but its rows
  // cascade-delete with their profile (ON DELETE CASCADE), so wiping
  // telescopeProfiles here is enough to keep both tables clean per test.
  beforeEach(() => {
    db.prepare('DELETE FROM telescopeProfiles').run();
    db.prepare(`
      INSERT INTO telescopeProfiles (id, name, model, kind, hostname, shareName, username, password, isActive, createdAt)
      VALUES ('test-1', 'Bare Rig', 'Custom', 'other', '10.0.0.1', 'EMMC Images', 'guest', '', 0, '2024-01-01T00:00:00Z')
    `).run();
  });

  it('a profile starts with no optical configs and activeOpticalConfigId null', () => {
    const profile = getAllProfiles()[0];
    expect(getOpticalConfigsForProfile(profile.id)).toEqual([]);
    expect(profile.activeOpticalConfigId).toBeNull();
  });

  it('addOpticalConfig stores a full spec and defaults pixelSizeUm to null when omitted', () => {
    const config = addOpticalConfig('test-1', {
      name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7,
    });
    expect(config.name).toBe('Native');
    expect(config.focalLengthMm).toBe(2000);
    expect(config.pixelSizeUm).toBeNull();
    expect(config.profileId).toBe('test-1');

    const withPixels = addOpticalConfig('test-1', {
      name: '0.8x Reducer', focalLengthMm: 1600, sensorWidthMm: 23.5, sensorHeightMm: 15.7, pixelSizeUm: 3.76,
    });
    expect(withPixels.pixelSizeUm).toBe(3.76);

    // Both configs coexist on the same profile — the whole point.
    const configs = getOpticalConfigsForProfile('test-1');
    expect(configs).toHaveLength(2);
    expect(configs.map(c => c.name)).toEqual(['Native', '0.8x Reducer']);
  });

  it('updateOpticalConfig changes fields and round-trips through a fresh read', () => {
    const config = addOpticalConfig('test-1', { name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const updated = updateOpticalConfig(config.id, { name: 'Native (no reducer)', focalLengthMm: 2032 });
    expect(updated?.name).toBe('Native (no reducer)');
    expect(updated?.focalLengthMm).toBe(2032);
    // Fields not in the patch are preserved, not zeroed.
    expect(updated?.sensorWidthMm).toBe(23.5);

    const reread = getOpticalConfigsForProfile('test-1').find(c => c.id === config.id);
    expect(reread?.name).toBe('Native (no reducer)');
  });

  it('updateOpticalConfig returns null for an unknown id', () => {
    expect(updateOpticalConfig('nonexistent-id', { name: 'Ghost' })).toBeNull();
  });

  it('deleteOpticalConfig removes the row (deleting the only one is allowed)', () => {
    const config = addOpticalConfig('test-1', { name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    expect(deleteOpticalConfig(config.id)).toBe(true);
    expect(getOpticalConfigsForProfile('test-1')).toEqual([]);
  });

  it('deleteOpticalConfig returns false for an unknown id', () => {
    expect(deleteOpticalConfig('nonexistent-id')).toBe(false);
  });

  it('deleting the profile\'s active config clears activeOpticalConfigId back to null', () => {
    const config = addOpticalConfig('test-1', { name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    updateProfile('test-1', { activeOpticalConfigId: config.id });
    expect(getAllProfiles().find(p => p.id === 'test-1')?.activeOpticalConfigId).toBe(config.id);

    deleteOpticalConfig(config.id);
    const profile = getAllProfiles().find(p => p.id === 'test-1');
    expect(profile?.activeOpticalConfigId).toBeNull();
  });

  it('deleting a config that is not the active one leaves activeOpticalConfigId untouched', () => {
    const active = addOpticalConfig('test-1', { name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const other = addOpticalConfig('test-1', { name: '0.8x Reducer', focalLengthMm: 1600, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    updateProfile('test-1', { activeOpticalConfigId: active.id });

    deleteOpticalConfig(other.id);
    const profile = getAllProfiles().find(p => p.id === 'test-1');
    expect(profile?.activeOpticalConfigId).toBe(active.id);
  });

  it('updateProfile round-trips activeOpticalConfigId, including clearing it back to null', () => {
    const config = addOpticalConfig('test-1', { name: 'Native', focalLengthMm: 2000, sensorWidthMm: 23.5, sensorHeightMm: 15.7 });
    const withActive = updateProfile('test-1', { activeOpticalConfigId: config.id });
    expect(withActive?.activeOpticalConfigId).toBe(config.id);

    const cleared = updateProfile('test-1', { activeOpticalConfigId: null });
    expect(cleared?.activeOpticalConfigId).toBeNull();
  });

  it('optical configs cascade-delete when their profile is deleted', () => {
    createProfile({ name: 'Second Scope', kind: 'other', hostname: '10.0.0.2' });
    const second = getAllProfiles().find(p => p.name === 'Second Scope')!;
    addOpticalConfig(second.id, { name: 'Native', focalLengthMm: 400, sensorWidthMm: 5.6, sensorHeightMm: 3.2 });
    expect(getOpticalConfigsForProfile(second.id)).toHaveLength(1);

    deleteProfile(second.id);
    expect(getOpticalConfigsForProfile(second.id)).toEqual([]);
  });
});

// ─── Settings round-trip: temperatureUnit / groupObservingNights ─────────────
// Regression coverage for the C-1 bug: rowToSettings (read) and
// saveSettingsRow (write) each had their own default for an unset value, and
// the two disagreed. These tests flip the real appSettings row (shared
// across backend test files against one DB — see telescopeFiles.test.ts's
// toggle tests), so every test restores it afterward.
describe('settings round-trip (temperatureUnit / groupObservingNights)', () => {
  afterEach(() => {
    updateSettingsData({ temperatureUnit: 'fahrenheit', groupObservingNights: true });
  });

  it('round-trips an explicit temperatureUnit change', () => {
    updateSettingsData({ temperatureUnit: 'celsius' });
    expect(getSettingsData().temperatureUnit).toBe('celsius');
    updateSettingsData({ temperatureUnit: 'fahrenheit' });
    expect(getSettingsData().temperatureUnit).toBe('fahrenheit');
  });

  it('round-trips an explicit groupObservingNights change', () => {
    updateSettingsData({ groupObservingNights: false });
    expect(getSettingsData().groupObservingNights).toBe(false);
    updateSettingsData({ groupObservingNights: true });
    expect(getSettingsData().groupObservingNights).toBe(true);
  });

  it('regression (C-1): an explicit null falls back to the same default on write and read', () => {
    // A client PUT body with an explicit `null` (rather than omitting the
    // key entirely) exercises saveSettingsRow's write-side default directly.
    // Before the fix this persisted 'celsius' while the read-side default
    // for an unset value was 'fahrenheit' — same "no value", two different
    // answers depending on which function last touched the row.
    updateSettingsData({ temperatureUnit: null });
    expect(getSettingsData().temperatureUnit).toBe('fahrenheit');
  });

  it('a partial update does not disturb an unrelated field', () => {
    updateSettingsData({ groupObservingNights: false });
    updateSettingsData({ temperatureUnit: 'celsius' });
    expect(getSettingsData().groupObservingNights).toBe(false);
    expect(getSettingsData().temperatureUnit).toBe('celsius');
  });
});

// ─── apiKey sealing round-trip ────────────────────────────────────────────
// The admin API key used to be stored in appSettings.apiKey as plaintext.
// getSettingsData()/updateSettingsData() are what routes/settings.ts's
// masked-preview logic (`current.apiKey.slice(0,8)+'...'`) and its
// don't-overwrite-with-the-masked-placeholder guard both depend on — if
// updateSettingsData ever stopped decrypting on read, that guard would
// silently compare against ciphertext and every unrelated settings save
// would clobber the real key with the literal masked string.
describe('settings round-trip (apiKey sealing)', () => {
  afterEach(() => {
    updateSettingsData({ apiKey: '' });
  });

  it('is stored encrypted at rest but reads back as plaintext', () => {
    updateSettingsData({ apiKey: 'shub_plaintext_round_trip' });
    expect(getSettingsData().apiKey).toBe('shub_plaintext_round_trip');

    const raw = db.prepare<[], { apiKey: string }>('SELECT apiKey FROM appSettings WHERE id = 1').get();
    expect(raw?.apiKey).not.toBe('shub_plaintext_round_trip');
    // secretBox's `<nonce>.<tag>.<ciphertext>` format.
    expect(raw?.apiKey.split('.')).toHaveLength(3);
  });

  it('a partial update to an unrelated field does not disturb the key', () => {
    updateSettingsData({ apiKey: 'shub_survives_unrelated_update' });
    updateSettingsData({ temperatureUnit: 'celsius' });
    expect(getSettingsData().apiKey).toBe('shub_survives_unrelated_update');
    updateSettingsData({ temperatureUnit: 'fahrenheit' });
  });

  it('clearing the key stores an empty string, not a sealed empty blob', () => {
    updateSettingsData({ apiKey: 'shub_to_be_cleared' });
    updateSettingsData({ apiKey: '' });
    expect(getSettingsData().apiKey).toBe('');
    const raw = db.prepare<[], { apiKey: string }>('SELECT apiKey FROM appSettings WHERE id = 1').get();
    expect(raw?.apiKey).toBe('');
  });
});
