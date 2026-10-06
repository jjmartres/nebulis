import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanImportFolder } from '../../server/lib/library/folderScan';

const SETTINGS = { importJpg: true, importFits: true, importSubFrames: true, importThumbnails: true };
const roots: string[] = [];

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, size = 50): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(size));
}

/** The reporter's layout: MyWorks/<device>/<catalog group>/<object>/<object>_sub */
function reporterTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-scanfix-'));
  roots.push(root);
  const c1 = '1. Seestar S50/1. Caldwell Objects/C 1 - Polarissima Cluster';
  write(root, `${c1}/Stacked_60_C 1_20.0s_IRCUT_20260524-231230.fit`);
  write(root, `${c1}/C 1_sub/Light_C 1_20.0s_IRCUT_20260524-231000.fit`);
  write(root, '1. Seestar S50/4. NGC Objects/NGC 6910/Stacked_210_NGC 6910_10.0s_IRCUT_20260915-213012.jpg');
  write(root, '1. Seestar S50/2. IC Objects/IC 1396 - Elephants Trunk/Stacked_90_IC 1396_10.0s_IRCUT_20260908-213012.jpg');
  return root;
}

describe('scanImportFolder — category and device folders are containers, not objects', () => {
  const NAMED_AFTER_GROUPS = ['1. Caldwell Objects', '2. IC Objects', '4. NGC Objects', '1. Seestar S50'];

  it('from the device root, finds the real objects with catalog matches', () => {
    const scan = scanImportFolder(reporterTree(), SETTINGS);
    const ids = scan.objects.map(o => o.catalogMatch?.objectId).sort();
    expect(ids).toEqual(['IC1396', 'NGC188', 'NGC6910']);
    for (const name of NAMED_AFTER_GROUPS) {
      expect(scan.objects.map(o => o.folderName)).not.toContain(name);
    }
  });

  it('from a category folder one level down, also finds the objects (depth-independent)', () => {
    const root = reporterTree();
    const scan = scanImportFolder(path.join(root, '1. Seestar S50'), SETTINGS);
    expect(scan.objects.map(o => o.catalogMatch?.objectId).sort()).toEqual(['IC1396', 'NGC188', 'NGC6910']);
  });

  it('keeps an object folder\'s _sub companion with it', () => {
    const scan = scanImportFolder(reporterTree(), SETTINGS);
    const c1 = scan.objects.find(o => o.catalogMatch?.objectId === 'NGC188');
    expect(c1?.fileCount).toBe(2);
  });

  it('does not turn an object folder holding dated session folders into a container', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-scanfix-'));
    roots.push(root);
    write(root, 'M 31 - Andromeda/2026-01-01/frame_a.fit');
    write(root, 'M 31 - Andromeda/2026-01-02/frame_b.fit');
    const scan = scanImportFolder(root, SETTINGS);
    expect(scan.objects).toHaveLength(1);
    expect(scan.objects[0].catalogMatch?.objectId).toBe('M31');
    expect(scan.objects[0].fileCount).toBe(2);
  });

  it('leaves a flat tree of object folders exactly as before', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebulis-scanfix-'));
    roots.push(root);
    write(root, 'M31/Stacked_10_M 31_10.0s_IRCUT_20260101-200000.jpg');
    write(root, 'M42/Stacked_10_M 42_10.0s_IRCUT_20260102-200000.jpg');
    const scan = scanImportFolder(root, SETTINGS);
    expect(scan.objects.map(o => o.catalogMatch?.objectId).sort()).toEqual(['M31', 'M42']);
  });
});
