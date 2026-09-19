import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { fileThumbnailDiskCacheKey, FILE_THUMBNAIL_DEFAULT_SIZE } from '../../server/lib/library/gallery';

// The `/library/file/thumbnail` route and the session-thumbnail prewarm both
// derive the cached JPEG's filename from this. If the formula drifts between
// them the prewarm silently renders nothing the route can find.
describe('fileThumbnailDiskCacheKey', () => {
  it('matches the sha256(`relPath:WxH:mtime`).base64url formula the route used inline', () => {
    const relPath = 'NGC281/2026-09-04_00-00-00/Stacked_351_NGC 281_20.0s_LP_20260905-054000.jpg';
    const expected = createHash('sha256').update(`${relPath}:400x400:1712345678000`).digest('base64url');
    expect(fileThumbnailDiskCacheKey(relPath, 400, 400, 1712345678000)).toBe(expected);
  });

  it('is deterministic and mtime-sensitive', () => {
    const a = fileThumbnailDiskCacheKey('M45/stack.jpg', 400, 400, 1);
    const b = fileThumbnailDiskCacheKey('M45/stack.jpg', 400, 400, 1);
    const c = fileThumbnailDiskCacheKey('M45/stack.jpg', 400, 400, 2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is constant length regardless of path length (ENAMETOOLONG guard)', () => {
    const short = fileThumbnailDiskCacheKey('a.jpg', 400, 400, 1);
    const long = fileThumbnailDiskCacheKey('x/'.repeat(300) + 'a.jpg', 400, 400, 1);
    expect(long.length).toBe(short.length);
  });

  it('exposes the route default size the prewarm targets', () => {
    expect(FILE_THUMBNAIL_DEFAULT_SIZE).toBe(400);
  });
});
