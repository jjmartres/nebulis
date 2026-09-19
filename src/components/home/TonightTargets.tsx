/**
 * Tonight's easy targets — photo tile grid for the Home dashboard.
 *
 * Design tokens are aligned with NightOverview ("What's Up Tonight") and
 * WeatherNight ("Weather Tonight"):
 *   - Same outer background (`bg-[#0e1117]` dark / `bg-slate-50` light)
 *   - Same border shade (`border-slate-700/50` dark / `border-slate-200` light)
 *   - Same header: amber circle icon badge + `text-lg font-bold` title +
 *     `text-[12px]` subtitle, with a `border-b` separator
 *   - Loading / error / empty states rendered inside the card body
 *   - DSO photo tiles + stat cells keep their own styling
 *
 * Features
 * ────────
 * • Add to Planner button on each tile (wishlist toggle, admin only)
 * • Shuffle button in the header right — random 10 from the full pool
 */
import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Telescope, RotateCw, AlertCircle, Shuffle,
  BookmarkPlus, BookmarkCheck,
} from 'lucide-react';
import {
  getPlannerTargets,
  addToWishlist,
  removeFromWishlist,
  type PlannerTarget,
} from '../../lib/api/planner';
import { formatTime } from '../../lib/forecastScore';
import {
  getCatalogStaticThumbnailUrl,
  getCatalogThumbnailUrl,
} from '../../lib/catalogImage';
import { useAuth } from '../../contexts/AuthContext';

interface Props {
  siteId: string | null;
  timeZone?: string;
  isDark: boolean;
}

// ─── Type badge ───────────────────────────────────────────────────────────

function typeColor(type: string): string {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))     return 'bg-violet-500/80 text-violet-50';
  if (l.includes('globular'))   return 'bg-amber-500/80  text-amber-50';
  if (l.includes('open'))       return 'bg-emerald-500/80 text-emerald-50';
  if (l.includes('planetary'))  return 'bg-cyan-500/80    text-cyan-50';
  if (l.includes('supernova'))  return 'bg-orange-500/80  text-orange-50';
  if (l.includes('emission'))   return 'bg-rose-500/80    text-rose-50';
  if (l.includes('reflection')) return 'bg-sky-500/80     text-sky-50';
  if (l.includes('nebula'))     return 'bg-rose-400/80    text-rose-50';
  if (l.includes('cluster'))    return 'bg-emerald-400/80 text-emerald-50';
  if (l.includes('double'))     return 'bg-slate-500/80   text-slate-50';
  return 'bg-slate-600/80 text-slate-50';
}

function shortType(type: string): string {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))     return 'galaxy';
  if (l.includes('globular'))   return 'globular cluster';
  if (l.includes('open'))       return 'open cluster';
  if (l.includes('planetary'))  return 'planetary nebula';
  if (l.includes('supernova'))  return 'supernova remnant';
  if (l.includes('emission'))   return 'emission nebula';
  if (l.includes('reflection')) return 'reflection nebula';
  if (l.includes('nebula'))     return 'nebula';
  if (l.includes('cluster'))    return 'cluster';
  if (l.includes('double'))     return 'double star';
  return type.toLowerCase();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmtTime(iso: string | null, tz?: string): string {
  return iso ? formatTime(iso, tz) : '–';
}

function durationLabel(from: string | null, to: string | null): string {
  if (!from || !to) return '–';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms <= 0) return '–';
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Diversity picker ─────────────────────────────────────────────────────

/** Broad object family used for diversity bucketing. */
type ObjectFamily = 'nebula' | 'cluster' | 'galaxy' | 'supernova' | 'double' | 'other';

/** Map a DSO type string to one of the broad families. */
function familyOf(type: string): ObjectFamily {
  const l = type.toLowerCase();
  if (l.includes('galaxy'))    return 'galaxy';
  if (l.includes('supernova')) return 'supernova';
  if (l.includes('double') || l.includes('star')) return 'double';
  if (l.includes('cluster'))   return 'cluster';
  if (l.includes('nebula') || l.includes('emission') ||
      l.includes('reflection') || l.includes('planetary')) return 'nebula';
  return 'other';
}

