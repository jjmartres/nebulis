import { describe, it, expect } from 'vitest';
import { compareDesignations, catalogFamilyOf } from '../../src/lib/designationSort';

describe('designationSort', () => {
  it('orders by catalog then number, not by string', () => {
    const ids = ['NGC7000', 'M31', 'IC 1396', 'M2', 'C1', 'M1', 'NGC 891', 'Sh2-101', 'M10', 'LDN 1622'];
    expect([...ids].sort(compareDesignations)).toEqual(
      ['M1', 'M2', 'M10', 'M31', 'C1', 'NGC 891', 'NGC7000', 'IC 1396', 'Sh2-101', 'LDN 1622'],
    );
  });
  it('classifies families', () => {
    expect(catalogFamilyOf('M31')).toBe('M');
    expect(catalogFamilyOf('Sh2-155')).toBe('Sh2');
    expect(catalogFamilyOf('Moon')).toBe('Other');
  });
});
