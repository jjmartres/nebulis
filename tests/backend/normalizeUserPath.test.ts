import { describe, it, expect } from 'vitest';
import path from 'path';
import { normalizeUserPath } from '../../server/lib/volumes';

describe('normalizeUserPath (win32)', () => {
  const norm = (s: string) => normalizeUserPath(s, 'win32');

  it('strips wrapping double quotes from an Explorer "Copy as path" value', () => {
    expect(norm('"\\\\server\\share\\folder"')).toBe('\\\\server\\share\\folder');
    expect(norm('"D:\\Astro"')).toBe('D:\\Astro');
  });

  it('strips wrapping single quotes', () => {
    expect(norm("'D:\\Astro'")).toBe('D:\\Astro');
  });

  it('turns a bare drive letter into its root', () => {
    expect(norm('H:')).toBe('H:\\');
    expect(path.win32.isAbsolute(norm('H:'))).toBe(true);
  });

  it('keeps a drive root intact', () => {
    expect(norm('C:\\')).toBe('C:\\');
    expect(norm('C:/')).toBe('C:\\');
  });

  it('drops a trailing separator on a normal path', () => {
    expect(norm('D:\\Astro\\')).toBe('D:\\Astro');
    expect(norm('\\\\server\\share\\folder\\')).toBe('\\\\server\\share\\folder');
  });

  it('leaves a UNC share root usable and absolute', () => {
    const p = norm('\\\\mamsgen8\\d\\ASTROFOTOGRAFIA\\DWARF3');
    expect(p).toBe('\\\\mamsgen8\\d\\ASTROFOTOGRAFIA\\DWARF3');
    expect(path.win32.isAbsolute(p)).toBe(true);
  });

  it('leaves forward-slash paths alone (path.win32 accepts them)', () => {
    expect(norm('//mamsgen8/d/Astro')).toBe('//mamsgen8/d/Astro');
    expect(path.win32.isAbsolute(norm('//mamsgen8/d/Astro'))).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(norm('  D:\\Astro  ')).toBe('D:\\Astro');
  });

  it('returns empty for empty or whitespace-only input', () => {
    expect(norm('')).toBe('');
    expect(norm('   ')).toBe('');
    expect(norm('""')).toBe('');
  });
});

describe('normalizeUserPath (posix)', () => {
  const norm = (s: string) => normalizeUserPath(s, 'linux');

  it('strips trailing slashes but keeps root', () => {
    expect(norm('/mnt/astro/')).toBe('/mnt/astro');
    expect(norm('/')).toBe('/');
  });

  it('strips wrapping quotes', () => {
    expect(norm('"/mnt/astro"')).toBe('/mnt/astro');
  });
});
