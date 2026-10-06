import { describe, expect, it } from 'vitest';
import { resolveCatalogMeta, looksLikeComet } from '../../server/lib/library/objects';

describe('resolveCatalogMeta', () => {
  it('fills a curated description at import time from the catalog store', () => {
    // IC 342's curated text used to live only in curated-descriptions.json
    // under "C5", which the import path never read. It is now in the one
    // catalog store, and resolveCatalogMeta falls back to it. The library
    // grid, filter chips and the iOS/Android object screen all read the
    // column resolveCatalogMeta writes.
    const meta = resolveCatalogMeta('IC342');
    expect(meta.catalogId).toBe('IC342');
    expect(meta.description).toMatch(/IC ?342/);
  });

  it('still returns generic placeholders for an unrecognised id', () => {
    const meta = resolveCatalogMeta('NOT_A_REAL_OBJECT');
    expect(meta.objectType).toBe('Unknown');
    expect(meta.constellation).toBe('Unknown');
    expect(meta.description).toBe('');
  });
});

describe('looksLikeComet', () => {
  it.each(['161PHartley-IRAS', '161P Hartley-IRAS', '10PTempel', '220PMcNaught', '1P', '29P_Schwassmann',
    'C/2023 A3', 'C-2023 A3', 'C2023A3', 'P/2010 H2', '12DWest'])('matches %s', id => {
    expect(looksLikeComet(id)).toBe(true);
  });
  it.each(['M31', 'M31_mosaic', 'NGC7000', 'IC1795', 'C14', 'C5', '3C273', '12C', 'SH2-155', 'Moon', 'Pelican'])(
    'rejects %s', id => { expect(looksLikeComet(id)).toBe(false); });
  it('types a periodic comet as Comet', () => {
    expect(resolveCatalogMeta('161PHartley-IRAS').objectType).toBe('Comet');
  });
});
