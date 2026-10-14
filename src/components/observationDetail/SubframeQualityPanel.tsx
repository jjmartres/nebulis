import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, AlertTriangle, XCircle, Download, Loader2, Play, RotateCcw, Square } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import {
  getSubFrameQuality,
  analyzeSubFrameQuality,
  cancelSubFrameQuality,
  setSubFrameReview,
  downloadSubFrameQualityCsv,
  type SubFrameQualityRow,
  type SubFrameGradeLevel,
} from '../../lib/api/library';

/**
 * Sub-frame quality for one observation: HFR, FWHM, star count, eccentricity
 * and background measured from the pixels (server/lib/subQuality.ts), graded
 * against the rest of the night, with a manual accept/reject per sub and a
 * CSV export a processing script can filter on.
 *
 * Two small single-series charts (HFR, stars) rather than one dual-axis chart:
 * the measures have unrelated scales. Points are coloured by grade, which is
 * also spelled out (icon + label) in the table, so colour is never the only
 * signal.
 */

const TABLE_PAGE = 100;

const GRADE_DOT: Record<SubFrameGradeLevel, string> = {
  good: 'fill-emerald-500',
  fair: 'fill-amber-500',
  poor: 'fill-red-500',
};

function GradeBadge({ grade, isDark }: { grade: SubFrameGradeLevel | null; isDark: boolean }) {
  const { t } = useTranslation('observations');
  if (!grade) return <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>;
  const cls = grade === 'good'
    ? isDark ? 'text-emerald-400' : 'text-emerald-700'
    : grade === 'fair'
      ? isDark ? 'text-amber-400' : 'text-amber-700'
      : isDark ? 'text-red-400' : 'text-red-700';
  const Icon = grade === 'good' ? Check : grade === 'fair' ? AlertTriangle : XCircle;
  return (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(`subframeQuality.grade.${grade}`)}
    </span>
  );
}

