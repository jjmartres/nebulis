/**
 * Translates the moon-phase name the server (server/lib/astroCalc.ts's
 * moonPhaseName) and the client's own future-night calculation
 * (plannerNight.ts's moonPhaseNameFor) both emit as plain English — a closed
 * set of exactly 8 values, so a lookup table is safe here in a way it isn't
 * for open-ended server prose (see deviceWording.ts, deferred to chunk 9).
 * An unrecognized value passes through unchanged rather than throwing, so a
 * future server-side wording tweak degrades to showing English instead of
 * breaking the page.
 */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const MOON_PHASE_KEYS: Record<string, string> = {
  'New Moon': 'moonPhase.newMoon',
  'Waxing Crescent': 'moonPhase.waxingCrescent',
  'First Quarter': 'moonPhase.firstQuarter',
  'Waxing Gibbous': 'moonPhase.waxingGibbous',
  'Full Moon': 'moonPhase.fullMoon',
  'Waning Gibbous': 'moonPhase.waningGibbous',
  'Last Quarter': 'moonPhase.lastQuarter',
  'Waning Crescent': 'moonPhase.waningCrescent',
  'Unknown': 'moonPhase.unknown',
};

export function translateMoonPhase(t: TFunc, phase: string): string {
  const key = MOON_PHASE_KEYS[phase];
  return key ? t(key, { ns: 'common' }) : phase;
}
