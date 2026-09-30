import { describe, it, expect } from 'vitest';
import { attributeFiles } from '../../server/lib/library/treeAttribution';
import { getStartrailsObjectId } from '../../server/lib/library/dwarfStartrails';

/** Look up one file's attribution by its relPath, for readable assertions. */
function find(result: ReturnType<typeof attributeFiles>, relPath: string) {
  const file = result.files.find(f => f.relPath === relPath);
  if (!file) throw new Error(`fixture missing expected file: ${relPath}`);
  return file;
}

describe('attributeFiles', () => {
  it('resolves the reporter\'s real layout: device folders and catalog groups are containers, objects sit three levels deep, and the same object under two device folders still resolves', () => {
    const tree = [
      '1. Seestar S50/1. Caldwell Objects/C 1 - Polarissima Cluster/Stacked_60_C 1_20.0s_IRCUT_20260524-231230.fit',
      '1. Seestar S50/1. Caldwell Objects/C 1 - Polarissima Cluster/C 1_sub/Light_C 1_20.0s_IRCUT_20260524-231230.fit',
      '1. Seestar S50/4. NGC Objects/NGC 6910/Stacked_210_NGC 6910_10.0s_IRCUT_20260915-213012.jpg',
      '2. Seestar S50 Pro/1. Caldwell Objects/C 1 - Polarissima Cluster/Stacked_45_C 1_20.0s_IRCUT_20260601-220000.fit',
      '3. Messier Catalog - Completed/M 1 - Crab Nebula/Stacked_80_M 1_10.0s_IRCUT_20260301-201500.fit',
    ];

    const result = attributeFiles(tree);

    // The reported bug: these must never appear as objects.
    for (const badId of ['1. Seestar S50', '2. Seestar S50 Pro', '1. Caldwell Objects', '4. NGC Objects', '3. Messier Catalog - Completed']) {
      expect(result.files.some(f => f.objectId === badId)).toBe(false);
    }

    expect(find(result, tree[0]).objectId).toBe('NGC188'); // C1's canonical id
    expect(find(result, tree[0]).source).toBe('folder');
    expect(find(result, tree[0]).telescopeKind).toBe('seestar-s50');
    // The _sub companion self-identifies via the embedded designation rule,
    // same as its parent — no special-casing needed for it to resolve.
    expect(find(result, tree[1]).objectId).toBe('NGC188');
    expect(find(result, tree[2]).objectId).toBe('NGC6910');
    expect(find(result, tree[2]).telescopeKind).toBe('seestar-s50');

    // Same object (C1) under the second device folder: one object, sessions
    // from both scopes, and the telescope kind follows the device folder it's
    // actually under.
    expect(find(result, tree[3]).objectId).toBe('NGC188');
    expect(find(result, tree[3]).telescopeKind).toBe('seestar-s50-pro');

    expect(find(result, tree[4]).objectId).toBe('M1');

    // "1. Seestar S50" holds two distinct objects (C1 and NGC6910) across its
    // two catalog-group children, so it's a container. "1. Caldwell Objects"
    // under it holds only C1 — correctly NOT a container, since a folder with
    // exactly one distinct descendant object resolves rather than being
    // treated as a grouping folder.
    expect(result.containers.has('1. Seestar S50')).toBe(true);
    expect(result.containers.has('1. Seestar S50/1. Caldwell Objects')).toBe(false);
  });

  it('groups a flat dump folder by filename alone when no folder identifies anything', () => {
    const tree = [
      'MyDump/Stacked_60_M 42_10.0s_IRCUT_20260101-200000.fit',
      'MyDump/Stacked_40_M 43_10.0s_IRCUT_20260101-203000.fit',
    ];
    const result = attributeFiles(tree);
    expect(find(result, tree[0]).objectId).toBe('M42');
    expect(find(result, tree[0]).source).toBe('filename');
    expect(find(result, tree[1]).objectId).toBe('M43');
    // Two distinct objects under MyDump -> a container, not folded together.
    expect(result.containers.has('MyDump')).toBe(true);
  });

  it('resolves an object 8 levels deep, transparent folders in between', () => {
    const relPath =
      'Backups/2024/Q3/Seestar/RawExports/Caldwell/C 1 - Polarissima Cluster/C 1_sub/Light_C 1_20.0s_IRCUT_20260101-000000.fit';
    const result = attributeFiles([relPath]);
    expect(find(result, relPath).objectId).toBe('NGC188');
    expect(find(result, relPath).source).toBe('folder');
  });

  it('flags a folder/filename disagreement, folder wins', () => {
    const relPath = 'M42/Stacked_10_M 43_10.0s_IRCUT_20260101-200000.fit';
    const result = attributeFiles([relPath]);
    const file = find(result, relPath);
    expect(file.objectId).toBe('M42');
    expect(file.source).toBe('folder');
    expect(file.disagreement).toEqual({ folderObjectId: 'M42', filenameObjectId: 'M43' });
  });

  it('a container with exactly one resolvable descendant still resolves, not treated as a container', () => {
    // "Backups" holds only M42 files (via filename), nested a level deep.
    const tree = [
      'Backups/session1/Stacked_10_M 42_10.0s_IRCUT_20260101-200000.fit',
      'Backups/session2/Stacked_12_M 42_10.0s_IRCUT_20260102-200000.fit',
      'Backups/session1/notes.txt', // no filename target, no folder target -> folds into the same object
    ];
    const result = attributeFiles(tree);
    expect(find(result, tree[0]).objectId).toBe('M42');
    expect(find(result, tree[1]).objectId).toBe('M42');
    expect(find(result, tree[2]).objectId).toBe('M42');
    expect(find(result, tree[2]).source).toBe('custom');
    expect(result.containers.has('Backups')).toBe(false);
    expect(result.containers.has('Backups/session1')).toBe(false);
  });

  it('an unresolved loose file at a real container level stays unresolved, not named after the container', () => {
    const tree = [
      'MyWorks/M42/Stacked_10_M 42_10.0s_IRCUT_20260101-200000.fit',
      'MyWorks/M43/Stacked_10_M 43_10.0s_IRCUT_20260101-200000.fit',
      'MyWorks/unnamed_dump.jpg', // no signal at all, MyWorks resolves to {M42, M43}: a container
    ];
    const result = attributeFiles(tree);
    expect(find(result, tree[2]).objectId).toBeNull();
    expect(find(result, tree[2]).excluded).toBe(false);
    expect(result.containers.has('MyWorks')).toBe(true);
  });

  it('mints a distinct custom object per folder for genuinely uncatalogued collections, even when basenames collide', () => {
    const tree = [
      'Comet A3/photo1.jpg',
      'Comet A3/photo2.jpg',
      'Backyard test/Comet A3/photo1.jpg', // same basename, different real folder
    ];
    const result = attributeFiles(tree);
    // Ids are space-free (the library's boot migration strips spaces from any
    // objectId, which would rename a spaced one out from under a rescan); the
    // folder's own spelling is kept separately for display.
    expect(find(result, tree[0]).objectId).toBe('CometA3');
    expect(find(result, tree[1]).objectId).toBe('CometA3');
    expect(find(result, tree[2]).objectId).toBe('CometA3_2');
    expect(find(result, tree[2]).source).toBe('custom');
    expect(result.customNames.get('CometA3')).toBe('Comet A3');
    expect(result.customNames.get('CometA3_2')).toBe('Comet A3 (2)');
  });

  it('excludes calibration/junk folders entirely, at any depth, rather than treating them as objects or custom collections', () => {
    const tree = [
      'MyWorks/CALI_FRAME/dark1.fit',
      'MyWorks/M42/RESTACKED/v2/stack.jpg',
    ];
    const result = attributeFiles(tree);
    expect(find(result, tree[0]).excluded).toBe(true);
    expect(find(result, tree[0]).objectId).toBeNull();
    // RESTACKED sits *under* an already-identified M42 folder — the ancestor
    // climb finds the junk folder before it ever reaches M42, so this is
    // excluded too, not silently folded into M42.
    expect(find(result, tree[1]).excluded).toBe(true);
  });

  it('an ignore override excludes a subtree; an assign override wins over both folder and filename signals', () => {
    const tree = [
      'Junk/whatever.jpg',
      'Ambiguous/Stacked_10_M 43_10.0s_IRCUT_20260101-200000.fit',
    ];
    const overrides = new Map<string, { action: 'assign'; objectId: string } | { action: 'ignore' }>([
      ['Junk', { action: 'ignore' }],
      ['Ambiguous', { action: 'assign', objectId: 'M42' }],
    ]);
    const result = attributeFiles(tree, { overrides });
    expect(find(result, tree[0]).excluded).toBe(true);
    expect(find(result, tree[1]).objectId).toBe('M42');
    expect(find(result, tree[1]).source).toBe('override');
  });

  it('tolerates a symlink-loop-shaped repeated path segment and an empty tree without throwing', () => {
    expect(() => attributeFiles([])).not.toThrow();
    expect(attributeFiles([]).files).toEqual([]);
    // treeAttribution itself never touches the filesystem, so a symlink loop
    // is sourceWalk's concern; this just proves an oddly-repeated path
    // component doesn't confuse the pure attribution logic.
    const relPath = 'a/a/a/a/a/a/a/a/Stacked_10_M 42_10.0s_IRCUT_20260101-200000.fit';
    expect(() => attributeFiles([relPath])).not.toThrow();
    expect(find(attributeFiles([relPath]), relPath).objectId).toBe('M42');
  });
});

