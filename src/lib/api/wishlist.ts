/**
 * Wishlist / target queue: client for /api/v1/wishlist.
 */
import { fetchJSON } from './client';

export const WISHLIST_PRIORITIES = ['high', 'medium', 'low'] as const;
export type WishlistPriority = (typeof WISHLIST_PRIORITIES)[number];

export interface WishlistItem {
  id: string;
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  priority: WishlistPriority;
  notes: string;
  addedAt: string;
}

export interface WishlistItemCreate {
  objectId: string;
  name: string;
  type?: string;
  constellation?: string | null;
  magnitude?: number | null;
  majorAxisArcmin?: number | null;
  priority?: WishlistPriority;
  notes?: string;
}

interface WishlistItemPatch {
  priority?: WishlistPriority;
  notes?: string;
}

export const getWishlist = () => fetchJSON<WishlistItem[]>('/wishlist');

export const addToWishlist = (item: WishlistItemCreate) =>
  fetchJSON<WishlistItem>('/wishlist', { method: 'POST', body: JSON.stringify(item) });

export const updateWishlistItem = (id: string, patch: WishlistItemPatch) =>
  fetchJSON<WishlistItem>(`/wishlist/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const removeWishlistItem = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/wishlist/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const removeWishlistItemByObjectId = (objectId: string) =>
  fetchJSON<{ deleted: boolean }>(`/wishlist/object/${encodeURIComponent(objectId)}`, { method: 'DELETE' });