/** One series over the night, one point per measured sub, with hover. */
function MetricStrip({
  label,
  unit,
  rows,
  value,
  isDark,
}: {
  label: string;
  unit: string;
  rows: SubFrameQualityRow[];
  value: (r: SubFrameQualityRow) => number | null;
  isDark: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = rows.map((r, i) => ({ i, r, v: value(r) })).filter((p): p is { i: number; r: SubFrameQualityRow; v: number } => p.v !== null);
  if (pts.length < 2) return null;

  const W = 600;
  const H = 72;
  const PAD = 6;
  const vs = pts.map(p => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / Math.max(1, rows.length - 1)) * (W - 2 * PAD);
  // A flat series sits mid-height rather than on the floor.
  const y = (v: number) => (hi === lo ? H / 2 : H - PAD - ((v - lo) / span) * (H - 2 * PAD));
  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const hovered = hover !== null ? pts[hover] : null;
  const ink = isDark ? 'text-slate-400' : 'text-slate-500';

  return (
    <figure className="min-w-0">
      <figcaption className={`mb-1 flex items-baseline justify-between text-[11px] ${ink}`}>
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">
          {hovered
            ? `${hovered.r.fileName} · ${hovered.v}${unit}`
            : lo === hi ? `${lo}${unit}` : `${lo}${unit} – ${hi}${unit}`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[72px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${lo}${unit} – ${hi}${unit}`}
        onMouseLeave={() => setHover(null)}
      >
        <path d={line} fill="none" className={isDark ? 'stroke-slate-500' : 'stroke-slate-400'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {pts.map((p, k) => (
          <g key={p.r.relPath}>
            <circle
              cx={x(p.i)}
              cy={y(p.v)}
              r={hover === k ? 4 : 2.5}
              className={`${p.r.grade ? GRADE_DOT[p.r.grade] : 'fill-slate-400'} ${p.r.accepted ? '' : 'opacity-50'}`}
              vectorEffect="non-scaling-stroke"
            />
            {/* Hit target wider than the mark. */}
            <rect
              x={x(p.i) - Math.max(3, (W - 2 * PAD) / rows.length / 2)}
              y={0}
              width={Math.max(6, (W - 2 * PAD) / rows.length)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(k)}
            />
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function SubframeQualityPanel({
  objectId,
  date,
  isAdmin,
}: {
  objectId: string;
  date: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation('observations');
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const queryKey = ['subframe-quality', objectId, date];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => getSubFrameQuality(objectId, date),
    enabled: !!objectId && !!date,
    refetchInterval: q => (q.state.data?.job?.running ? 1500 : false),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [onlyRejected, setOnlyRejected] = useState(false);

  const frames = useMemo(() => data?.frames ?? [], [data]);
  // File names of one night share a long prefix (Light_<target>_<exp>_…), so
  // phones show only what differs.
  const commonPrefix = useMemo(() => {
    if (frames.length < 2) return '';
    let prefix = frames[0].fileName;
    for (const f of frames) {
      let i = 0;
      while (i < prefix.length && i < f.fileName.length && prefix[i] === f.fileName[i]) i++;
      prefix = prefix.slice(0, i);
    }
    // Cut at a separator so the visible part starts on a whole token.
    return prefix.slice(0, Math.max(prefix.lastIndexOf('_'), prefix.lastIndexOf('-')) + 1);
  }, [frames]);
  const visible = useMemo(() => {
    const list = onlyRejected ? frames.filter(f => !f.accepted) : frames;
    return showAll ? list : list.slice(0, TABLE_PAGE);
  }, [frames, onlyRejected, showAll]);

  if (isLoading || !data || data.total === 0) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('subframeQuality.failed'));
    } finally {
      setBusy(false);
    }
  };

  const job = data.job?.running ? data.job : null;
  const unmeasured = data.total - data.measured;
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const btn = `inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
    isDark ? 'bg-slate-800 text-slate-200 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
  }`;
  const cell = 'px-2 py-1.5 tabular-nums';

  return (
    <section className={`mb-5 rounded-2xl border p-4 ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white shadow-sm'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Activity className={`h-4 w-4 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} aria-hidden="true" />
        <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{t('subframeQuality.title')}</h3>
        <span className={`text-xs ${muted}`}>
          {data.measured === 0
            ? t('subframeQuality.notMeasured', { count: data.total })
            : data.measured < data.total
              ? t('subframeQuality.summaryPartial', {
                measured: data.measured,
                total: data.total,
                kept: frames.filter(f => f.measured && f.accepted).length,
              })
              : t('subframeQuality.summary', { accepted: data.accepted, total: data.total })}
        </span>
        <span className="flex-1" />
        {isAdmin && !job && unmeasured > 0 && (
          <button type="button" className={btn} disabled={busy} onClick={() => void run(() => analyzeSubFrameQuality(objectId, date))}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {t('subframeQuality.analyze', { count: unmeasured })}
          </button>
        )}
        {isAdmin && !job && unmeasured === 0 && (
          <button type="button" className={btn} disabled={busy} onClick={() => void run(() => analyzeSubFrameQuality(objectId, date, true))}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('subframeQuality.reanalyze')}
          </button>
        )}
        {data.measured > 0 && (
          <button type="button" className={btn} disabled={busy} onClick={() => void run(() => downloadSubFrameQualityCsv(objectId, date))}>
            <Download className="h-3.5 w-3.5" />
            {t('subframeQuality.csv')}
          </button>
        )}
      </div>

      {job && (
        <div className="mt-3 flex items-center gap-3">
          <div
            className={`h-1.5 flex-1 overflow-hidden rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={job.total}
            aria-valuenow={job.done}
            aria-label={t('subframeQuality.measuring', { done: job.done, total: job.total })}
          >
            <div className="h-full rounded-full bg-accent-500 transition-all" style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
          </div>
          <span className={`text-xs tabular-nums ${muted}`}>{t('subframeQuality.measuring', { done: job.done, total: job.total })}</span>
          {isAdmin && (
            <button type="button" className={btn} disabled={busy} onClick={() => void run(() => cancelSubFrameQuality(objectId, date))}>
              <Square className="h-3 w-3" />
              {t('subframeQuality.cancel')}
            </button>
          )}
        </div>
      )}

      {error && <p className={`mt-2 text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>}

      {data.measured === 0 && !job && (
        <p className={`mt-2 text-xs ${muted}`}>{isAdmin ? t('subframeQuality.hintAdmin') : t('subframeQuality.hint')}</p>
      )}

      {data.measured > 0 && (
        <>
          {data.groups.length > 0 && (
            <p className={`mt-2 text-xs ${muted}`}>
              {data.groups.map(g => t('subframeQuality.group', {
                filter: g.filter ?? t('subframeQuality.noFilter'),
                count: g.count,
                hfr: g.hfr ?? '–',
                stars: g.stars ?? '–',
              })).join(' · ')}
            </p>
          )}

          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <MetricStrip label={t('subframeQuality.col.hfr')} unit=" px" rows={frames} value={r => r.hfr} isDark={isDark} />
            <MetricStrip label={t('subframeQuality.col.stars')} unit="" rows={frames} value={r => r.stars} isDark={isDark} />
          </div>
          <p className={`mt-1 flex flex-wrap gap-3 text-[11px] ${muted}`}>
            {(['good', 'fair', 'poor'] as const).map(g => (
              <span key={g} className="inline-flex items-center gap-1">
                <svg className="h-2 w-2" aria-hidden="true"><circle cx="4" cy="4" r="4" className={GRADE_DOT[g]} /></svg>
                {t(`subframeQuality.grade.${g}`)}
              </span>
            ))}
            <span>{t('subframeQuality.legendRejected')}</span>
          </p>

          <div className="mt-3 flex items-center gap-3 text-xs">
            <label className={`inline-flex cursor-pointer items-center gap-1.5 ${muted}`}>
              <input type="checkbox" checked={onlyRejected} onChange={e => setOnlyRejected(e.target.checked)} className="accent-amber-500" />
              {t('subframeQuality.onlyRejected', { count: data.total - data.accepted })}
            </label>
          </div>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs sm:min-w-[640px]">
              <thead className={muted}>
                <tr>
                  <th className={cell}>{t('subframeQuality.col.file')}</th>
                  <th className={`${cell} hidden sm:table-cell`}>{t('subframeQuality.col.filter')}</th>
                  <th className={`${cell} text-right`}>{t('subframeQuality.col.hfr')}</th>
                  <th className={`${cell} hidden text-right sm:table-cell`}>{t('subframeQuality.col.fwhm')}</th>
                  <th className={`${cell} text-right`}>{t('subframeQuality.col.stars')}</th>
                  <th className={`${cell} hidden text-right sm:table-cell`}>{t('subframeQuality.col.ecc')}</th>
                  <th className={`${cell} hidden text-right sm:table-cell`}>{t('subframeQuality.col.background')}</th>
                  <th className={cell}>{t('subframeQuality.col.grade')}</th>
                  <th className={cell}>{t('subframeQuality.col.keep')}</th>
                </tr>
              </thead>
              <tbody className={isDark ? 'divide-y divide-slate-800 text-slate-200' : 'divide-y divide-slate-100 text-slate-800'}>
                {visible.map(f => (
                  <tr key={f.relPath} className={f.accepted ? '' : 'opacity-60'}>
                    <td className={`${cell} max-w-[110px] truncate sm:max-w-[220px]`} title={f.error ?? f.fileName}>
                      <span className="hidden sm:inline">{f.fileName}</span>
                      <span className="sm:hidden">{commonPrefix.length > 8 ? `…${f.fileName.slice(commonPrefix.length)}` : f.fileName}</span>
                    </td>
                    <td className={`${cell} hidden sm:table-cell`}>{f.filter ?? '–'}</td>
                    <td className={`${cell} text-right`}>{f.hfr ?? '–'}</td>
                    <td className={`${cell} hidden text-right sm:table-cell`}>{f.fwhm ?? '–'}</td>
                    <td className={`${cell} text-right`}>{f.stars ?? '–'}</td>
                    <td className={`${cell} hidden text-right sm:table-cell`}>{f.eccentricity ?? '–'}</td>
                    <td className={`${cell} hidden text-right sm:table-cell`}>{f.background ?? '–'}</td>
                    <td className={cell} title={f.flags.map(fl => t(`subframeQuality.flag.${fl}`)).join(', ') || undefined}>
                      {f.error ? <span className={muted}>{t('subframeQuality.unreadable')}</span> : <GradeBadge grade={f.grade} isDark={isDark} />}
                    </td>
                    <td className={cell}>
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={f.accepted}
                          disabled={!isAdmin || busy}
                          onChange={e => void run(() => setSubFrameReview(f.relPath, !e.target.checked))}
                          className="accent-amber-500"
                          aria-label={t('subframeQuality.keepFile', { name: f.fileName })}
                        />
                        {f.manual && (
                          <button
                            type="button"
                            disabled={!isAdmin || busy}
                            onClick={() => void run(() => setSubFrameReview(f.relPath, null))}
                            className={`text-[10px] underline ${muted}`}
                            title={t('subframeQuality.resetTitle')}
                          >
                            {t('subframeQuality.reset')}
                          </button>
                        )}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!showAll && (onlyRejected ? frames.filter(f => !f.accepted).length : frames.length) > TABLE_PAGE && (
            <button type="button" className={`mt-2 text-xs underline ${muted}`} onClick={() => setShowAll(true)}>
              {t('subframeQuality.showAll', { count: onlyRejected ? frames.filter(f => !f.accepted).length : frames.length })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
