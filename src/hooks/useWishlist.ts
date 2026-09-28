import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addToWishlist,
  getWishlist,
  removeWishlistItem,
  removeWishlistItemByObjectId,
  updateWishlistItem,
  type WishlistPriority,
} from '../lib/api/wishlist';

/** Minimal shape any object-ish source (a catalog entry, a planner target, an
 *  imported wishlist file) needs to supply to be added to the wishlist.
 *  `priority`/`notes` are optional so a star-toggle candidate (which has
 *  neither) and an imported entry (which may carry both, to round-trip an
 *  export faithfully) can share the same call. */
export interface WishlistCandidate {
  objectId: string;
  name: string;
  type?: string | null;
  constellation?: string | null;
  magnitude?: number | null;
  majorAxisArcmin?: number | null;
  priority?: WishlistPriority;
  notes?: string;
}

/**
 * Shared wishlist state: one query backs every surface that shows or edits it
 * (Catalogs board/modal, Planner's target picker, the dedicated Wishlist
 * panel), so a toggle in one place is reflected everywhere without a second
 * fetch. `idSet` is the cheap "is this object on the list" lookup the grid and
 * row components need; `toggle` is what a star button calls.
 */
export function useWishlist() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['wishlist'], queryFn: getWishlist, staleTime: 30_000 });
  const items = useMemo(() => query.data ?? [], [query.data]);

  const idSet = useMemo(() => new Set(items.map(i => i.objectId)), [items]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['wishlist'] }),
    [queryClient],
  );

  const addMutation = useMutation({ mutationFn: addToWishlist, onSuccess: invalidate });
  const removeMutation = useMutation({ mutationFn: removeWishlistItemByObjectId, onSuccess: invalidate });
  const removeByIdMutation = useMutation({ mutationFn: removeWishlistItem, onSuccess: invalidate });
  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { priority?: WishlistPriority; notes?: string } }) =>
      updateWishlistItem(id, patch),
    onSuccess: invalidate,
  });

  /** Add-only: a no-op when the object is already on the list, rather than
   *  toggling it off. Used by search-to-add UI, where a second click on an
   *  already-added result must never look like a removal. */
  const add = useCallback((candidate: WishlistCandidate) => {
    if (idSet.has(candidate.objectId)) return;
    addMutation.mutate({
      objectId: candidate.objectId,
      name: candidate.name,
      type: candidate.type ?? '',
      constellation: candidate.constellation ?? null,
      magnitude: candidate.magnitude ?? null,
      majorAxisArcmin: candidate.majorAxisArcmin ?? null,
      priority: candidate.priority ?? 'medium',
      notes: candidate.notes ?? '',
    });
  }, [idSet, addMutation]);

  const toggle = useCallback((candidate: WishlistCandidate) => {
    if (idSet.has(candidate.objectId)) {
      removeMutation.mutate(candidate.objectId);
    } else {
      add(candidate);
    }
  }, [idSet, add, removeMutation]);

  const setPriority = useCallback(
    (id: string, priority: WishlistPriority) => patchMutation.mutate({ id, patch: { priority } }),
    [patchMutation],
  );

  const setNotes = useCallback(
    (id: string, notes: string) => patchMutation.mutate({ id, patch: { notes } }),
    [patchMutation],
  );

  /** Remove by wishlist row id (the WishlistPanel's delete button — it already
   *  has the row, not just the catalog id). */
  const remove = useCallback((id: string) => removeByIdMutation.mutate(id), [removeByIdMutation]);

  return {
    items,
    idSet,
    isLoading: query.isLoading,
    add,
    toggle,
    setPriority,
    setNotes,
    remove,
  };
}
