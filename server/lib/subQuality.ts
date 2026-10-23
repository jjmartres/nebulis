/**
 * Sub-frame quality measured from the pixels.
 *
 * `scoreSubFrame` (fitsParser.ts) grades a sub from HFR / FWHM / star-count
 * header keywords, but most capture software (ASIAIR, Dwarf, SeeStar) never
 * writes them, so every sub got the same baseline grade. This measures them
 * from the image itself:
 *
 *   1. Decode (shared with the trail detector) and, for an un-debayered CFA
 *      mosaic, 2x2-bin to a luminance image with no Bayer pattern.
 *   2. Background and noise from a sparse sample: median and MAD·1.4826.
 *   3. Star candidates: local maxima at least DETECT_SIGMA·noise above the
 *      background, not saturated, not near an edge, each the brightest pixel
 *      in its neighbourhood.
 *   4. For the brightest MAX_MEASURED stars: background-subtracted moments in
 *      a small box → centroid, HFR (flux-weighted mean radius, the NINA /
 *      PixInsight-style definition), FWHM from the second moments
 *      (2.3548·σ, Gaussian assumption) and eccentricity √(1 − λmin/λmax).
 *   5. Medians over the measured stars; sizes reported in original pixels.
 *
 * Deliberately simple and dependency-free: the goal is to rank subs within a
 * night (clouds, trailing, focus drift), not to replace PixInsight's
 * SubframeSelector.
 */
import type { FitsImageData } from './trailDetector.js';

export interface SubFrameMeasurement {
  /** Image size actually analysed (after CFA binning). */
  width: number;
  height: number;
  /** Median background, in ADU of the analysed image. */
  background: number;
  /** Robust noise (MAD·1.4826), ADU. */
  noise: number;
  /** Star candidates found (all, not just the measured ones). */
  stars: number;
  /** Medians over the measured stars, null when too few stars to say. */
  hfr: number | null;
  fwhm: number | null;
  eccentricity: number | null;
}

export const DETECT_SIGMA = 5;
export const MAX_MEASURED = 250;
/** Fewer stars than this and HFR/FWHM/eccentricity are left null. */
export const MIN_STARS_FOR_SHAPE = 5;
const BOX_RADIUS = 7;
const EDGE_MARGIN = BOX_RADIUS + 2;
const SATURATION_FRACTION = 0.995;

function median(values: ArrayLike<number>): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Luminance plane: CFA mosaics 2x2-binned (scale 2), others as-is. */
export function luminance(img: FitsImageData): { px: Float64Array; w: number; h: number; scale: number } {
  const { width: w, height: h, pixels } = img;
  if (!img.bayerPattern) {
    return { px: pixels instanceof Float64Array ? pixels : Float64Array.from(pixels), w, h, scale: 1 };
  }
  const w2 = Math.floor(w / 2);
  const h2 = Math.floor(h / 2);
  const out = new Float64Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = y * 2 * w;
    const r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const x0 = x * 2;
      out[y * w2 + x] = (pixels[r0 + x0] + pixels[r0 + x0 + 1] + pixels[r1 + x0] + pixels[r1 + x0 + 1]) / 4;
    }
  }
  return { px: out, w: w2, h: h2, scale: 2 };
}

/** Median and MAD-sigma from a sparse grid sample (fast on 8 MP frames). */
export function backgroundStats(px: Float64Array): { background: number; noise: number; max: number } {
  const step = Math.max(1, Math.floor(px.length / 200_000));
  const sample: number[] = [];
  let max = -Infinity;
  for (let i = 0; i < px.length; i += step) sample.push(px[i]);
  for (let i = 0; i < px.length; i++) if (px[i] > max) max = px[i];
  const bg = median(sample);
  const noise = median(sample.map(v => Math.abs(v - bg))) * 1.4826;
  return { background: bg, noise: noise > 0 ? noise : 1, max };
}

interface Candidate { x: number; y: number; peak: number }

