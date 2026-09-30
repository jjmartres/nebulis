import { describe, it, expect } from 'vitest';

import { looksLikeShareAddress, parseShareAddress } from '../../src/lib/uncInput';

/**
 * The share address parser.
 *
 * It exists because the form had two fields and everybody pastes one path into the first
 * of them: `\\192.168.1.12\Nebulis2` was refused by the server as "characters that cannot
 * be used", which is true of the field and not of the address.
 */

describe('parseShareAddress', () => {
  it('splits a Windows UNC path into its three parts', () => {
    expect(parseShareAddress('\\\\192.168.1.12\\Nebulis2')).toEqual({
      host: '192.168.1.12',
      share: 'Nebulis2',
      subpath: '',
    });
    expect(parseShareAddress('\\\\nas.local\\Archive\\Nebulis-Archive\\sub')).toEqual({
      host: 'nas.local',
      share: 'Archive',
      subpath: 'Nebulis-Archive/sub',
    });
  });

  it('splits the forward-slash spelling everyone also types', () => {
    expect(parseShareAddress('//192.168.1.12/Nebulis2')).toEqual({
      host: '192.168.1.12',
      share: 'Nebulis2',
      subpath: '',
    });
  });

  it('accepts a host and share without a leading separator', () => {
    expect(parseShareAddress('nas.local/Archive')).toEqual({ host: 'nas.local', share: 'Archive', subpath: '' });
  });

  it('keeps a bare server as a server, so typing one is not mangled', () => {
    expect(parseShareAddress('192.168.1.12')).toEqual({ host: '192.168.1.12', share: '', subpath: '' });
    expect(parseShareAddress('nas.local:4450')).toEqual({ host: 'nas.local:4450', share: '', subpath: '' });
  });

  it('returns null for nothing at all, which is not an address', () => {
    expect(parseShareAddress('')).toBeNull();
    expect(parseShareAddress('   ')).toBeNull();
    expect(parseShareAddress('\\\\')).toBeNull();
    expect(parseShareAddress('//')).toBeNull();
  });
});

describe('looksLikeShareAddress', () => {
  it('is true only when there is a separator to split on', () => {
    expect(looksLikeShareAddress('\\\\192.168.1.12\\Nebulis2')).toBe(true);
    expect(looksLikeShareAddress('nas.local/Archive')).toBe(true);
    expect(looksLikeShareAddress('192.168.1.12')).toBe(false);
    expect(looksLikeShareAddress('nas.local')).toBe(false);
  });
});
