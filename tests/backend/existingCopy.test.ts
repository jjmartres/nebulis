import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyExistingCopy } from '../../server/lib/library/existingCopy';

const dirs: string[] = [];
function tmp(files: Record<string, Buffer | string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-copy-'));
  dirs.push(d);
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('classifyExistingCopy', () => {
  it('calls byte-identical files identical', async () => {
    const d = tmp({ a: 'same bytes', b: 'same bytes' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('identical');
  });
  it('calls an empty file identical to another empty file', async () => {
    const d = tmp({ a: '', b: '' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('identical');
  });
  it('calls a strict prefix of the source partial (an interrupted copy)', async () => {
    const d = tmp({ a: 'hello wor', b: 'hello world' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('partial');
  });
  it('calls a same-size file with different bytes different', async () => {
    const d = tmp({ a: 'aaaa', b: 'aaab' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('different');
  });
  it('calls a shorter file that is not a prefix different, not partial', async () => {
    const d = tmp({ a: 'xyz', b: 'hello world' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('different');
  });
  it('calls an existing file larger than the source different', async () => {
    const d = tmp({ a: 'hello world!!', b: 'hello world' });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('different');
  });
  it('compares across chunk boundaries', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
    const changed = Buffer.from(big); changed[2 * 1024 * 1024 + 1] = 9;
    const d = tmp({ a: big, b: changed, c: big, d: big.subarray(0, 1024 * 1024 + 10) });
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'b'))).toBe('different');
    expect(await classifyExistingCopy(path.join(d, 'a'), path.join(d, 'c'))).toBe('identical');
    expect(await classifyExistingCopy(path.join(d, 'd'), path.join(d, 'c'))).toBe('partial');
  });
});
