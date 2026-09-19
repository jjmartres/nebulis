import { describe, expect, it } from 'vitest';
import { upsizeThumbnailUrl } from '../../server/lib/wikipedia';

describe('upsizeThumbnailUrl', () => {
  it('replaces the width segment of a Wikimedia thumbnail URL', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/M31.jpg/320px-M31.jpg';
    expect(upsizeThumbnailUrl(url, 1920)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/M31.jpg/1920px-M31.jpg',
    );
  });

  it('handles filenames containing digits adjacent to the width segment', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/2b/NGC_4449.jpg/440px-NGC_4449.jpg';
    expect(upsizeThumbnailUrl(url, 1920)).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/2b/NGC_4449.jpg/1920px-NGC_4449.jpg',
    );
  });

  it('leaves a URL with no width segment unchanged', () => {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/M31.jpg';
    expect(upsizeThumbnailUrl(url, 1920)).toBe(url);
  });
});