/** Local maxima above threshold, brightest in a (2r+1)² neighbourhood. */
function findCandidates(px: Float64Array, w: number, h: number, background: number, threshold: number, saturation: number): Candidate[] {
  const out: Candidate[] = [];
  const r = 3;
  for (let y = EDGE_MARGIN; y < h - EDGE_MARGIN; y++) {
    const row = y * w;
    for (let x = EDGE_MARGIN; x < w - EDGE_MARGIN; x++) {
      const v = px[row + x];
      if (v < threshold) continue;
      // Saturated: at the data ceiling with a flat top (a neighbour there too).
      if (v >= saturation && (px[row + x - 1] >= saturation || px[row + x + 1] >= saturation
        || px[row - w + x] >= saturation || px[row + w + x] >= saturation)) continue;
      let isMax = true;
      for (let dy = -r; dy <= r && isMax; dy++) {
        const rr = (y + dy) * w;
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const n = px[rr + x + dx];
          // Ties: keep only the first in raster order so a flat-topped star
          // is counted once.
          if (n > v || (n === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
        }
      }
      // A lone hot pixel has neighbours at background level; a star spreads
      // over several pixels, so its 4 neighbours carry a good share of the peak.
      if (isMax) {
        const neighbours = (px[row + x - 1] + px[row + x + 1] + px[row - w + x] + px[row + w + x]) / 4;
        if (neighbours - background < (v - background) * 0.2) continue;
        out.push({ x, y, peak: v });
      }
    }
  }
  return out;
}

interface StarShape { hfr: number; fwhm: number; eccentricity: number }

/**
 * Shape of one star, robust to background noise:
 *   - local background from the box perimeter (median), so gradients and
 *     nebulosity don't bias the profile;
 *   - FWHM from the area above half maximum (2·√(A/π)), which noise barely
 *     moves for a detected star;
 *   - HFR and centroid over an aperture of 1.5·FWHM without clipping, so
 *     noise averages out instead of inflating the radius;
 *   - eccentricity from second moments of the pixels above 10 % of the peak.
 */
function measureStar(px: Float64Array, w: number, c: Candidate): StarShape | null {
  const R = BOX_RADIUS;
  const ring: number[] = [];
  for (let d = -R; d <= R; d++) {
    ring.push(px[(c.y - R) * w + c.x + d], px[(c.y + R) * w + c.x + d]);
    ring.push(px[(c.y + d) * w + c.x - R], px[(c.y + d) * w + c.x + R]);
  }
  const bg = median(ring);
  const peak = c.peak - bg;
  if (!(peak > 0)) return null;

  let halfArea = 0;
  for (let dy = -R + 1; dy < R; dy++) {
    const row = (c.y + dy) * w;
    for (let dx = -R + 1; dx < R; dx++) if (px[row + c.x + dx] - bg >= peak / 2) halfArea++;
  }
  const fwhm = 2 * Math.sqrt(halfArea / Math.PI);
  const ap = Math.min(R - 1, Math.max(3, 1.5 * fwhm));

  let sum = 0, sx = 0, sy = 0;
  for (let dy = -R + 1; dy < R; dy++) {
    const row = (c.y + dy) * w;
    for (let dx = -R + 1; dx < R; dx++) {
      if (dx * dx + dy * dy > ap * ap) continue;
      const f = px[row + c.x + dx] - bg;
      sum += f; sx += f * dx; sy += f * dy;
    }
  }
  if (!(sum > 0)) return null;
  const cx = sx / sum;
  const cy = sy / sum;

  let rsum = 0, msum = 0, mxx = 0, myy = 0, mxy = 0;
  for (let dy = -R + 1; dy < R; dy++) {
    const row = (c.y + dy) * w;
    for (let dx = -R + 1; dx < R; dx++) {
      const ux = dx - cx;
      const uy = dy - cy;
      const r2 = ux * ux + uy * uy;
      if (r2 > ap * ap) continue;
      const f = px[row + c.x + dx] - bg;
      rsum += f * Math.sqrt(r2);
      if (f >= peak * 0.1) { msum += f; mxx += f * ux * ux; myy += f * uy * uy; mxy += f * ux * uy; }
    }
  }
  const hfr = rsum / sum;
  if (!(hfr > 0) || !(msum > 0)) return null;
  mxx /= msum; myy /= msum; mxy /= msum;
  const tr = mxx + myy;
  const det = Math.sqrt(Math.max(0, ((mxx - myy) / 2) ** 2 + mxy * mxy));
  const l1 = tr / 2 + det;
  const l2 = Math.max(0, tr / 2 - det);
  if (!(l1 > 0)) return null;
  return { hfr, fwhm, eccentricity: Math.sqrt(Math.max(0, 1 - l2 / l1)) };
}

export function measureSubFrame(img: FitsImageData): SubFrameMeasurement {
  const { px, w, h, scale } = luminance(img);
  const { background, noise, max } = backgroundStats(px);
  const threshold = background + DETECT_SIGMA * noise;
  const saturation = background + (max - background) * SATURATION_FRACTION;

  const candidates = findCandidates(px, w, h, background, threshold, saturation);
  candidates.sort((a, b) => b.peak - a.peak);
  const shapes: StarShape[] = [];
  for (const c of candidates.slice(0, MAX_MEASURED)) {
    const s = measureStar(px, w, c);
    if (s) shapes.push(s);
  }

  const enough = shapes.length >= MIN_STARS_FOR_SHAPE;
  const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    width: w,
    height: h,
    background: round(background, 1),
    noise: round(noise, 2),
    stars: candidates.length,
    hfr: enough ? round(median(shapes.map(s => s.hfr)) * scale) : null,
    fwhm: enough ? round(median(shapes.map(s => s.fwhm)) * scale) : null,
    eccentricity: enough ? round(median(shapes.map(s => s.eccentricity))) : null,
  };
}

