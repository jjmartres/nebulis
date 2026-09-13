/**
 * Optical configuration rows attached to a telescope profile. One profile can
 * carry several — e.g. a bare OTA imaged through an ASIAIR both natively and
 * through a 0.8x reducer/flattener, each a distinct focal length (and
 * possibly sensor/pixel pitch, if the camera changed too). Only meaningful
 * for `other`/`asiair` kinds, the two with no known fixed field of view in
 * `FOV_PROFILES` (client-side, src/lib/telescopeFov.ts) — a supported
 * smart-telescope kind always uses its lookup entry instead, regardless of
 * what's stored here.
 *
 * Unlike telescopeTransports (whose "active" one is picked automatically by
 * reachability), there's no way to auto-detect which optical train is
 * physically mounted right now — `telescopeProfiles.activeOpticalConfigId` is
 * a plain user choice, set explicitly.
 */
import { randomUUID } from 'crypto';
import db from './db.js';

export interface TelescopeOpticalConfig {
  id: string;
  profileId: string;
  /** e.g. "Native", "0.8x Reducer". */
  name: string;
  focalLengthMm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  /** Pixel pitch in microns. Optional — only drives the arcsec/pixel readout. */
  pixelSizeUm: number | null;
  createdAt: string;
}

interface TelescopeOpticalConfigRow {
  id: string;
  profileId: string;
  name: string;
  focalLengthMm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  pixelSizeUm: number | null;
  createdAt: string;
}

const stmts = {
  getByProfile: db.prepare<[string], TelescopeOpticalConfigRow>(
    'SELECT * FROM telescopeOpticalConfigs WHERE profileId = ? ORDER BY createdAt ASC',
  ),
  getById: db.prepare<[string], TelescopeOpticalConfigRow>(
    'SELECT * FROM telescopeOpticalConfigs WHERE id = ?',
  ),
  insert: db.prepare(
    `INSERT INTO telescopeOpticalConfigs
       (id, profileId, name, focalLengthMm, sensorWidthMm, sensorHeightMm, pixelSizeUm, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  update: db.prepare(
    `UPDATE telescopeOpticalConfigs
        SET name = ?, focalLengthMm = ?, sensorWidthMm = ?, sensorHeightMm = ?, pixelSizeUm = ?
      WHERE id = ?`,
  ),
  delete: db.prepare('DELETE FROM telescopeOpticalConfigs WHERE id = ?'),
  clearActiveIfMatches: db.prepare(
    'UPDATE telescopeProfiles SET activeOpticalConfigId = NULL WHERE activeOpticalConfigId = ?',
  ),
};

function rowToConfig(row: TelescopeOpticalConfigRow): TelescopeOpticalConfig {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    focalLengthMm: row.focalLengthMm,
    sensorWidthMm: row.sensorWidthMm,
    sensorHeightMm: row.sensorHeightMm,
    pixelSizeUm: row.pixelSizeUm ?? null,
    createdAt: row.createdAt,
  };
}

export function getOpticalConfigsForProfile(profileId: string): TelescopeOpticalConfig[] {
  return stmts.getByProfile.all(profileId).map(rowToConfig);
}

export function getOpticalConfigById(id: string): TelescopeOpticalConfig | null {
  const row = stmts.getById.get(id);
  return row ? rowToConfig(row) : null;
}

export function addOpticalConfig(
  profileId: string,
  data: { name: string; focalLengthMm: number; sensorWidthMm: number; sensorHeightMm: number; pixelSizeUm?: number | null },
): TelescopeOpticalConfig {
  const config: TelescopeOpticalConfig = {
    id: randomUUID(),
    profileId,
    name: data.name,
    focalLengthMm: data.focalLengthMm,
    sensorWidthMm: data.sensorWidthMm,
    sensorHeightMm: data.sensorHeightMm,
    pixelSizeUm: data.pixelSizeUm ?? null,
    createdAt: new Date().toISOString(),
  };
  stmts.insert.run(
    config.id, config.profileId, config.name,
    config.focalLengthMm, config.sensorWidthMm, config.sensorHeightMm, config.pixelSizeUm,
    config.createdAt,
  );
  return config;
}

export function updateOpticalConfig(
  id: string,
  data: Partial<Pick<TelescopeOpticalConfig, 'name' | 'focalLengthMm' | 'sensorWidthMm' | 'sensorHeightMm' | 'pixelSizeUm'>>,
): TelescopeOpticalConfig | null {
  const existing = stmts.getById.get(id);
  if (!existing) return null;
  const current = rowToConfig(existing);
  const merged: TelescopeOpticalConfig = { ...current, ...data };
  stmts.update.run(
    merged.name, merged.focalLengthMm, merged.sensorWidthMm, merged.sensorHeightMm, merged.pixelSizeUm,
    id,
  );
  const refreshed = stmts.getById.get(id);
  return refreshed ? rowToConfig(refreshed) : null;
}

/** Deletes a config. If it was the profile's active pick, clears that back to
 *  NULL (falls back to the oldest remaining config, or a generic default with
 *  none left) rather than leaving a dangling reference. */
export function deleteOpticalConfig(id: string): boolean {
  const existing = stmts.getById.get(id);
  if (!existing) return false;
  stmts.delete.run(id);
  stmts.clearActiveIfMatches.run(id);
  return true;
}
