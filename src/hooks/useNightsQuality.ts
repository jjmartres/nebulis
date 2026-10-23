import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { analyzeSubFrameQuality, getSubFrameQuality } from '../lib/api/library';

export interface NightsQuality {
  /** Nights whose quality report has loaded. */
  loaded: boolean;
  /** Nights with sub-frames never measured (unreadable files don't count). */
  unmeasuredNights: string[];
  /** Sub-frames still to measure across those nights. */
  unmeasuredFrames: number;
  /** A measurement job runs on at least one night. */
  measuring: boolean;
  done: number;
  total: number;
}

/**
 * Sub-frame quality state of several nights at once, for the stacking
 * export: which nights still need measuring (so the Keep selection can
 * apply), the progress of running jobs, and `measure()` to start them.
 * Shares the `['subframe-quality', objectId, night]` cache with the
 * observation page. Calls `onSettled` when the last running job finishes,
 * so the caller can rebuild whatever depends on the decisions.
 */
export function useNightsQuality(objectId: string, nights: string[], onSettled?: () => void) {
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: nights.map(night => ({
      queryKey: ['subframe-quality', objectId, night],
      queryFn: () => getSubFrameQuality(objectId, night),
      refetchInterval: (q: { state: { data?: { job?: { running?: boolean } | null } } }) => (q.state.data?.job?.running ? 1500 : false),
    })),
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useMemo<NightsQuality>(() => {
    const unmeasuredNights: string[] = [];
    let unmeasuredFrames = 0;
    let measuring = false;
    let done = 0;
    let total = 0;
    results.forEach((r, i) => {
      const report = r.data;
      if (!report) return;
      const missing = report.frames.filter(f => !f.measured && !f.error).length;
      if (report.job?.running) {
        measuring = true;
        done += report.job.done;
        total += report.job.total;
      } else if (missing > 0) {
        unmeasuredNights.push(nights[i]);
        unmeasuredFrames += missing;
      }
    });
    return { loaded: results.every(r => !!r.data), unmeasuredNights, unmeasuredFrames, measuring, done, total };
  }, [results, nights]);

  // Fire onSettled on the running → finished transition only.
  const wasMeasuring = useRef(false);
  useEffect(() => {
    if (wasMeasuring.current && !state.measuring) onSettled?.();
    wasMeasuring.current = state.measuring;
  }, [state.measuring, onSettled]);

  const measure = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      // One job per night; the server yields between files, so they share
      // the CPU rather than block requests.
      for (const night of state.unmeasuredNights) await analyzeSubFrameQuality(objectId, night);
      await Promise.all(state.unmeasuredNights.map(night =>
        queryClient.invalidateQueries({ queryKey: ['subframe-quality', objectId, night] })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [objectId, queryClient, state.unmeasuredNights]);

  return { ...state, starting, error, measure };
}
