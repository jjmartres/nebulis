import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubFrameQualityRow } from '../../lib/api/library';
import { GradeBadge } from './GradeBadge';

/**
 * Quality of the sub on screen, under the picture in the sub-frame viewer:
 * the same columns as the quality table, plus Keep. Blinking through a night
 * and deciding sub by sub is the reason the viewer exists, so the decision is
 * made here too (K toggles it, see GalleryModal).
 *
 * The viewer is night-side in every theme, so this is styled dark only.
 */
export function SubframeQualityBar({
  row,
  isAdmin,
  onReview,
}: {
  row: SubFrameQualityRow | undefined;
  isAdmin: boolean;
  onReview: (row: SubFrameQualityRow, rejected: boolean | null) => Promise<void>;
}) {
  const { t } = useTranslation('observations');
  const [error, setError] = useState<string | null>(null);

  const shell = 'flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-3 py-2 text-[12px] text-white/70';

  if (!row || (!row.measured && !row.error)) {
    return (
      <div className={shell} role="group" aria-label={t('subframeQuality.title')}>
        <span className="text-white/45">{t('subframeQuality.viewerNotMeasured')}</span>
      </div>
    );
  }

  const review = async (rejected: boolean | null) => {
    setError(null);
    try {
      await onReview(row, rejected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('subframeQuality.failed'));
    }
  };

  const metric = (label: string, value: string | number | null, unit = '') => (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-white/40">{label}</dt>
      <dd className="font-medium tabular-nums text-white/90">{value ?? '–'}{value !== null && unit}</dd>
    </div>
  );

  return (
    <div className={shell} role="group" aria-label={t('subframeQuality.title')}>
      <div className="flex items-center gap-2">
        {row.error
          ? <span className="text-white/45">{t('subframeQuality.unreadable')}</span>
          : <GradeBadge grade={row.grade} isDark />}
        {row.flags.length > 0 && (
          <span className="text-[11px] text-amber-300/80">
            {row.flags.map(fl => t(`subframeQuality.flag.${fl}`)).join(', ')}
          </span>
        )}
      </div>

      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {metric(t('subframeQuality.col.filter'), row.filter)}
        {metric(t('subframeQuality.col.hfr'), row.hfr, ' px')}
        {metric(t('subframeQuality.col.fwhm'), row.fwhm, ' px')}
        {metric(t('subframeQuality.col.stars'), row.stars)}
        {metric(t('subframeQuality.col.ecc'), row.eccentricity)}
        {metric(t('subframeQuality.col.background'), row.background)}
      </dl>

      <div className="flex items-center gap-2">
        <label
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset ${
            row.accepted ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30' : 'bg-red-500/15 text-red-200 ring-red-400/30'
          } ${isAdmin ? 'cursor-pointer' : ''}`}
          title={isAdmin ? t('subframeQuality.keepShortcut') : undefined}
        >
          <input
            type="checkbox"
            checked={row.accepted}
            disabled={!isAdmin}
            onChange={e => void review(!e.target.checked)}
            className="accent-emerald-500"
            aria-label={t('subframeQuality.keepFile', { name: row.fileName })}
          />
          {t('subframeQuality.col.keep')}
          {isAdmin && (
            <kbd className="hidden rounded bg-white/10 px-1 font-sans text-[10px] text-white/60 sm:inline">K</kbd>
          )}
        </label>
        {row.manual
          ? isAdmin && (
            <button
              type="button"
              onClick={() => void review(null)}
              className="text-[11px] text-white/50 underline hover:text-white/80"
              title={t('subframeQuality.resetTitle')}
            >
              {t('subframeQuality.reset')}
            </button>
          )
          : <span className="text-[11px] text-white/35">{t('subframeQuality.autoDecision')}</span>}
      </div>

      {error && <span className="w-full text-center text-[11px] text-red-300">{error}</span>}
    </div>
  );
}