/**
 * Pick `n` targets from `pool` with type diversity.
 *
 * Strategy: round-robin across the six families.  In each round, take the
 * best-scoring remaining candidate from every family that still has entries.
 * Repeat until `n` slots are filled.  The interleaved order ensures tiles of
 * the same type never cluster together.
 *
 * `pool` must already be sorted by descending `bestTonightScore` so that the
 * first candidate popped per family per round is always the best available.
 */
function diversePick(pool: PlannerTarget[], n: number): PlannerTarget[] {
  const FAMILY_ORDER: ObjectFamily[] = ['nebula', 'galaxy', 'cluster', 'supernova', 'double', 'other'];
  const buckets = new Map<ObjectFamily, PlannerTarget[]>();
  for (const f of FAMILY_ORDER) buckets.set(f, []);
  for (const t of pool) buckets.get(familyOf(t.type))!.push(t);

  const result: PlannerTarget[] = [];
  const taken = new Map<ObjectFamily, number>(FAMILY_ORDER.map(f => [f, 0]));

  while (result.length < n) {
    let pickedAny = false;
    for (const f of FAMILY_ORDER) {
      if (result.length >= n) break;
      const bucket = buckets.get(f)!;
      const idx = taken.get(f)!;
      if (idx < bucket.length) {
        result.push(bucket[idx]);
        taken.set(f, idx + 1);
        pickedAny = true;
      }
    }
    if (!pickedAny) break;
  }
  return result;
}

// ─── Stat cell ────────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  isDark,
}: {
  label: string;
  value: React.ReactNode;
  isDark: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 p-3 rounded-lg ${
      isDark ? 'bg-slate-800/50' : 'bg-slate-100/70'
    }`}>
      <span className={`text-[9.5px] font-semibold uppercase tracking-[0.16em] ${
        isDark ? 'text-slate-500' : 'text-slate-400'
      }`}>
        {label}
      </span>
      <span className={`text-sm font-bold leading-tight ${
        isDark ? 'text-slate-100' : 'text-slate-800'
      }`}>
        {value}
      </span>
    </div>
  );
}

// ─── Single DSO tile ──────────────────────────────────────────────────────

function TargetTile({
  target,
  timeZone,
  isDark,
  isAdmin,
  onToggleWishlist,
  wishlistPending,
}: {
  target: PlannerTarget;
  timeZone?: string;
  isDark: boolean;
  isAdmin: boolean;
  onToggleWishlist: (target: PlannerTarget) => void;
  wishlistPending: boolean;
}) {
  const staticUrl = getCatalogStaticThumbnailUrl(target.id);
  const apiUrl    = getCatalogThumbnailUrl(target.id, target.majorAxisArcmin);

  const displayName = target.commonNames[0] ?? target.ngcName ?? target.name;
  const catalogId   = target.ngcName !== displayName ? target.ngcName : null;

  const altColor =
    target.maxAlt >= 60 ? 'text-emerald-500' :
    target.maxAlt >= 30 ? (isDark ? 'text-slate-200' : 'text-slate-700') :
    'text-amber-500';

  const onWishlist = target.isInWishlist;

  // DSO tiles keep their own border/bg — slightly lighter than the outer card
  // so they read as elevated elements inside it.
  const tileBg = isDark
    ? 'bg-slate-800/60 border-slate-700/60'
    : 'bg-white border-slate-200 shadow-sm';

  return (
    <div className={`flex flex-col rounded-xl overflow-hidden border ${tileBg}`}>
      {/* Photo */}
      <div className="relative aspect-[4/3] bg-slate-950 overflow-hidden">
        <img
          src={staticUrl}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src !== apiUrl) img.src = apiUrl;
          }}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />

        {/* Type badge */}
        <div className="absolute top-2.5 left-2.5">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold backdrop-blur-sm ${typeColor(target.type)}`}>
            {shortType(target.type)}
          </span>
        </div>

        {/* Add to Planner — admin only */}
        {isAdmin && (
          <button
            onClick={() => onToggleWishlist(target)}
            disabled={wishlistPending}
            title={onWishlist ? 'Remove from planner wishlist' : 'Add to planner wishlist'}
            aria-label={onWishlist ? `Remove ${displayName} from planner` : `Add ${displayName} to planner`}
            className={`absolute top-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full backdrop-blur-sm transition-all disabled:opacity-50 ${
              onWishlist
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/30 hover:bg-amber-400'
                : 'bg-slate-950/60 text-white/70 hover:bg-slate-950/80 hover:text-amber-400 ring-1 ring-white/15'
            }`}
          >
            {onWishlist
              ? <BookmarkCheck className="h-3.5 w-3.5" strokeWidth={2.5} />
              : <BookmarkPlus  className="h-3.5 w-3.5" strokeWidth={2.5} />
            }
          </button>
        )}

        {/* Constellation */}
        {target.constellation && (
          <span className="absolute bottom-2.5 right-2.5 text-[10.5px] font-medium text-white/70 tracking-wide">
            {target.constellation}
          </span>
        )}
      </div>

      {/* Caption */}
      <div className="px-3 pt-3 pb-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className={`font-display text-[14px] font-bold leading-tight truncate ${
            isDark ? 'text-slate-100' : 'text-slate-800'
          }`}>
            {displayName}
          </h3>
          {catalogId && (
            <span className={`text-[10.5px] font-mono shrink-0 ${
              isDark ? 'text-slate-500' : 'text-slate-400'
            }`}>
              {catalogId}
            </span>
          )}
        </div>
      </div>

      {/* Stats 2×2 */}
      <div className="px-3 pb-3 pt-2 grid grid-cols-2 gap-1.5">
        <StatCell
          label="Max alt"
          value={<span className={altColor}>{Math.round(target.maxAlt)}°</span>}
          isDark={isDark}
        />
        <StatCell
          label="Window"
          value={
            <span className="tabular-nums text-xs font-semibold">
              {fmtTime(target.risesAt, timeZone)}
              <span className={`mx-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>–</span>
              {fmtTime(target.setsAt, timeZone)}
            </span>
          }
          isDark={isDark}
        />
        <StatCell
          label="Duration"
          value={durationLabel(target.risesAt, target.setsAt)}
          isDark={isDark}
        />
        <StatCell
          label="Magnitude"
          value={
            target.magnitude != null
              ? target.magnitude.toFixed(1)
              : <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>
          }
          isDark={isDark}
        />
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────

