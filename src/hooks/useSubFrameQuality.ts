import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getSubFrameQuality,
  setSubFrameReview,
  type SubFrameQualityReport,
  type SubFrameQualityRow,
} from '../lib/api/library';

const qualityKey = (objectId: string, date: string) => ['subframe-quality', objectId, date];

/** Shared query for a night's quality report: the Sub-frames tile reads it
 *  for its button and thumbnail badges, the panel and the viewer for
 *  everything else. Polls while a measurement job runs. */
export function useSubFrameQuality(objectId: string, date: string, enabled = true) {
  return useQuery({
    queryKey: qualityKey(objectId, date),
    queryFn: () => getSubFrameQuality(objectId, date),
    enabled: enabled && !!objectId && !!date,
    refetchInterval: q => (q.state.data?.job?.running ? 1500 : false),
  });
}

/** The automatic decision when the user has not overridden it (mirrors
 *  getQualityReport on the server). */
const autoAccepted = (r: SubFrameQualityRow) => !r.measured || r.grade !== 'poor';

/**
 * Keep / drop one sub, or hand it back to the automatic decision (`null`).
 *
 * The cached report is patched before the request goes out so that pressing
 * K while blinking through a night updates the viewer at once; the report is
 * refetched afterwards either way, so the server stays the source of truth.
 */
export function useSubFrameReview(objectId: string, date: string) {
  const queryClient = useQueryClient();
  return useCallback(async (row: SubFrameQualityRow, rejected: boolean | null) => {
    const key = qualityKey(objectId, date);
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<SubFrameQualityReport>(key, prev => {
      if (!prev) return prev;
      const frames = prev.frames.map(f => f.relPath !== row.relPath ? f : {
        ...f,
        manual: rejected === null ? null : rejected ? 'rejected' as const : 'accepted' as const,
        accepted: rejected === null ? autoAccepted(f) : !rejected,
      });
      return { ...prev, frames, accepted: frames.filter(f => f.accepted).length };
    });
    try {
      await setSubFrameReview(row.relPath, rejected);
    } finally {
      await queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient, objectId, date]);
}
