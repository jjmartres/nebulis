import { describe, it, expect } from 'vitest';
import { measureSubFrame, gradeGroup, MIN_STARS_FOR_SHAPE } from '../../server/lib/subQuality';
import type { FitsImageData } from '../../server/lib/trailDetector';

/** Deterministic pseudo-random noise so the tests never flake. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface StarSpec { x: number; y: number; amp: number; sx: number; sy?: number }

function synth(w: number, h: number, stars: StarSpec[], opts: { bg?: number; noise?: number; hotPixels?: number } = {}): FitsImageData {
  const bg = opts.bg ?? 1000;
  const noise = opts.noise ?? 10;
  const rand = rng(42);
  const px = new Float64Array(w * h);
  for (let i = 0; i < px.length; i++) {
    // Box-Muller-ish: sum of uniforms approximates a Gaussian well enough.
    px[i] = bg + (rand() + rand() + rand() + rand() - 2) * noise * 1.7;
  }
  for (const s of stars) {
    const sy = s.sy ?? s.sx;
    for (let y = Math.max(0, Math.floor(s.y - 6 * sy)); y < Math.min(h, s.y + 6 * sy); y++) {
      for (let x = Math.max(0, Math.floor(s.x - 6 * s.sx)); x < Math.min(w, s.x + 6 * s.sx); x++) {
        px[y * w + x] += s.amp * Math.exp(-((x - s.x) ** 2) / (2 * s.sx ** 2) - ((y - s.y) ** 2) / (2 * sy ** 2));
      }
    }
  }
  for (let k = 0; k < (opts.hotPixels ?? 0); k++) px[Math.floor(rand() * px.length)] += 5000;
  return { width: w, height: h, pixels: px, bitpix: -64, bayerPattern: null };
}

function grid(n: number, w: number, h: number, sx: number, sy?: number): StarSpec[] {
  const stars: StarSpec[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    stars.push({ x: 30 + (i % cols) * ((w - 60) / cols), y: 30 + Math.floor(i / cols) * ((h - 60) / cols), amp: 3000, sx, sy });
  }
  return stars;
}

describe('measureSubFrame', () => {
  it('measures FWHM, HFR, star count and background on round Gaussian stars', () => {
    const sigma = 1.5;
    const m = measureSubFrame(synth(400, 300, grid(40, 400, 300, sigma)));
    expect(m.stars).toBe(40);
    expect(m.background).toBeGreaterThan(990);
    expect(m.background).toBeLessThan(1010);
    expect(m.fwhm!).toBeGreaterThan(2.3548 * sigma * 0.85);
    expect(m.fwhm!).toBeLessThan(2.3548 * sigma * 1.15);
    // HFR of a 2-D Gaussian (flux-weighted mean radius) = σ·√(π/2) ≈ 1.25σ.
    expect(m.hfr!).toBeGreaterThan(1.25 * sigma * 0.85);
    expect(m.hfr!).toBeLessThan(1.25 * sigma * 1.15);
    expect(m.eccentricity!).toBeLessThan(0.35);
  });

  it('ranks a defocused frame above a sharp one and flags elongation', () => {
    const sharp = measureSubFrame(synth(400, 300, grid(40, 400, 300, 1.4)));
    const soft = measureSubFrame(synth(400, 300, grid(40, 400, 300, 2.4)));
    const trailing = measureSubFrame(synth(400, 300, grid(40, 400, 300, 1.4, 3.2)));
    expect(soft.hfr!).toBeGreaterThan(sharp.hfr! * 1.5);
    expect(trailing.eccentricity!).toBeGreaterThan(0.75);
  });

  it('ignores hot pixels and reports no shape when there are too few stars', () => {
    const m = measureSubFrame(synth(400, 300, grid(MIN_STARS_FOR_SHAPE - 1, 400, 300, 1.5), { hotPixels: 200 }));
    expect(m.stars).toBe(MIN_STARS_FOR_SHAPE - 1);
    expect(m.hfr).toBeNull();
    expect(m.fwhm).toBeNull();
  });

  it('bins a CFA mosaic 2x2 and reports sizes in original pixels', () => {
    const img = synth(400, 300, grid(40, 400, 300, 1.6));
    const mono = measureSubFrame(img);
    const cfa = measureSubFrame({ ...img, bayerPattern: 'RGGB' });
    expect(cfa.width).toBe(200);
    expect(cfa.fwhm!).toBeGreaterThan(mono.fwhm! * 0.75);
    expect(cfa.fwhm!).toBeLessThan(mono.fwhm! * 1.35);
  });
});

describe('gradeGroup', () => {
  const typical = { stars: 200, hfr: 2.0, eccentricity: 0.3, background: 1000 };
  it('grades subs against the night: soft, clouded, bright and trailing subs drop', () => {
    const grades = gradeGroup([
      typical, typical, typical, typical,
      { ...typical, hfr: 2.9 },                  // very soft
      { ...typical, stars: 80 },                 // clouds
      { ...typical, background: 1400 },          // dawn / moon
      { ...typical, eccentricity: 0.7 },         // trailing
    ]);
    expect(grades.slice(0, 4).every(g => g.grade === 'good' && g.weight === 1)).toBe(true);
    expect(grades[4]).toMatchObject({ grade: 'poor', flags: ['very_soft'] });
    expect(grades[5]).toMatchObject({ grade: 'poor', flags: ['very_few_stars'] });
    expect(grades[6]).toMatchObject({ grade: 'fair', flags: ['bright_background'] });
    expect(grades[7]).toMatchObject({ grade: 'fair', flags: ['elongated'] });
    expect(grades[4].weight).toBeLessThan(0.6);
  });

  it('copes with subs that have no shape measurement', () => {
    const grades = gradeGroup([{ ...typical, hfr: null, eccentricity: null }, typical]);
    expect(grades[0].grade).toBe('good');
  });
});