export function TonightTargets({ siteId, timeZone, isDark }: Props) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [shuffledIds, setShuffledIds] = useState<string[] | null>(null);
  const [pendingId,   setPendingId  ] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['planner-tonight-home', siteId],
    queryFn: () => getPlannerTargets({ limit: 200, siteId: siteId ?? undefined }),
    staleTime: 600_000,
    enabled: siteId != null,
  });

  const allTargets = useMemo<PlannerTarget[]>(
    () => data
      ? [...data.targets].sort((a, b) => (b.bestTonightScore ?? 0) - (a.bestTonightScore ?? 0))
      : [],
    [data],
  );

  const displayed = useMemo<PlannerTarget[]>(
    () => shuffledIds != null
      ? shuffledIds.flatMap(id => {
          const t = allTargets.find(x => x.id === id);
          return t ? [t] : [];
        })
      : diversePick(allTargets, 10),
    [shuffledIds, allTargets],
  );

  const handleShuffle = useCallback(() => {
    if (allTargets.length <= 10) return;
    const currentSet = new Set(displayed.map(t => t.id));
    // Prefer targets not currently shown, then fall back to full pool.
    const pool = allTargets.filter(t => !currentSet.has(t.id));
    const source = pool.length >= 10 ? pool : allTargets;
    // Shuffle within each family bucket so every click gives a fresh pick,
    // then run diversePick to maintain type variety.
    const shuffledPool = shuffle(source);
    setShuffledIds(diversePick(shuffledPool, 10).map(t => t.id));
  }, [allTargets, displayed]);

  const addMut = useMutation({
    mutationFn: (target: PlannerTarget) =>
      addToWishlist({
        objectId: target.id,
        name: target.commonNames[0] ?? target.ngcName ?? target.name,
        type: target.type,
        constellation: target.constellation,
        magnitude: target.magnitude,
        majorAxisArcmin: target.majorAxisArcmin,
      }),
    onSettled: () => {
      setPendingId(null);
      queryClient.invalidateQueries({ queryKey: ['planner-tonight-home', siteId] });
      queryClient.invalidateQueries({ queryKey: ['planner-tonight'] });
    },
  });

  const removeMut = useMutation({
    mutationFn: (objectId: string) => removeFromWishlist(objectId),
    onSettled: () => {
      setPendingId(null);
      queryClient.invalidateQueries({ queryKey: ['planner-tonight-home', siteId] });
      queryClient.invalidateQueries({ queryKey: ['planner-tonight'] });
    },
  });

  const handleToggleWishlist = useCallback((target: PlannerTarget) => {
    if (pendingId != null) return;
    setPendingId(target.id);
    if (target.isInWishlist) removeMut.mutate(target.id);
    else addMut.mutate(target);
  }, [pendingId, addMut, removeMut]);

  // ── Shared design tokens (aligned with NightOverview / WeatherNight) ──
  const outerBg   = isDark ? 'bg-[#0e1117] border-slate-700/50' : 'bg-slate-50 border-slate-200 shadow-sm';
  const headerBdr = isDark ? 'border-slate-700/60' : 'border-slate-200';
  const footerBdr = isDark ? 'border-slate-700/60 text-slate-600' : 'border-slate-200 text-slate-400';
  const canShuffle = allTargets.length > 10;

  return (
    <section
      aria-label="Tonight's easy targets"
      className={`rounded-2xl border overflow-hidden ${outerBg}`}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className={`px-5 pt-5 pb-4 border-b ${headerBdr} flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          {/* Amber circle badge — matches NightOverview and WeatherNight */}
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isDark ? 'bg-amber-500/15' : 'bg-amber-50'
          }`}>
            <Telescope className={`h-4 w-4 ${isDark ? 'text-amber-400' : 'text-amber-500'}`} />
          </div>
          <div>
            <h2 className={`font-display text-lg font-bold leading-tight ${
              isDark ? 'text-slate-100' : 'text-slate-800'
            }`}>
              Tonight's Easy Targets
            </h2>
            <p className={`text-[12px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {shuffledIds ? 'Shuffled mix' : 'Best per type'} · nebulae, clusters, galaxies &amp; more
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {data && (
            <span className={`text-[11px] tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              {data.totalVisible} visible tonight
            </span>
          )}
          {canShuffle && (
            <button
              onClick={handleShuffle}
              title="Show a different random selection from tonight's catalog"
              aria-label="Shuffle targets"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                isDark
                  ? 'bg-slate-800/80 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                  : 'bg-slate-200/70 text-slate-500 hover:bg-slate-200 hover:text-slate-700'
              }`}
            >
              <Shuffle className="h-3.5 w-3.5" />
              Shuffle
            </button>
          )}
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="px-5 py-5">

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <RotateCw className={`h-5 w-5 animate-spin ${isDark ? 'text-slate-600' : 'text-slate-400'}`} />
          </div>
        )}

        {/* Error */}
        {error && !isLoading && (
          <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load tonight's targets.
          </div>
        )}

        {/* No location */}
        {!siteId && !isLoading && (
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            Set an observing site in Settings to see tonight's targets.
          </p>
        )}

        {/* Tile grid */}
        {displayed.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {displayed.map(target => (
              <TargetTile
                key={target.id}
                target={target}
                timeZone={timeZone}
                isDark={isDark}
                isAdmin={isAdmin}
                onToggleWishlist={handleToggleWishlist}
                wishlistPending={pendingId === target.id}
              />
            ))}
          </div>
        )}

        {/* Empty */}
        {siteId && !isLoading && !error && displayed.length === 0 && data && (
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            No targets visible above the horizon tonight.
          </p>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div className={`px-5 py-3 text-[11px] border-t ${footerBdr}`}>
        Best {displayed.length} of {data?.totalVisible ?? '…'} objects visible tonight · satellite imagery via DSS2
      </div>
    </section>
  );
}
