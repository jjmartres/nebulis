/**
 * "Find things to image": browses the full DSO catalog (not just what's
 * already on the wishlist) and lets you add a result straight from the
 * grid. This is the wishlist page's discovery surface — the Catalogs board
 * is the other way in, but it's scoped to one named program at a time.
 *
 * Free-text search, a type filter, and a sort override all compose against
 * one server call (`browseDsoCatalog`, the `/dso` route's fuller mode) with
 * real offset/limit pagination, loaded incrementally via `useInfiniteQuery`
 * so "Load more" appends a page instead of re-fetching everything. A blank
 * query is valid here (unlike the old inline dropdown, which only rendered
 * once you typed): filtering by type alone browses that whole category.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Check, Info, Loader2, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatObjectName } from '../../lib/utils';
import { getCatalogThumbnailUrl } from '../../lib/catalogImage';
import { browseDsoCatalog, type DsoEntry, type DsoSort, type PlannerTarget } from '../../lib/api/planner';
import type { WishlistCandidate } from '../../hooks/useWishlist';
import type { WishlistItem, WishlistPriority } from '../../lib/api/wishlist';
import { useLibraryIdByObjectId } from '../../hooks/useLibraryIdByObjectId';
import { WishlistObjectModal } from './WishlistObjectModal';

interface Props {
  idSet: Set<string>;
  /** Real wishlist rows, so opening the (i) popup for a result that's
   *  already on the list shows the actual item (full priority/notes/remove
   *  functionality) instead of a preview — see WishlistAddSearch's info
   *  modal wiring below. */
  wishlistItems: WishlistItem[];
  onAdd: (candidate: WishlistCandidate) => void;
  onSetPriority: (id: string, priority: WishlistPriority) => void;
  onSetNotes: (id: string, notes: string) => void;
  onRemove: (id: string) => void;
  /** Tonight's observable targets, so the info popup can show live
   *  altitude/visibility stats exactly like WishlistList's rows do. */
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

type SortId = 'best' | DsoSort;

interface TypeFilter {
  id: string;
  labelKey: string;
  /** Sent as `/dso`'s `type` param, which matches by substring-in-label OR
   *  exact typeCode (server/lib/dsoCatalog.ts) — so a broad term like
   *  "galaxy" also catches "Galaxy Pair"/"Galaxy Triplet"/"Galaxy Group",
   *  and "nebula" catches every nebula variant including "Planetary
   *  Nebula". That overlap is deliberate: it's why "Planetary Nebula" and
   *  "Supernova Remnant" get their own more specific chips alongside the
   *  broader "Nebula" one rather than needing exact taxonomy coverage. */
  typeParam?: string;
}

const TYPE_FILTERS: TypeFilter[] = [
  { id: 'all', labelKey: 'wishlistPage.typeAll' },
  { id: 'galaxy', labelKey: 'wishlistPage.typeGalaxy', typeParam: 'galaxy' },
  { id: 'nebula', labelKey: 'wishlistPage.typeNebula', typeParam: 'nebula' },
  { id: 'planetary-nebula', labelKey: 'wishlistPage.typePlanetaryNebula', typeParam: 'planetary nebula' },
  { id: 'supernova-remnant', labelKey: 'wishlistPage.typeSupernovaRemnant', typeParam: 'supernova remnant' },
  { id: 'open-cluster', labelKey: 'wishlistPage.typeOpenCluster', typeParam: 'open cluster' },
  { id: 'globular-cluster', labelKey: 'wishlistPage.typeGlobularCluster', typeParam: 'globular cluster' },
  { id: 'double-star', labelKey: 'wishlistPage.typeDoubleStar', typeParam: 'double star' },
  { id: 'star-cloud', labelKey: 'wishlistPage.typeStarCloud', typeParam: 'star cloud' },
  { id: 'other', labelKey: 'wishlistPage.typeOther', typeParam: 'other' },
];

const SORT_OPTIONS: { id: SortId; labelKey: string }[] = [
  { id: 'best', labelKey: 'wishlistPage.sortBestMatch' },
  { id: 'name', labelKey: 'wishlistPanel.sortName' },
  { id: 'magnitude', labelKey: 'wishlistPanel.sortMagnitude' },
];