describe('attributeFiles: _sub companions of uncatalogued objects', () => {
  it('folds a _sub folder into its object folder instead of minting a second object', () => {
    const result = attributeFiles([
      '6. Comets/C2025 A6 - Comet Lemmon/Stacked_30_C2025 A6_10.0s_IRCUT_20251020-210000.fit',
      '6. Comets/C2025 A6 - Comet Lemmon/C2025 A6_sub/Light_C2025 A6_10.0s_IRCUT_20251020-205000.fit',
    ]);
    const ids = new Set(result.files.map(f => f.objectId));
    expect([...ids]).toEqual(['C2025A6-CometLemmon']);
  });
});


describe('attributeFiles: Dwarf session folders', () => {
  // The reporter's real layout: the same comet captured twice, one Dwarf session folder per run. The
  // target is the token before _EXP_, not the whole folder name with its exposure, gain and timestamp.
  const SESSION_15 = 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_15_GAIN_60_2026-04-15-06-38-16-385';
  const SESSION_30 = 'DWARF_RAW_TELE_C2025R3PANSTARRS_EXP_30_GAIN_60_2026-04-16-06-21-17-383';
  const FILE_15 = `${SESSION_15}/C2025R3PANSTARRS_15s60_Astro_20260415-063816385_26C.fits`;
  const FILE_30 = `${SESSION_30}/C2025R3PANSTARRS_30s60_Astro_20260416-062117383_26C.fits`;

  it('folds every session of one uncatalogued Dwarf target into a single object named for the target', () => {
    const result = attributeFiles([FILE_15, FILE_30]);
    const a = find(result, FILE_15);
    const b = find(result, FILE_30);

    expect(a.objectId).toBe('C2025R3PANSTARRS');
    expect(b.objectId).toBe(a.objectId);
    expect(a.source).toBe('custom');
    // The display name is the target, never the exposure/gain/timestamp folder name.
    expect(result.customNames.get('C2025R3PANSTARRS')).toBe('C2025R3PANSTARRS');
    expect([...result.customNames.values()].some(n => n.includes('DWARF_RAW') || n.includes('EXP_'))).toBe(false);
  });

  it('keeps two different Dwarf targets as two objects', () => {
    const other = 'DWARF_RAW_TELE_C2024G3ATLAS_EXP_15_GAIN_60_2026-04-15-07-00-00-100/C2024G3ATLAS_15s60_Astro_20260415-070000100_26C.fits';
    const result = attributeFiles([FILE_15, other]);
    expect(find(result, FILE_15).objectId).toBe('C2025R3PANSTARRS');
    expect(find(result, other).objectId).toBe('C2024G3ATLAS');
  });

  it('keeps a Dwarf target that sits under two different parents as the same object', () => {
    const elsewhere = `Backup/${FILE_30}`;
    const result = attributeFiles([FILE_15, elsewhere]);
    expect(find(result, elsewhere).objectId).toBe(find(result, FILE_15).objectId);
  });

  it('attributes a file nested inside a Dwarf session folder to that session\'s target', () => {
    const nested = `${SESSION_15}/extras/notes_20260415.jpg`;
    const result = attributeFiles([FILE_15, nested]);
    expect(find(result, nested).objectId).toBe('C2025R3PANSTARRS');
  });

  it('resolves a catalogued Dwarf target through the catalog and learns the target, not the folder name, as its label', () => {
    const tree = 'DWARF_RAW_TELE_NGC 1647_EXP_15_GAIN_60_2026-03-18-20-13-22-000/NGC 1647_15s60_Astro_20260318-201554115_26C.fits';
    const result = attributeFiles([tree]);
    expect(find(result, tree).objectId).toBe('NGC1647');
    expect(find(result, tree).source).toBe('folder');
    const learned = [...(result.folderNames.get('NGC1647') ?? [])];
    expect(learned).toEqual(['NGC 1647']);
  });

  it('lets a review-screen assignment move a whole Dwarf target onto a catalog object, both sessions together', () => {
    const overrides = new Map([
      [SESSION_15, { action: 'assign' as const, objectId: 'M42' }],
      [SESSION_30, { action: 'assign' as const, objectId: 'M42' }],
    ]);
    const result = attributeFiles([FILE_15, FILE_30], { overrides });
    expect(find(result, FILE_15)).toMatchObject({ objectId: 'M42', source: 'override' });
    expect(find(result, FILE_30)).toMatchObject({ objectId: 'M42', source: 'override' });
  });

  it('does not treat a folder that merely mentions DWARF as a session folder', () => {
    const tree = 'DWARF holiday photos/IMG_0001.jpg';
    const result = attributeFiles([tree]);
    // Not a session folder: the ordinary custom-folder rule names it after the folder, as before.
    expect(find(result, tree).objectId).toBe('DWARFholidayphotos');
  });
});

