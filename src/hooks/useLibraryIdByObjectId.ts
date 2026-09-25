import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLibraryObjects } from '../lib/api/library';

/**
 * Maps a catalog/object id (including variant ids) to the library object id
 * that holds it, so any surface showing catalog objects can say "already
 * imaged" without re-deriving this itself. Matched against both the library
 * object's own id and its catalog id (mosaics/variants rekey the folder id
 * away from the catalog id — see ObjectDetail's identical matching).
 * Extracted from WishlistList so WishlistObjectModal's "imaged" badge/button
 * reads correctly from other surfaces too (e.g. the "Find things to image"
 * search, which shows the same modal for a result not yet on the wishlist).
 * Shared query key (`['library-objects']`) means every caller reuses one
 * cached fetch rather than paying for it again.
 */
export function useLibraryIdByObjectId() {
  const libraryQuery = useQuery({ queryKey: ['library-objects'], queryFn: getLibraryObjects, staleTime: 60_000 });
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const obj of libraryQuery.data ?? []) {
      map.set(obj.catalogId, obj.id);
      map.set(obj.id, obj.id);
      for (const v of obj.variants ?? []) map.set(v.objectId, obj.id);
    }
    return map;
  }, [libraryQuery.data]);
}