const PAGE_SIZE = 30;

export function WishlistAddSearch({
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
  const [query, setQuery] = useState('');
  const [typeFilterId, setTypeFilterId] = useState('all');
  const [sort, setSort] = useState<SortId>('best');
  // Checked by default: hides objects that can never clear `minAlt` from
  // this latitude on any night of the year (e.g. deep-southern-declination
  // targets from a northern site) — a pure geometry filter, not "not up
  // tonight". Only meaningful with a known location, so it's disabled (and
  // has no effect regardless of its checked state) when observerLat is null.
  const [onlyVisible, setOnlyVisible] = useState(true);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const trimmed = deferredQuery.trim();
  const typeFilter = TYPE_FILTERS.find(f => f.id === typeFilterId);
  const libraryIdByObjectId = useLibraryIdByObjectId();
  const targetsById = useMemo(() => {
    const map = new Map<string, PlannerTarget>();
    for (const target of targets) map.set(target.id, target);
    return map;
  }, [targets]);

  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';

  const applyLocationFilter = onlyVisible && observerLat != null;

  const browseQuery = useInfiniteQuery({
    queryKey: ['dso-browse', trimmed, typeFilterId, sort, applyLocationFilter, observerLat, minAlt],
    queryFn: ({ pageParam }) => browseDsoCatalog({
      q: trimmed || undefined,
      type: typeFilter?.typeParam,
      lat: applyLocationFilter ? observerLat : undefined,
      minAlt: applyLocationFilter ? minAlt : undefined,
      sort: sort === 'best' ? undefined : sort,
      limit: PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.results.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    staleTime: 60_000,
  });

  const entries = browseQuery.data?.pages.flatMap(p => p.results) ?? [];
  const total = browseQuery.data?.pages[0]?.total ?? 0;

  const openIndex = openEntryId ? entries.findIndex(e => e.id === openEntryId) : -1;
  const openEntry = openIndex >= 0 ? entries[openIndex] : null;
  // If the object opened via (i) is already a real wishlist row, show that
  // row (full priority/notes/remove) instead of a throwaway preview one —
  // see WishlistObjectModal's `isPreview` doc for why the two differ.
  const realOpenItem = openEntry ? wishlistItems.find(i => i.objectId === openEntry.id) : undefined;

  function candidateFor(entry: DsoEntry): WishlistCandidate {
    return {
      objectId: entry.id,
      name: entry.name,
      type: entry.type,
      constellation: entry.constellation,
      magnitude: entry.magnitude,
      majorAxisArcmin: entry.majorAxisArcmin,
    };
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative shrink-0">
        <Search className={`absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 ${subtle}`} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          placeholder={t('wishlistPage.findPlaceholder')}
          className={`w-full rounded-xl py-3.5 pl-11 pr-10 text-base outline-none transition ${
            isDark
              ? 'border border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500 focus:border-amber-500'
              : 'border border-slate-200 bg-slate-100 text-slate-900 placeholder:text-slate-500 focus:border-amber-500'
          }`}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('wishlistPage.clearSearch')}
            className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 transition-colors ${
              isDark ? 'text-slate-500 hover:text-slate-200' : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap gap-1.5">
        {TYPE_FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setTypeFilterId(f.id)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              typeFilterId === f.id
                ? 'bg-amber-500 text-white'
                : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      <div className={`mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b ${border} pb-3 text-xs ${subtle}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label
            className={`flex items-center gap-1.5 ${observerLat == null ? 'opacity-50' : ''}`}
            title={observerLat == null ? t('wishlistPage.onlyVisibleNoLocation') : undefined}
          >
            <input
              type="checkbox"
              checked={onlyVisible}
              disabled={observerLat == null}
              onChange={(e) => setOnlyVisible(e.target.checked)}
              className="rounded"
            />
            {t('wishlistPage.onlyVisibleFromLocation')}
          </label>
          <span>
            {browseQuery.isLoading ? ' ' : t('wishlistPage.showingCount', { count: entries.length, total })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-0.5">{t('wishlistPanel.sortLabel')}</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.id}
              onClick={() => setSort(opt.id)}
              className={`rounded-full px-2.5 py-1 font-medium transition ${
                sort === opt.id
                  ? 'bg-amber-500 text-white'
                  : isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {browseQuery.isLoading ? (
          <p className={`px-1 py-8 text-center text-sm ${subtle}`}>{t('wishlistPage.loading')}</p>
        ) : entries.length === 0 ? (
          <p className={`px-1 py-8 text-center text-sm ${subtle}`}>{t('wishlistPage.noResults')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {entries.map(entry => (
                <DsoResultCard
                  key={entry.id}
                  entry={entry}
                  already={idSet.has(entry.id)}
                  isDark={isDark}
                  onAdd={() => onAdd(candidateFor(entry))}
                  onInfo={() => setOpenEntryId(entry.id)}
                />
              ))}
            </div>
            {browseQuery.hasNextPage && (
              <div className="mt-4 flex justify-center pb-1">
                <button
                  onClick={() => browseQuery.fetchNextPage()}
                  disabled={browseQuery.isFetchingNextPage}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-60 ${
                    isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {browseQuery.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {browseQuery.isFetchingNextPage ? t('wishlistPage.loadingMore') : t('wishlistPage.loadMore')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {openEntry && (
        <WishlistObjectModal
          item={realOpenItem ?? {
            id: openEntry.id,
            objectId: openEntry.id,
            name: openEntry.name,
            type: openEntry.type,
            constellation: openEntry.constellation,
            magnitude: openEntry.magnitude,
            majorAxisArcmin: openEntry.majorAxisArcmin,
            priority: 'medium',
            notes: '',
            addedAt: new Date().toISOString(),
          }}
          isPreview={!realOpenItem}
          onAdd={onAdd}
          target={targetsById.get(openEntry.id)}
          isImaged={libraryIdByObjectId.has(openEntry.id)}
          libraryObjectId={libraryIdByObjectId.get(openEntry.id) ?? null}
          observerLat={observerLat}
          observerLon={observerLon}
          minAlt={minAlt}
          moonIllumination={moonIllumination}
          observerTimezone={observerTimezone}
          isDark={isDark}
          isNight={isNight}
          isSpace={isSpace}
          onSetPriority={onSetPriority}
          onSetNotes={onSetNotes}
          onRemove={onRemove}
          onClose={() => setOpenEntryId(null)}
          hasPrev={openIndex > 0}
          hasNext={openIndex < entries.length - 1}
          onPrev={() => setOpenEntryId(entries[Math.max(0, openIndex - 1)].id)}
          onNext={() => setOpenEntryId(entries[Math.min(entries.length - 1, openIndex + 1)].id)}
        />
      )}
    </div>
  );
}

function DsoResultCard({ entry, already, isDark, onAdd, onInfo }: {
  entry: DsoEntry;
  already: boolean;
  isDark: boolean;
  onAdd: () => void;
  onInfo: () => void;
}) {
  const { t } = useTranslation('planner');
  const subtle = isDark ? 'text-slate-400' : 'text-slate-500';
  const displayName = formatObjectName(entry.id, entry.name);

  return (
    <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'}`}>
      <div className="relative aspect-square bg-slate-950">
        <img
          src={getCatalogThumbnailUrl(entry.id, entry.majorAxisArcmin)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
        {already && (
          <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="truncate text-sm font-medium">{displayName}</div>
        <div className={`truncate text-xs ${subtle}`}>
          {[entry.type, entry.constellation, entry.magnitude != null ? t('wishlistPanel.mag', { value: entry.magnitude.toFixed(1) }) : null]
            .filter(Boolean).join(' · ')}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            onClick={onInfo}
            className={`flex items-center justify-center rounded-lg p-1.5 transition ${
              isDark ? 'bg-slate-800 text-slate-400 hover:text-slate-200' : 'bg-slate-100 text-slate-500 hover:text-slate-700'
            }`}
            aria-label={t('wishlistPage.viewDetails', { name: displayName })}
            title={t('wishlistPage.viewDetails', { name: displayName })}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onAdd}
            disabled={already}
            className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-medium transition ${
              already
                ? isDark ? 'bg-emerald-500/15 text-emerald-400 cursor-default' : 'bg-emerald-600/15 text-emerald-700 cursor-default'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {already ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {already ? t('wishlistPage.added') : t('wishlistPage.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
