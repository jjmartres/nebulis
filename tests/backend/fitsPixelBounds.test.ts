import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Both pixel decoders take their dimensions straight from header cards, so both
// used to allocate NAXIS1*NAXIS2 floats before checking that the bytes were
// actually present. A header claiming 30000x30000 asked for a 3.6 GB
// Float32Array, and a half-copied file decoded into a plausible-looking
// half-black image instead of failing. trailDetector.ts already rejects exactly
// that (see its `pixel data truncated` guard); these tests hold the thumbnail
// and viewer decoders to the same rule.
import { generateFitsThumbnail, fitsThumbnailPath } from '../../server/lib/fitsThumbnail';
import { parseFits } from '../../src/lib/fits';

/** Build a FITS file: 2880-byte-padded header block + the given pixel bytes. */
function fitsFile(cards: [string, string][], pixelBytes: Buffer): Buffer {
  const lines: string[] = [];
  for (const [key, value] of cards) {
    lines.push(`${key.padEnd(8)}= ${value}`.padEnd(80).slice(0, 80));
  }
  lines.push('END'.padEnd(80));
  const header = Buffer.alloc(2880, ' ');
  header.write(lines.join(''), 0, 'ascii');
  return Buffer.concat([header, pixelBytes]);
}

/** A real, complete 16x16 BITPIX=16 image: 512 bytes, int16 big-endian. */
function validMonoFits(size = 16): Buffer {
  const pixels = Buffer.alloc(size * size * 2);
  for (let i = 0; i < size * size; i++) pixels.writeInt16BE(i % 4096, i * 2);
  return fitsFile(
    [
      ['SIMPLE', '                   T'],
      ['BITPIX', '                  16'],
      ['NAXIS', '                   2'],
      ['NAXIS1', String(size).padStart(20)],
      ['NAXIS2', String(size).padStart(20)],
    ],
    pixels,
  );
}

function tmpFits(name: string, buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fits-bounds-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
}

const badCards = (w: number, h: number): [string, string][] => [
  ['SIMPLE', '                   T'],
  ['BITPIX', '                  16'],
  ['NAXIS', '                   2'],
  ['NAXIS1', String(w).padStart(20)],
  ['NAXIS2', String(h).padStart(20)],
];

describe('FITS pixel bounds (server thumbnail decoder)', () => {
  it('still renders a complete, valid FITS', async () => {
    const file = tmpFits('good.fits', validMonoFits(16));
    await expect(generateFitsThumbnail(file, 'thumb')).resolves.toBeUndefined();
    expect(fs.existsSync(fitsThumbnailPath(file, 'thumb'))).toBe(true);
  });

  it('rejects a truncated data unit instead of zero-filling the tail', async () => {
    // Header says 100x100 (20000 bytes); only 200 bytes are present.
    const file = tmpFits('truncated.fits', fitsFile(badCards(100, 100), Buffer.alloc(200)));
    await expect(generateFitsThumbnail(file, 'thumb')).rejects.toThrow(/truncated/i);
  });

  it('rejects an implausible frame size before allocating', async () => {
    const file = tmpFits('huge.fits', fitsFile(badCards(30000, 30000), Buffer.alloc(16)));
    await expect(generateFitsThumbnail(file, 'thumb')).rejects.toThrow(/truncated|dimensions/i);
  });

  it('rejects a header with no usable dimensions', async () => {
    const file = tmpFits('nodims.fits', fitsFile(badCards(0, 0), Buffer.alloc(16)));
    await expect(generateFitsThumbnail(file, 'thumb')).rejects.toThrow(/dimensions/i);
  });
});

describe('FITS pixel bounds (client viewer decoder)', () => {
  it('still parses a complete, valid FITS', () => {
    const ab = new Uint8Array(validMonoFits(16)).buffer;
    const data = parseFits(ab);
    expect(data.width).toBe(16);
    expect(data.height).toBe(16);
    expect(data.imageData).toHaveLength(256);
  });

  it('throws on a truncated data unit', () => {
    const ab = new Uint8Array(fitsFile(badCards(100, 100), Buffer.alloc(200))).buffer;
    expect(() => parseFits(ab)).toThrow();
  });

  it('throws on an implausible frame size instead of allocating gigabytes', () => {
    const ab = new Uint8Array(fitsFile(badCards(30000, 30000), Buffer.alloc(16))).buffer;
    expect(() => parseFits(ab)).toThrow();
  });

  it('throws on a header with no usable dimensions', () => {
    const ab = new Uint8Array(fitsFile(badCards(0, 0), Buffer.alloc(16))).buffer;
    expect(() => parseFits(ab)).toThrow();
  });
});
