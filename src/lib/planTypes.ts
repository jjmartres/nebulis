/**
 * Shared types for "Plan My Night" — the scheduling algorithm itself now runs
 * server-side (POST /planner/plan, see lib/api/planner.ts) so every client
 * agrees on the result. These are just the shapes the UI renders.
 */
import type { FilterBand, MoonVerdict } from './moonProximity';

export type AutoPlanFocus = 'all' | 'galaxies' | 'nebulae' | 'clusters';

/** Structural subset of a deep-sky object the planner engine needs. Both the
 *  planner's PlannerTarget and a catalog progress object satisfy this. */
export interface PlanCandidate {
  id: string;
  name: string;
  type: string;
  ra: number;
  dec: number;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  constellation: string | null;
  commonNames: string[];
  isAlreadyImaged: boolean;
}

export interface PlanBlock {
  target: PlanCandidate;
  start: Date;
  end: Date;
  meanAlt: number;
  moonSeparation: number;
  moonVerdict: MoonVerdict;
  /** Forecast for the block when the plan was built with the forecast. */
  sky?: PlanSkyQuality | null;
}

/** Mirrors server/lib/skyQuality.ts SlotSkyQuality. */
export interface PlanSkyQuality {
  cloudCover: number;
  /** 1 (best) – 5 */
  seeing: number | null;
  /** 1 (clearest) – 8 */
  transparency: number | null;
  dewRisk: boolean;
  usable: boolean;
}

/** Weather summary POST /planner/plan returns in the envelope's meta. */
export interface PlanWeatherSummary {
  requested: boolean;
  /** False when no forecast could be had; the plan then ignores weather. */
  used: boolean;
  forecastFetchedAt: string | null;
  maxCloudCover: number;
  skippedSlots: { start: Date; end: Date; cloudCover: number }[];
}
