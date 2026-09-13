import { describe, it, expect } from 'vitest';
import {
  calibrationTypeForFolderName,
  calibrationTypeLabel,
  isCalibrationFolderName,
  parseCalibrationFilename,
  CALIBRATION_FOLDER_NAMES,
} from '../../server/lib/library/calibrationFolders';

describe('calibrationTypeForFolderName', () => {
  it('recognizes singular and plural bias/dark/flat folder names, case-insensitively', () => {
    expect(calibrationTypeForFolderName('Bias')).toBe('bias');
    expect(calibrationTypeForFolderName('bias')).toBe('bias');
    expect(calibrationTypeForFolderName('Biases')).toBe('bias');
    expect(calibrationTypeForFolderName('Dark')).toBe('dark');
    expect(calibrationTypeForFolderName('Darks')).toBe('dark');
    expect(calibrationTypeForFolderName('DARKS')).toBe('dark');
    expect(calibrationTypeForFolderName('Flat')).toBe('flat');
    expect(calibrationTypeForFolderName('Flats')).toBe('flat');
  });

  it('recognizes every flat-dark folder name variant', () => {
    for (const name of [
      'FlatDark', 'FlatDarks', 'Flat_Dark', 'Flat_Darks', 'Flat-Dark', 'Flat-Darks',
      'DarkFlat', 'DarkFlats', 'Dark_Flat', 'Dark_Flats', 'Dark-Flat', 'Dark-Flats',
    ]) {
      expect(calibrationTypeForFolderName(name)).toBe('flatDark');
    }
  });

  it('treats Dwarf\'s DWARF_DARK as a dark folder and CALI_FRAME as mixed', () => {
    expect(calibrationTypeForFolderName('DWARF_DARK')).toBe('dark');
    expect(calibrationTypeForFolderName('CALI_FRAME')).toBe('mixed');
    expect(calibrationTypeForFolderName('cali_frame')).toBe('mixed');
  });

  it('returns null for ordinary object folders, including ones that merely contain the word', () => {
    expect(calibrationTypeForFolderName('M31')).toBeNull();
    expect(calibrationTypeForFolderName('Dark Nebulae Targets')).toBeNull();
    expect(calibrationTypeForFolderName('Darkness')).toBeNull();
  });

  it('isCalibrationFolderName agrees with calibrationTypeForFolderName', () => {
    expect(isCalibrationFolderName('Darks')).toBe(true);
    expect(isCalibrationFolderName('M31')).toBe(false);
  });

  it('CALIBRATION_FOLDER_NAMES covers every name the function recognizes', () => {
    for (const name of ['bias', 'darks', 'flats', 'flatdark', 'dwarf_dark', 'cali_frame']) {
      expect(CALIBRATION_FOLDER_NAMES).toContain(name);
    }
  });
});

describe('calibrationTypeLabel', () => {
  it('gives each type a human-facing label', () => {
    expect(calibrationTypeLabel('bias')).toBe('Bias');
    expect(calibrationTypeLabel('dark')).toBe('Darks');
    expect(calibrationTypeLabel('flat')).toBe('Flats');
    expect(calibrationTypeLabel('flatDark')).toBe('Flat darks');
    expect(calibrationTypeLabel('mixed')).toBe('Calibration (mixed)');
  });
});

describe('parseCalibrationFilename', () => {
  it('parses the ASIAIR-style bias filename shown in the real library (dot decimals)', () => {
    const info = parseCalibrationFilename('Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit');
    expect(info).toEqual({
      exposureSec: 5.0,
      binning: 1,
      filterLabel: 'Dark',
      gain: 100,
      cameraAngleDeg: 2,
      sensorTempC: -8.0,
      sequence: 1,
      capturedAt: new Date('2026-08-15T19:32:19').toISOString(),
    });
  });

  it('parses a dark filename with a decimal exposure and negative sensor temp', () => {
    const info = parseCalibrationFilename('Dark_60.0s_Bin1_Dark_gain100_20260814-191008_2deg_-7.7C_0001.fit');
    expect(info?.exposureSec).toBe(60.0);
    expect(info?.sensorTempC).toBe(-7.7);
    expect(info?.sequence).toBe(1);
  });

  // ASIAIR calibration frames follow the exact same naming convention as its
  // light frames — telescopeFiles.ts's parseFilename validated this shape
  // against real captured hardware (see tests/backend/telescopeFiles.test.ts).
  // The two quirks confirmed there apply here too: decimal points come out as
  // underscores, and the `_<n>deg_` field is Camera Angle, not a temperature.

  it('parses underscore-as-decimal exposure and temperature, matching real ASIAIR output', () => {
    const info = parseCalibrationFilename('Dark_120_0s_Bin1_None_gain100_20260904-051928_2deg_-8_0C_0207.fit');
    expect(info?.exposureSec).toBe(120.0);
    expect(info?.sensorTempC).toBe(-8.0);
    expect(info?.cameraAngleDeg).toBe(2);
    expect(info?.sequence).toBe(207);
    expect(info?.filterLabel).toBe('None');
  });

  it('converts a millisecond exposure to seconds', () => {
    const info = parseCalibrationFilename('Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit');
    expect(info?.exposureSec).toBe(0.001);
    expect(info?.filterLabel).toBe('S');
    expect(info?.sensorTempC).toBe(-10.5);
  });

  it('parses a minimal filename with no filter, gain, angle, or temperature', () => {
    // Real example straight from telescopeFiles.ts's ASIAIR docs.
    const info = parseCalibrationFilename('Dark_60s_Bin1_20250723-13073265_0018.fit');
    expect(info?.exposureSec).toBe(60);
    expect(info?.binning).toBe(1);
    expect(info?.gain).toBeUndefined();
    expect(info?.filterLabel).toBeUndefined();
    expect(info?.sensorTempC).toBeUndefined();
    expect(info?.cameraAngleDeg).toBeUndefined();
  });

  it('skips an ASI Camera Model token and still finds gain and filter correctly', () => {
    const info = parseCalibrationFilename('Dark_180s_Bin1_R_6200MC_gain100_20111128-080808_180deg_-20C_0001.fit');
    expect(info?.filterLabel).toBe('R');
    expect(info?.gain).toBe(100);
    expect(info?.cameraAngleDeg).toBe(180);
    expect(info?.sensorTempC).toBe(-20);
  });

  it('returns null for a filename that does not match the pattern', () => {
    expect(parseCalibrationFilename('random-file.txt')).toBeNull();
    expect(parseCalibrationFilename('Stacked_150_M42_10.0s_IRCUT_20241015-210530A.fit')).toBeNull();
  });
});
