/**
 * Banner for the Calibration Library.
 *
 * The page used to open on a centered title and a separate stat-tile grid
 * below it, the one layout on this nav item that didn't match the hero every
 * other main page opens with (Library, Gallery, Observations, Forecast,
 * Planner, Catalogs, Backup). This folds the same figures into that shape:
 * frame count, archive size, and how many frame types are actually present.
 *
 * Dark in every theme, matching those banners, which is also why it takes the
 * bright `accent` hex directly rather than `accent-*` utilities and styles
 * its own text white.
 */
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Aperture } from 'lucide-react';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatBytes } from '../../lib/utils';
import { formatNumber } from '../../lib/formatLocale';

interface Props {
  accent: string;
  /** Nothing archived yet, so the stat row (all zeros) would say nothing the
   *  empty-state panel below the hero doesn't already say better. */
  empty: boolean;
  totalFiles: number;
  totalBytes: number;
  frameTypeCount: number;
  /** Optional control pinned to the right of the banner, e.g. the scope picker. */
  filter?: ReactNode;
}

export function CalibrationHero({ accent, empty, totalFiles, totalBytes, frameTypeCount, filter }: Props) {
  const { t } = useTranslation('library');

  const stats: { value: string; label: string }[] = [
    { value: formatNumber(totalFiles), label: t('calibrations.stats.frames') },
    { value: formatBytes(totalBytes), label: t('calibrations.stats.totalSize') },
    { value: formatNumber(frameTypeCount), label: t('calibrations.stats.frameTypes') },
  ];

  return (
    <section className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel">
      <HeroBackdrop image={PAGE_HERO.calibrations} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: `radial-gradient(70% 130% at 95% 100%, ${accent}14 0%, transparent 62%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex hero-min-h flex-col justify-center gap-6 p-4 sm:p-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="min-w-0 lg:max-w-[58%]">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <Aperture className="h-6 w-6 sm:h-7 sm:w-7" style={{ color: accent }} />
            {t('calibrations.pageTitle')}
          </h1>

          <p className="mt-2 text-[13px] text-white/55">
            {t('calibrations.pageSubtitle')}
          </p>

          {!empty && (
            <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
              {stats.map(({ value, label }) => (
                <div key={label} className="min-w-0">
                  <div className="font-display text-2xl font-bold leading-none tracking-tight tabular-nums text-white">
                    {value}
                  </div>
                  <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {filter && <div className="shrink-0">{filter}</div>}
      </div>
    </section>
  );
}
