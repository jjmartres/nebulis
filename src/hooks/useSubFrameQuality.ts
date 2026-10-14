import { useQuery } from '@tanstack/react-query';
import { getSubFrameQuality } from '../lib/api/library';

/** Shared query for a night's quality report: the Sub-frames tile reads it
 *  for its button and thumbnail badges, the panel for everything else. Polls
 *  while a measurement job runs. */
export function useSubFrameQuality(objectId: string, date: string, enabled = true) {
  return useQuery({
    queryKey: ['subframe-quality', objectId, date],
    queryFn: () => getSubFrameQuality(objectId, date),
    enabled: enabled && !!objectId && !!date,
    refetchInterval: q => (q.state.data?.job?.running ? 1500 : false),
  });
}