// ─── Grading within a night ─────────────────────────────────────────────────

export type SubFrameGradeLevel = 'good' | 'fair' | 'poor';
export type SubFrameFlag = 'soft' | 'very_soft' | 'few_stars' | 'very_few_stars' | 'bright_background' | 'elongated';

export interface GradeInput {
  stars: number;
  hfr: number | null;
  eccentricity: number | null;
  background: number;
}

export interface SubFrameGrade {
  grade: SubFrameGradeLevel;
  flags: SubFrameFlag[];
  /** Relative weight for stacking, 1 = typical sub of the night, 0..2. */
  weight: number;
}

/**
 * Grade each sub against its group's medians (one group per night and
 * filter), so "HFR 3" is judged against what the same optics delivered that
 * night rather than against fixed thresholds.
 */
export function gradeGroup(inputs: readonly GradeInput[]): SubFrameGrade[] {
  const valid = (xs: (number | null)[]) => xs.filter((v): v is number => v !== null && Number.isFinite(v));
  const medHfr = median(valid(inputs.map(i => i.hfr)));
  const medStars = median(inputs.map(i => i.stars));
  const medBg = median(inputs.map(i => i.background));
  const bgSpread = median(inputs.map(i => Math.abs(i.background - medBg))) * 1.4826 || Math.abs(medBg) * 0.05 || 1;

  return inputs.map(i => {
    const flags: SubFrameFlag[] = [];
    let penalty = 0;
    if (i.hfr !== null && medHfr > 0) {
      const r = i.hfr / medHfr;
      if (r > 1.35) { flags.push('very_soft'); penalty += 2; } else if (r > 1.15) { flags.push('soft'); penalty += 1; }
    }
    if (medStars > 0) {
      const r = i.stars / medStars;
      if (r < 0.5) { flags.push('very_few_stars'); penalty += 2; } else if (r < 0.75) { flags.push('few_stars'); penalty += 1; }
    }
    if (i.background - medBg > 4 * bgSpread && i.background > medBg * 1.1) { flags.push('bright_background'); penalty += 1; }
    if (i.eccentricity !== null && i.eccentricity > 0.6) { flags.push('elongated'); penalty += 1; }

    const grade: SubFrameGradeLevel = penalty >= 2 ? 'poor' : penalty === 1 ? 'fair' : 'good';
    const hfrTerm = i.hfr && medHfr ? (medHfr / i.hfr) ** 2 : 1;
    const starTerm = medStars > 0 ? i.stars / medStars : 1;
    const weight = Math.round(Math.max(0, Math.min(2, hfrTerm * starTerm)) * 100) / 100;
    return { grade, flags, weight };
  });
}
