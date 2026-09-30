/**
 * Serve a directory tree from disk through the in-process fake FTP server.
 * `mount` places the tree under a prefix, e.g. a Dwarf II layout where the
 * device root already contains `DWARF_II/Astronomy` needs no prefix at all
 * (the lab tree already has it), while a test can still mount elsewhere.
 */
import fs from 'fs';
import path from 'path';
import { startFakeFtpServer, type FakeDir, type FakeFtpServer } from './fakeFtpServer';

export function dirToFakeTree(root: string): FakeDir {
  const out: FakeDir = {};
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) out[e.name] = dirToFakeTree(abs);
    else if (e.isFile()) out[e.name] = fs.readFileSync(abs);
  }
  return out;
}

export function startFtpFromDisk(root: string): Promise<FakeFtpServer> {
  return startFakeFtpServer(dirToFakeTree(root));
}
