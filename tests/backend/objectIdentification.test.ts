import { describe, it, expect } from 'vitest';
import { identifyObjectFromFolderName } from '../../server/lib/library/objectIdentification';
import { matchCatalog } from '../../server/lib/library/folderScan';

/**
 * These pin the folder-name identification rules that decide whether an
 * imported folder becomes a catalog object or an object named after the
 * folder. The cases are real naming conventions a user library can have.
 */
describe('identifyObjectFromFolderName', () => {
  describe('exact designation (pre-existing behaviour, must not change)', () => {
    it('resolves a bare designation, with or without a space', () => {
      expect(identifyObjectFromFolderName('M42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M 42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('NGC 7000')?.objectId).toBe('NGC7000');
    });

    it('still strips imaging suffixes from the object id', () => {
      expect(identifyObjectFromFolderName('M42_mosaic')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M42_Ha')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M 42_sub')?.objectId).toBe('M42');
    });

    it('is case-insensitive', () => {
      expect(identifyObjectFromFolderName('m42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('ngc 7000')?.objectId).toBe('NGC7000');
    });
  });

  describe('a designation embedded in a longer folder name', () => {
    it('finds the designation next to a common name', () => {
      expect(identifyObjectFromFolderName('M42 - Orion Nebula')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('NGC 7000 - North America Nebula')?.objectId).toBe('NGC7000');
    });

    it('finds the designation next to a date', () => {
      expect(identifyObjectFromFolderName('M42_2024-01-15')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('2024-01-15_M42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M42_2023-11-20_21-30-00')?.objectId).toBe('M42');
    });

    it('finds the designation next to a rig or capture-mode prefix', () => {
      expect(identifyObjectFromFolderName('Seestar_M42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('Dwarf3_M42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('Target_M42')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M42_LIGHTS')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M42 (Lights)')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('M42 lights')?.objectId).toBe('M42');
    });

    it('finds the designation in a name that has other words attached', () => {
      expect(identifyObjectFromFolderName('NGC6960_WesternVeil')?.objectId).toBe('NGC6960');
      expect(identifyObjectFromFolderName('M16_Eagle')?.objectId).toBe('M16');
      expect(identifyObjectFromFolderName('M57_Ring')?.objectId).toBe('M57');
    });

    it('does not read a longer number as a shorter designation', () => {
      expect(identifyObjectFromFolderName('M421')).toBeNull();
      expect(identifyObjectFromFolderName('NGC70001')).toBeNull();
    });
  });

  describe('a full catalog name, ignoring case, spaces, and punctuation', () => {
    it('matches a display name', () => {
      expect(identifyObjectFromFolderName('Orion Nebula')?.objectId).toBe('M42');
      expect(identifyObjectFromFolderName('Andromeda Galaxy')?.objectId).toBe('M31');
      expect(identifyObjectFromFolderName('Pleiades')?.objectId).toBe('M45');
    });

    it('matches across a missing apostrophe', () => {
      expect(identifyObjectFromFolderName('Bodes Galaxy')?.objectId).toBe('M81');
    });

    it('matches a curated name that OpenNGC does not carry', () => {
      expect(identifyObjectFromFolderName('Cave Nebula')?.name).toBe('Cave Nebula');
    });
  });

  describe('refuses to guess', () => {
    it('returns null for two distinct designations', () => {
      expect(identifyObjectFromFolderName('M81_M82')).toBeNull();
      expect(identifyObjectFromFolderName('M81 and M82')).toBeNull();
    });

    it('returns null for a folder that names no object', () => {
      expect(identifyObjectFromFolderName('2024-01-15')).toBeNull();
      expect(identifyObjectFromFolderName('Lights')).toBeNull();
      expect(identifyObjectFromFolderName('Unknown')).toBeNull();
      expect(identifyObjectFromFolderName('Dwarf3')).toBeNull();
      expect(identifyObjectFromFolderName('')).toBeNull();
    });
  });
});

describe('matchCatalog (folder-import scan)', () => {
  it('uses the shared resolver so the review screen shows the catalog object', () => {
    const match = matchCatalog('M42 - Orion Nebula');
    expect(match?.objectId).toBe('M42');
    expect(match?.name).toContain('Orion');
  });

  it('still returns the normalized id for a bare designation', () => {
    expect(matchCatalog('M 42')?.objectId).toBe('M42');
  });

  it('returns null when nothing matches', () => {
    expect(matchCatalog('2024-01-15')).toBeNull();
  });
});
