/**
 * Finds where an image's brightest content sits, so a heavily blurred/zoomed
 * ambient copy of it (ObjectHero, SessionHero) crops into that content
 * instead of gambling on the subject being centered. Most library pictures
 * are astrophotography: a comet, galaxy, or cluster sitting in a mostly-black
 * frame, so a center crop very often lands on empty sky and the "ambient
 * glow" effect washes out to a flat black panel.
 */

export interface FocalPoint {
  x: number;
  y: number;
}

export const DEFAULT_FOCAL_POINT: FocalPoint = { x: 50, y: 50 };

const SAMPLE_SIZE = 48;

const cache = new Map<string, Promise<FocalPoint>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function computeFromImage(img: HTMLImageElement): FocalPoint {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return DEFAULT_FOCAL_POINT;

  // Squashing to a fixed square ignores the image's real aspect ratio, but
  // the centroid below is computed as a fraction of width/height, and a
  // uniform squash preserves those fractions regardless of the source shape.
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  const pixelCount = SAMPLE_SIZE * SAMPLE_SIZE;
  const luminances = new Float32Array(pixelCount);
  let sum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const l = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    luminances[i] = l;
    sum += l;
  }
  const mean = sum / pixelCount;
  let variance = 0;
  for (let i = 0; i < pixelCount; i++) variance += (luminances[i] - mean) ** 2;
  const stddev = Math.sqrt(variance / pixelCount);

  // Only pixels well above the frame's own average count as "the subject",
  // weighted by how far above that they are. A flat/uniform frame (nothing
  // standing out from the background) has stddev ~0 and nothing clears the
  // threshold, which is the signal to fall back to dead center below.
  const threshold = mean + stddev * 1.5;

  let weightSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const weight = luminances[y * SAMPLE_SIZE + x] - threshold;
      if (weight <= 0) continue;
      weightSum += weight;
      xSum += weight * x;
      ySum += weight * y;
    }
  }
  if (weightSum <= 0) return DEFAULT_FOCAL_POINT;

  return {
    x: ((xSum / weightSum + 0.5) / SAMPLE_SIZE) * 100,
    y: ((ySum / weightSum + 0.5) / SAMPLE_SIZE) * 100,
  };
}

/** Resolves to where an image's brightest content is, as a CSS
 *  object-position-shaped percentage pair. Falls back to dead center for
 *  anything that fails to load or decode, or has nothing brighter than its
 *  own average (a flat frame). Cached per src for the life of the page: the
 *  sampling is cheap but there is no reason to repeat it every time a hero
 *  remounts on the same picture. */
export function getImageFocalPoint(src: string): Promise<FocalPoint> {
  const cached = cache.get(src);
  if (cached) return cached;

  const promise = loadImage(src).then(computeFromImage).catch(() => DEFAULT_FOCAL_POINT);
  cache.set(src, promise);
  return promise;
}
