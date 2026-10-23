// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { SubframeQualityBar } from '../../src/components/observationDetail/SubframeQualityBar';
import { useSubframeGalleryExtras } from '../../src/hooks/useSubframeGalleryExtras';
import type { GalleryItem, GalleryItemExtras } from '../../src/components/GalleryModal';
import type { SubFrameQualityReport, SubFrameQualityRow } from '../../src/lib/api/library';
import type { SessionFile } from '../../src/types';

const setSubFrameReview = vi.fn(async (relPath: string, rejected: boolean | null) => ({ relPath, rejected }));
vi.mock('../../src/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/lib/api/library')>()),
  setSubFrameReview: (relPath: string, rejected: boolean | null) => setSubFrameReview(relPath, rejected),
}));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const row = (fileName: string, over: Partial<SubFrameQualityRow> = {}): SubFrameQualityRow => ({
  relPath: `NGC6888/${fileName}`, fileName, filter: 'H', exposureSec: 180, dateObs: null,
  measured: true, error: null, stars: 412, hfr: 2.31, fwhm: 4.6, eccentricity: 0.32, background: 812, noise: 6,
  grade: 'good', flags: [], weight: 1, manual: null, accepted: true, ...over,
});

const noop = async () => {};

describe('SubframeQualityBar', () => {
  it('shows every measure of the sub on screen with its grade and Keep', () => {
    const html = renderToStaticMarkup(<SubframeQualityBar row={row('a.fits')} isAdmin onReview={noop} />);
    for (const s of ['Filter', '>H<', 'HFR', '2.31 px', 'FWHM', '4.6 px', 'Stars', '412', 'Elong.', '0.32', 'Background', '812', '>Good<', 'Keep', 'automatic']) {
      expect(html).toContain(s);
    }
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
  });

  it('spells out the flags of a poor sub and offers to go back to auto after an override', () => {
    const html = renderToStaticMarkup(
      <SubframeQualityBar row={row('soft.fits', { grade: 'poor', flags: ['very_soft'], manual: 'accepted' })} isAdmin onReview={noop} />,
    );
    expect(html).toContain('>Poor<');
    expect(html).toContain('Much softer than the night');
    expect(html).toContain('>auto<');
  });

  it('is read-only for viewers and says when the night is not measured', () => {
    expect(renderToStaticMarkup(<SubframeQualityBar row={row('a.fits')} isAdmin={false} onReview={noop} />)).toContain('disabled=""');
    expect(renderToStaticMarkup(
      <SubframeQualityBar row={row('a.fits', { measured: false, grade: null })} isAdmin onReview={noop} />,
    )).toContain('Not measured yet');
  });
});

describe('useSubframeGalleryExtras', () => {
  const report: SubFrameQualityReport = {
    objectId: 'NGC6888', night: '2026-09-05', job: null, total: 2, measured: 2, accepted: 1,
    groups: [], frames: [row('a.fits'), row('b.fits', { grade: 'poor', accepted: false })],
  };
  const item = (name: string): GalleryItem => ({ kind: 'file', file: { name, path: `NGC6888/${name}`, type: 'fits' } as SessionFile });

  it('dims subs that are not kept and toggles Keep on K, updating the viewer at once', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const key = ['subframe-quality', 'NGC6888', '2026-09-05'];
    client.setQueryData(key, report);
    let extras: GalleryItemExtras | undefined;
    function Probe() {
      extras = useSubframeGalleryExtras('NGC6888', '2026-09-05', true, true);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));

    expect(extras?.dimmed?.(item('a.fits'))).toBe(false);
    expect(extras?.dimmed?.(item('b.fits'))).toBe(true);

    // Kept by the grade → K drops it.
    const pending = act(async () => extras?.onToggleKeep?.(item('a.fits')));
    await pending;
    expect(setSubFrameReview).toHaveBeenCalledWith('NGC6888/a.fits', true);
    const after = client.getQueryData<SubFrameQualityReport>(key);
    expect(after?.frames[0]).toMatchObject({ manual: 'rejected', accepted: false });
    expect(after?.accepted).toBe(0);
    root.unmount();
  });

  it('adds nothing for viewers but the read-only bar', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['subframe-quality', 'NGC6888', '2026-09-05'], report);
    let extras: GalleryItemExtras | undefined;
    function Probe() {
      extras = useSubframeGalleryExtras('NGC6888', '2026-09-05', true, false);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    expect(extras?.onToggleKeep).toBeUndefined();
    expect(extras?.info).toBeTypeOf('function');
    root.unmount();
  });
});
