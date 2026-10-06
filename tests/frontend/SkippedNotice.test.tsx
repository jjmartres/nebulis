// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../src/i18n';
import { SkippedNotice } from '../../src/components/SkippedNotice';
import type { ImportSkip } from '../../src/lib/api/library';

const SKIPPED: ImportSkip[] = [
  { reason: 'thumbnails-disabled', label: 'thumbnails, because thumbnail import is off', count: 11, bytes: 422_000, samples: [] },
  { reason: 'non-observation-folder', label: 'folders that hold no observations', count: 2, bytes: 0, samples: ['CALI_FRAME', 'RESTACKED'] },
];

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('SkippedNotice', () => {
  it('lists every skip with its count, size and the excluded folder names', () => {
    const html = renderToStaticMarkup(<SkippedNotice skipped={SKIPPED} isDark excludedFolders={['CALI_FRAME', 'RESTACKED']} />);
    expect(html).toContain('13 files will not be imported');
    expect(html).toContain('thumbnails, because thumbnail import is off');
    expect(html).toContain('CALI_FRAME, RESTACKED');
  });

  it('offers Archive everything for files that switch would bring across', () => {
    const html = renderToStaticMarkup(<SkippedNotice skipped={SKIPPED} isDark />);
    expect(html).toContain('Archive everything');
  });

  it('leaves the archive offer out when the caller has no archive mode, as a linked folder does', () => {
    const html = renderToStaticMarkup(<SkippedNotice skipped={SKIPPED} isDark archiveHint={false} />);
    expect(html).not.toContain('Archive everything');
    // Everything else about the accounting is unchanged.
    expect(html).toContain('thumbnails, because thumbnail import is off');
  });

  it('takes its own lead-in, so a link can say "linked" and not "imported"', () => {
    const html = renderToStaticMarkup(<SkippedNotice skipped={SKIPPED} isDark heading={n => `${n} files will not be linked:`} />);
    expect(html).toContain('13 files will not be linked:');
    expect(html).not.toContain('will not be imported');
  });

  it('renders nothing when nothing was skipped', () => {
    expect(renderToStaticMarkup(<SkippedNotice skipped={[]} isDark />)).toBe('');
    expect(renderToStaticMarkup(<SkippedNotice skipped={null} isDark />)).toBe('');
  });
});
