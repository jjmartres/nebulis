/**
 * Modal wrapper around WishlistAddSearch ("find things to image": the
 * catalog-wide browser that adds new targets to the wishlist). Used to sit
 * inline in WishlistPage's header row, right above WishlistList's own
 * "search your wishlist" filter field. The two nearly-identical search
 * inputs stacked that close together read as an accidental duplicate
 * rather than two different tools (search the catalog to add vs. filter
 * what's already on the list), so the add flow moved behind its own
 * button + modal instead.
 *
 * Sized to actually use a large screen — WishlistAddSearch is a real
 * browser now (type filter chips, sort, paginated results grid), not a
 * short dropdown under an input, so this needs real width and height
 * rather than a small centered card. `h-[min(85vh,820px)]` caps growth on
 * very tall displays while still filling most of the viewport on typical
 * ones; the panel is a flex column so the title stays pinned and only the
 * results grid inside WishlistAddSearch scrolls.
 */
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { WishlistAddSearch } from './WishlistAddSearch';
import type { WishlistCandidate } from '../../hooks/useWishlist';
import type { WishlistItem, WishlistPriority } from '../../lib/api/wishlist';
import type { PlannerTarget } from '../../lib/api/planner';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  idSet: Set<string>;
  wishlistItems: WishlistItem[];
  onAdd: (candidate: WishlistCandidate) => void;
  onSetPriority: (id: string, priority: WishlistPriority) => void;
  onSetNotes: (id: string, notes: string) => void;
  onRemove: (id: string) => void;
  targets: PlannerTarget[];
  observerLat: number | null;
  observerLon: number | null;
  minAlt: number;
  moonIllumination?: number;
  observerTimezone?: string;
  isDark: boolean;
  isNight: boolean;
  isSpace: boolean;
}

export function AddToWishlistModal({
  isOpen,
  onClose,
  idSet,
  wishlistItems,
  onAdd,
  onSetPriority,
  onSetNotes,
  onRemove,
  targets,
  observerLat,
  observerLon,
  minAlt,
  moonIllumination,
  observerTimezone,
  isDark,
  isNight,
  isSpace,
}: Props) {
  const { t } = useTranslation('planner');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('wishlistPage.findThingsToImage')} backdropClassName="bg-black/70">
      <div className={`relative flex h-[min(85vh,820px)] w-[94vw] max-w-6xl mx-4 flex-col rounded-2xl border p-6 ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-xl'
      }`}>
        <h3 className={`mb-4 shrink-0 pr-8 font-display font-semibold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {t('wishlistPage.findThingsToImage')}
        </h3>
        {/* Deliberately doesn't close on add: adding is usually a few targets
            in a row, and each result card shows a check mark in place of the
            add button once it's on the list, so the modal itself is the only
            feedback loop that needs to stay open. */}
        <div className="min-h-0 flex-1">
          <WishlistAddSearch
            idSet={idSet}
            wishlistItems={wishlistItems}
            onAdd={onAdd}
            onSetPriority={onSetPriority}
            onSetNotes={onSetNotes}
            onRemove={onRemove}
            targets={targets}
            observerLat={observerLat}
            observerLon={observerLon}
            minAlt={minAlt}
            moonIllumination={moonIllumination}
            observerTimezone={observerTimezone}
            isDark={isDark}
            isNight={isNight}
            isSpace={isSpace}
          />
        </div>
        {/* Rendered after the content rather than in a header row, so it
            isn't the first focusable element in the dialog: Modal focuses
            whatever's first on open, and the search input is what should
            grab that focus, not this button. Absolute positioning keeps it
            visually anchored top-right regardless of DOM order. */}
        <button
          onClick={onClose}
          aria-label={t('wishlistObjectModal.close')}
          className={`absolute right-4 top-4 rounded-lg p-1.5 transition ${
            isDark ? 'text-slate-500 hover:text-slate-200 hover:bg-white/5' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
          }`}
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </Modal>
  );
}
