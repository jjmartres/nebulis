import { describe, it, expect } from 'vitest';
import os from 'os';
import { isSameMachineAddress } from '../../server/lib/lanAddress';

describe('isSameMachineAddress', () => {
  it('treats loopback, including IPv4-mapped, as this machine', () => {
    expect(isSameMachineAddress('127.0.0.1')).toBe(true);
    expect(isSameMachineAddress('::1')).toBe(true);
    expect(isSameMachineAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('treats one of this machine\'s own interface addresses as this machine', () => {
    const own = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
    if (own) expect(isSameMachineAddress(own.address)).toBe(true);
  });

  it('treats anything else, or nothing, as another machine', () => {
    expect(isSameMachineAddress('203.0.113.7')).toBe(false);
    expect(isSameMachineAddress(undefined)).toBe(false);
  });
});
