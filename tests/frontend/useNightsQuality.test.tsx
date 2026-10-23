// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNightsQuality } from '../../src/hooks/useNightsQuality';
import type { SubFrameQualityReport, SubFrameQualityRow } from '../../src/lib/api/library';

const analyzeSubFrameQuality = vi.fn(async (objectId: string, night: string) => ({ objectId, night }));
vi.mock('../../src/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/lib/api/library')>()),
  analyzeSubFrameQuality: (objectId: string, night: string) => analyzeSubFrameQuality(objectId, night),
}));

const row = (fileName: string, over: Partial<SubFrameQualityRow> = {}): SubFrameQualityRow => ({
  relPath: `NGC6888/${fileName}`, fileName, filter: 'H', exposureSec: 180, dateObs: null,
  measured: true, error: null, stars: 200, hfr: 2.1, fwhm: 4.4, eccentricity: 0.3, background: 1000, noise: 6,
  grade: 'good', flags: [], weight: 1, manual: null, accepted: true, ...over,
});
const report = (night: string, frames: SubFrameQualityRow[], job: SubFrameQualityReport['job'] = null): SubFrameQualityReport => ({
  objectId: 'NGC6888', night, job, total: frames.length, measured: frames.filter(f => f.measured).length,
  accepted: frames.filter(f => f.accepted).length, groups: [], frames,
});

async function probe(client: QueryClient, nights: string[]) {
  let value: ReturnType<typeof useNightsQuality> | undefined;
  function Probe() {
    value = useNightsQuality('NGC6888', nights);
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  return { get: () => value!, root };
}

function clientWith(...reports: SubFrameQualityReport[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const r of reports) client.setQueryData(['subframe-quality', 'NGC6888', r.night], r);
  return client;
}

describe('useNightsQuality', () => {
  it('lists the nights still to measure, ignoring unreadable files', async () => {
    const client = clientWith(
      report('2026-09-05', [row('a.fit'), row('broken.fit', { measured: false, error: 'bad header' })]),
      report('2026-09-07', [row('b.fit', { measured: false }), row('c.fit', { measured: false })]),
    );
    const { get, root } = await probe(client, ['2026-09-05', '2026-09-07']);
    expect(get()).toMatchObject({ loaded: true, unmeasuredNights: ['2026-09-07'], unmeasuredFrames: 2, measuring: false });

    await act(async () => { await get().measure(); });
    expect(analyzeSubFrameQuality).toHaveBeenCalledWith('NGC6888', '2026-09-07');
    expect(analyzeSubFrameQuality).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('sums the progress of running jobs', async () => {
    const job = (done: number, total: number) => ({ total, done, running: true, startedAt: '', finishedAt: null, cancelled: false });
    const client = clientWith(
      report('2026-09-05', [row('a.fit', { measured: false })], job(10, 40)),
      report('2026-09-07', [row('b.fit', { measured: false })], job(5, 20)),
    );
    const { get, root } = await probe(client, ['2026-09-05', '2026-09-07']);
    expect(get()).toMatchObject({ measuring: true, done: 15, total: 60, unmeasuredNights: [] });
    root.unmount();
  });
});
