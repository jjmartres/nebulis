import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { parseGalleryCrop, cropRegion } from '../../server/lib/library/galleryCrop.js';

describe('parseGalleryCrop', () => {
  it('accepts an object or its stored JSON', () => {
    expect(parseGalleryCrop({ x: 0.5, y: 0.5, zoom: 2 })).toEqual({ x: 0.5, y: 0.5, zoom: 2 });
    expect(parseGalleryCrop('{"x":0.5,"y":0.5,"zoom":2}')).toEqual({ x: 0.5, y: 0.5, zoom: 2 });
  });

  it('treats a no-op zoom and malformed input as no crop', () => {
    expect(parseGalleryCrop({ x: 0.5, y: 0.5, zoom: 1 })).toBeNull();
    expect(parseGalleryCrop(null)).toBeNull();
    expect(parseGalleryCrop('not json')).toBeNull();
    expect(parseGalleryCrop({ x: 'a', y: 0.5, zoom: 2 })).toBeNull();
    expect(parseGalleryCrop({ x: NaN, y: 0.5, zoom: 2 })).toBeNull();
  });

  it('clamps zoom and keeps the window inside the image', () => {
    expect(parseGalleryCrop({ x: 0, y: 1, zoom: 100 })).toEqual({ x: 0.0625, y: 0.9375, zoom: 8 });
    expect(parseGalleryCrop({ x: 0.1, y: 0.9, zoom: 2 })).toEqual({ x: 0.25, y: 0.75, zoom: 2 });
  });
});

describe('cropRegion', () => {
  it('returns a window of 1/zoom the image, centred on the point', () => {
    expect(cropRegion({ x: 0.5, y: 0.5, zoom: 2 }, 1000, 600)).toEqual({ left: 250, top: 150, width: 500, height: 300 });
  });

  it('stays inside the image at the edges', () => {
    const r = cropRegion({ x: 0.25, y: 0.25, zoom: 2 }, 1000, 600);
    expect(r).toEqual({ left: 0, top: 0, width: 500, height: 300 });
    const far = cropRegion({ x: 1, y: 1, zoom: 4 }, 1000, 600);
    expect(far.left + far.width).toBeLessThanOrEqual(1000);
    expect(far.top + far.height).toBeLessThanOrEqual(600);
  });

  it('is a region sharp can extract', async () => {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#000' } }).png().toBuffer();
    const out = await sharp(png).extract(cropRegion({ x: 0.3, y: 0.6, zoom: 3 }, 400, 300)).toBuffer({ resolveWithObject: true });
    expect(out.info.width).toBe(133);
    expect(out.info.height).toBe(100);
  });
});

describe('rotated (portrait) frame', () => {
  it('keeps a rotated crop at zoom 1 and carries the flag', () => {
    expect(parseGalleryCrop({ x: 0.5, y: 0.5, zoom: 1, rotated: true })).toEqual({ x: 0.5, y: 0.5, zoom: 1, rotated: true });
    expect(parseGalleryCrop({ x: 0.5, y: 0.5, zoom: 2, rotated: false })).toEqual({ x: 0.5, y: 0.5, zoom: 2 });
  });

  it('cuts a full-height portrait strip from a landscape image', () => {
    // 1000x600 source: the portrait window is 360x600 at zoom 1, half that at 2.
    expect(cropRegion({ x: 0.5, y: 0.5, zoom: 1, rotated: true }, 1000, 600)).toEqual({ left: 320, top: 0, width: 360, height: 600 });
    expect(cropRegion({ x: 0.5, y: 0.5, zoom: 2, rotated: true }, 1000, 600)).toEqual({ left: 410, top: 150, width: 180, height: 300 });
  });

  it('stays inside the image at the edges', () => {
    const r = cropRegion({ x: 0, y: 1, zoom: 1, rotated: true }, 1000, 600);
    expect(r.left).toBe(0);
    expect(r.top + r.height).toBeLessThanOrEqual(600);
  });
});
