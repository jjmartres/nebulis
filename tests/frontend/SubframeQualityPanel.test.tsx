// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../src/i18n';
import { ThemeProvider } from '../../src/hooks/useTheme';
import { SubframeQualityPanel } from '../../src/components/observationDetail/SubframeQualityPanel';
import type { SubFrameQualityReport, SubFrameQualityRow } from '../../src/lib/api/library';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const row = (fileName: string, over: Partial<SubFrameQualityRow> = {}): SubFrameQualityRow => ({
  relPath: `NGC6888/${fileName}`, fileName, filter: 'H', exposureSec: 180, dateObs: null,
  measured: true, error: null, stars: 200, hfr: 2.1, fwhm: 4.4, eccentricity: 0.3, background: 1000, noise: 6,
  grade: 'good', flags: [], weight: 1, manual: null, accepted: true, ...over,
});

function render(report: SubFrameQualityReport, isAdmin = true): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['subframe-quality', 'NGC6888', '2026-09-05'], report);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <SubframeQualityPanel objectId="NGC6888" date="2026-09-05" isAdmin={isAdmin} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const measured: SubFrameQualityReport = {
  objectId: 'NGC6888', night: '2026-09-05', job: null, total: 3, measured: 3, accepted: 2,
  groups: [{ filter: 'H', count: 3, hfr: 2.1, stars: 200 }],
  frames: [row('a.fits'), row('b.fits'), row('soft.fits', { hfr: 3.2, grade: 'poor', flags: ['very_soft'], accepted: false })],
};

describe('SubframeQualityPanel', () => {
  it('summarises the night, charts HFR and stars, and lists every sub with its grade', () => {
    const html = render(measured);
    expect(html).toContain('Sub-frame quality');
    expect(html).toContain('2 of 3 kept');
    expect(html).toContain('H: 3 frames, median HFR 2.1 px, 200 stars');
    expect(html).toContain('aria-label="HFR: 2.1 px – 3.2 px"');
    expect(html).toContain('>Poor<');
    expect(html).toContain('title="Much softer than the night"');
    expect(html).toContain('Measure again');
  });

  it('offers to measure when nothing is measured yet (admin only)', () => {
    const fresh = { ...measured, measured: 0, accepted: 3, groups: [], frames: measured.frames.map(f => ({ ...f, measured: false, grade: null, hfr: null, stars: null })) };
    expect(render(fresh)).toContain('Measure 3 sub-frames');
    expect(render(fresh, false)).not.toContain('Measure 3 sub-frames');
  });

  it('shows progress while a job runs', () => {
    const html = render({ ...measured, job: { total: 10, done: 4, running: true, startedAt: '', finishedAt: null, cancelled: false } });
    expect(html).toContain('Measuring 4 / 10');
    expect(html).toContain('aria-valuenow="4"');
  });
});