describe('attributeFiles: Dwarf STARTRAILS', () => {
  const CAPTURE_A = 'STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-05-00-22-28-967';
  const CAPTURE_B = 'STARTRAILS_DWARF_RAW_WIDE_EXP_10_GAIN_0_2026-04-16-21-57-44-922';
  const A = `STARTRAILS/${CAPTURE_A}/startrails_10s0_20260405-002247974_26C.fits`;
  const B = `STARTRAILS/${CAPTURE_B}/startrails_10s0_20260416-215803918_24C.fits`;

  it('folds every capture into the one shared Star Trails object', () => {
    const result = attributeFiles([A, B]);
    expect(find(result, A).objectId).toBe(getStartrailsObjectId());
    expect(find(result, B).objectId).toBe(getStartrailsObjectId());
    expect(find(result, A).excluded).toBe(false);
    expect(find(result, A).source).toBe('folder');
  });

  it('reaches a capture nested below a wrapper folder, the way a device root is laid out', () => {
    const nested = `Astronomy/${A}`;
    expect(find(attributeFiles([nested]), nested).objectId).toBe(getStartrailsObjectId());
  });

  it('includes files nested inside a capture folder, and matches the folder name in any case', () => {
    const deep = `startrails/${CAPTURE_A}/extra/stacked.jpg`;
    expect(find(attributeFiles([deep]), deep).objectId).toBe(getStartrailsObjectId());
  });

  it('leaves a file loose in STARTRAILS excluded, as the copy import does: it belongs to no capture', () => {
    const loose = 'STARTRAILS/readme.jpg';
    const file = find(attributeFiles([loose]), loose);
    expect(file.excluded).toBe(true);
    expect(file.objectId).toBeNull();
  });

  it('does not rescue STARTRAILS captures that sit under another non-observation folder', () => {
    const buried = `RESTACKED/${A}`;
    expect(find(attributeFiles([buried]), buried).excluded).toBe(true);
  });

  it('does not learn "DWARF Star Trails" as a nickname, and keeps real objects beside it apart', () => {
    const m31 = 'M 31 - Andromeda/Stacked_60_M 31_10.0s_IRCUT_20260101-200000.jpg';
    const result = attributeFiles([A, m31]);
    expect(find(result, m31).objectId).toBe('M31');
    expect(result.folderNames.has(getStartrailsObjectId())).toBe(false);
  });

  it('lets an assignment override move a capture off Star Trails', () => {
    const overrides = new Map([[`STARTRAILS/${CAPTURE_A}`, { action: 'ignore' as const }]]);
    const file = find(attributeFiles([A], { overrides }), A);
    expect(file.excluded).toBe(true);
  });
});
