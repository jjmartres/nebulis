/**
 * Calibration-frame folder recognition and filename metadata.
 *
 * `objectDiscovery.ts` already excluded ASIAIR's flat `Dark/`, `Flat/`,
 * `Bias/` folders (singular, no target) from object discovery, and
 * `archiveFolders.ts`/`import.ts` already archive Dwarf's `CALI_FRAME`/
 * `DWARF_DARK` unconditionally. Neither recognized the shape a lot of real
 * calibration libraries actually take: plural folder names (`Darks`, `Flats`,
 * `Bias`), a "flat dark" frame type ASIAIR/N.I.N.A. users commonly shoot but
 * which had no folder-name mapping at all, and per-setup subfolders (one per
 * gain/exposure/binning/temperature combination, e.g. `G100_TECm8`,
 * `G100_60s_TECm8`) nested a level below the frame-type folder.
 *
 * A folder-import wizard run pointed at that shape today either drops the
 * plural folders on the floor entirely (not recognized as non-observation,
 * so `isObjectFolder` accepts them — they'd import as bogus objects named
 * "Darks" whose "sessions" are per-camera-setting subfolders) or, for the
 * singular ASIAIR names, only archives them when "archive everything" is on.
 * Both are wrong for data the whole point of this module is to give a real
 * home to. See archiveFolders.ts's file-level comment for the "promoted into
 * a real calibration-frame feature later" note this is that migration.
 *
 * Kept separate from objectDiscovery.ts (which owns folder-exclusion rules in
 * general) because this module also owns the filename metadata parse, which
 * objectDiscovery.ts has no reason to know about.
 */

export type CalibrationFrameType = 'bias' | 'dark' | 'flat' | 'flatDark';

/** Human-facing label for a recognized calibration frame type. `mixed` covers
 *  Dwarf's `CALI_FRAME`, which is not a single frame type — see
 *  `CALIBRATION_FOLDER_TYPE` below. */
export function calibrationTypeLabel(type: CalibrationFrameType | 'mixed'): string {
  switch (type) {
    case 'bias': return 'Bias';
    case 'dark': return 'Darks';
    case 'flat': return 'Flats';
    case 'flatDark': return 'Flat darks';
    case 'mixed': return 'Calibration (mixed)';
  }
}

/**
 * Every folder name (lowercased) recognized as holding calibration frames,
 * mapped to the frame type it holds. Singular and plural both included since
 * real libraries use either (ASIAIR itself writes singular; a lot of manual/
 * NINA-organized libraries use plural). `cali_frame` is Dwarf's folder and
 * holds a blend of frame types rather than one, so it is handled separately
 * as `'mixed'` rather than living in this map — `dwarf_dark` does hold one
 * type (dark) and is included here directly.
 */
const CALIBRATION_FOLDER_TYPE: Readonly<Record<string, CalibrationFrameType>> = {
  bias: 'bias',
  biases: 'bias',
  dark: 'dark',
  darks: 'dark',
  dwarf_dark: 'dark',
  flat: 'flat',
  flats: 'flat',
  flatdark: 'flatDark',
  flatdarks: 'flatDark',
  flat_dark: 'flatDark',
  flat_darks: 'flatDark',
  'flat-dark': 'flatDark',
  'flat-darks': 'flatDark',
  darkflat: 'flatDark',
  darkflats: 'flatDark',
  dark_flat: 'flatDark',
  dark_flats: 'flatDark',
  'dark-flat': 'flatDark',
  'dark-flats': 'flatDark',
};

/** Dwarf's mixed-content calibration folder — handled outside
 *  `CALIBRATION_FOLDER_TYPE` because it is not one frame type. */
const MIXED_CALIBRATION_FOLDER = 'cali_frame';

/** Every recognized folder name, lowercased, including the mixed one. Used by
 *  `import.ts` to build its "always archive, regardless of archiveAllFiles"
 *  folder list — the superset this module exists to widen. */
export const CALIBRATION_FOLDER_NAMES: readonly string[] = [
  ...Object.keys(CALIBRATION_FOLDER_TYPE),
  MIXED_CALIBRATION_FOLDER,
];

/** The frame type a folder name maps to, or `'mixed'` for Dwarf's blended
 *  folder, or null when the name isn't a recognized calibration folder.
 *  Case-insensitive, exact-match only (a user's own folder that merely
 *  contains one of these words, e.g. "Dark Nebulae Targets", must not match —
 *  same guarantee `isNonObjectFolder` gives every other entry). */
export function calibrationTypeForFolderName(name: string): CalibrationFrameType | 'mixed' | null {
  const lower = name.toLowerCase();
  if (lower === MIXED_CALIBRATION_FOLDER) return 'mixed';
  return CALIBRATION_FOLDER_TYPE[lower] ?? null;
}

/** True for any folder name this module recognizes as calibration data. */
export function isCalibrationFolderName(name: string): boolean {
  return calibrationTypeForFolderName(name) !== null;
}

