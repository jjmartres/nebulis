import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getIntegrationProgress, type ObjectIntegrationProgress } from '../lib/api/library';
import { useLibraryIdByObjectId } from './useLibraryIdByObjectId';

/**
 * Progress toward per-filter integration goals, looked up by any id a Planner
 * or Wishlist surface holds (catalog id, variant id or library object id —
 * resolved through useLibraryIdByObjectId, like the "imaged" badge).
 *
 * One shared query for the whole page: the server only returns objects that
 * have goals, so the list stays small however large the library is.
 */
export function useIntegrationProgress(): (objectId: string) => ObjectIntegrationProgress | undefined {
  const libraryIdByObjectId = useLibraryIdByObjectId();
  const { data } = useQuery({
    queryKey: ['integration-progress'],
    queryFn: getIntegrationProgress,
    staleTime: 60_000,
  });

  const byLibraryId = useMemo(() => {
    const map = new Map<string, ObjectIntegrationProgress>();
    for (const p of data ?? []) map.set(p.objectId, p);
    return map;
  }, [data]);

  return useCallback(
    (objectId: string) => {
      const libraryId = libraryIdByObjectId.get(objectId) ?? objectId;
      return byLibraryId.get(libraryId);
    },
    [libraryIdByObjectId, byLibraryId],
  );
}