export interface CalibrationFrameInfo {
  /** Exposure length in seconds, when the filename encodes one (a `ms` unit
   *  is converted to seconds). */
  exposureSec?: number;
  /** Sensor binning (1 = 1x1, 2 = 2x2, ...). */
  binning?: number;
  /** Camera gain setting. Absent for ISO-based (DSLR) rigs, which encode
   *  `ISO<n>` in the same filename slot instead of `gain<n>` — not surfaced
   *  as a separate field since it isn't this codebase's concern anywhere
   *  else either (telescopeFiles.ts's own ASIAIR parser only treats it as
   *  "not a filter", the same way this one does). */
  gain?: number;
  /** The token between Bin<n> and gain/ISO. Usually a filter-wheel slot
   *  name; for bias/dark captures behind a filter wheel this is often a
   *  fixed "Dark"/blank-slot label rather than a real filter, so it is kept
   *  generic rather than assumed to be a color filter. */
  filterLabel?: string;
  /** Sensor (CCD/CMOS) temperature in Celsius at capture time. */
  sensorTempC?: number;
  /** ASIAIR's "Camera Angle" field (degrees of sensor/field rotation) — a
   *  real, independently toggleable field on the device's own "Customize
   *  File Name" screen, not a temperature reading (see
   *  telescopeFiles.ts's validated ASIAIR parser for the same field). */
  cameraAngleDeg?: number;
  /** When the frame was captured, derived from the filename's timestamp. */
  capturedAt?: string;
  /** Frame sequence number within its capture run. */
  sequence?: number;
}

/** `120_0` -> `120.0`, `-8.0` -> `-8.0`: ASIAIR writes decimal points as
 *  underscores on-device (confirmed against real hardware — see
 *  telescopeFiles.ts's ASIAIR filename docs), though older captures/tooling
 *  may still produce a literal dot; both are accepted. */
function toDecimal(raw: string): number {
  return Number(raw.replace('_', '.'));
}

/**
 * Parse the metadata a calibration frame's own filename encodes.
 *
 * ASIAIR calibration frames (Dark/Flat/Bias) follow the *exact same*
 * filename convention as its light frames — telescopeFiles.ts's
 * `parseFilename` documents the validated shape in full, including the two
 * quirks confirmed against real hardware this pattern mirrors: decimal points
 * come out as underscores, and `_<n>deg_` is the real "Camera Angle" field,
 * not a temperature. This module needs the additional gain/binning/
 * temperature/angle fields a light frame's parser has no reason to expose
 * (it only needs target/exposure/filter/timestamp), so the pattern is
 * duplicated here rather than shared — but it is intentionally kept in
 * lock-step with telescopeFiles.ts's `asiairMatch` regex; widen that one,
 * widen this one too.
 *
 *   Bias_5.0s_Bin1_Dark_gain100_20260815-193219_2deg_-8.0C_0001.fit
 *   Dark_120_0s_Bin1_None_gain100_20260904-051928_2deg_-8_0C_0207.fit
 *   Flat_1.0ms_Bin1_S_gain100_20240320-233122_-10.5C_0001.fit
 *
 * Best-effort: returns null for anything that doesn't match rather than
 * guessing, since a file that fails to parse is still listed (just without
 * the derived chips) rather than dropped.
 *
 * Unlike telescopeFiles.ts's light-frame `asiairMatch`, this pattern has no
 * optional leading target group: calibration frames never carry a target
 * token (per that same module's own comment), and including one anyway
 * introduced a real ambiguity — its lazy `.+?_` happily swallowed the leading
 * digits of an underscore-decimal exposure (`120_0s` parsed as target `"120"`
 * + exposure `"0"`) since the rest of the pattern is lax enough to still
 * match what's left. Dropping the group entirely (calibration frames don't
 * need a target field here regardless) resolves it cleanly rather than
 * tightening the ambiguity away some other way.
 */
const CALIBRATION_FILENAME_RE =
  /^[A-Za-z]+_(?<exp>\d+(?:[._]\d+)?)(?<unit>m?s)_Bin(?<bin>\d+)(?<middle>(?:_[A-Za-z0-9+-]+)*?)_(?<date>\d{8})-(?<time>\d{6})\d*(?:_(?<angle>\d+)deg)?(?:_(?<temp>-?\d+(?:[._]\d+)?)C)?(?:_(?<seq>\d+))?\.[^.]+$/i;

export function parseCalibrationFilename(name: string): CalibrationFrameInfo | null {
  const m = CALIBRATION_FILENAME_RE.exec(name);
  if (!m?.groups) return null;
  const g = m.groups;

  const exposureRaw = toDecimal(g.exp);
  const info: CalibrationFrameInfo = {
    exposureSec: g.unit.toLowerCase() === 'ms' ? exposureRaw / 1000 : exposureRaw,
    binning: Number(g.bin),
  };

  // gain<n>/ISO<n> is the exposure setting, not a filter — the ASI Camera
  // Model token, when present, sits alongside it in the same chunk. Whichever
  // token comes first that isn't gain/ISO is the filter/filter-wheel-slot
  // label. Mirrors telescopeFiles.ts's identical ASIAIR light-frame logic
  // exactly, since the two share this middle chunk's shape.
  const tokens = g.middle.split('_').filter(Boolean);
  const gainToken = tokens.find(t => /^gain\d+$/i.test(t));
  if (gainToken) info.gain = Number(gainToken.slice(4));
  const filterToken = tokens.find(t => !/^(?:gain\d+|ISO\d+)$/i.test(t));
  if (filterToken) info.filterLabel = filterToken;

  if (g.angle !== undefined) info.cameraAngleDeg = Number(g.angle);
  if (g.temp !== undefined) info.sensorTempC = toDecimal(g.temp);
  if (g.seq !== undefined) info.sequence = Number(g.seq);

  // YYYYMMDD-HHMMSS, always local to wherever the telescope/capture box's
  // clock was set — there is no timezone in the filename to do better than
  // that, same limitation SeeStar/Dwarf filename timestamps have elsewhere
  // in telescopeFiles.ts.
  const { date, time } = g;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  const parsed = new Date(iso);
  if (!isNaN(parsed.getTime())) info.capturedAt = parsed.toISOString();

  return info;
}
