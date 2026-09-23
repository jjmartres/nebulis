/**
 * Banner for the Wishlist page, matching the Catalogs hub's shape: a dark
 * panel over real deep-sky artwork with the page's headline numbers beside
 * the title rather than repeated in a panel below.
 */
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HeroBackdrop } from '../ui/HeroBackdrop';
import { PAGE_HERO } from '../../lib/heroImagery';
import { formatNumber } from '../../lib/formatLocale';

interface Props {
  total: number;
  visibleTonight: number;
  highPriority: number;
  accent: string;
}

export function WishlistHero({ total, visibleTonight, highPriority, accent }: Props) {
  const { t } = useTranslation('planner');
  const stats: { value: string; label: string }[] = [
    { value: formatNumber(total), label: t('wishlistHero.targets') },
    { value: formatNumber(visibleTonight), label: t('wishlistHero.visibleTonight') },
    { value: formatNumber(highPriority), label: t('wishlistHero.highPriority') },
  ];

  return (
    <section className="relative overflow-hidden rounded-3xl bg-slate-950 hero-panel">
      <HeroBackdrop image={PAGE_HERO.wishlist} />

      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: `radial-gradient(90% 140% at 8% 0%, ${accent}1f 0%, transparent 60%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)' }}
      />

      <div className="relative flex hero-min-h flex-col justify-center gap-6 p-4 sm:p-6">
        <div className="min-w-0">
          <h1 className="font-display flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            <Star className="h-6 w-6 sm:h-7 sm:w-7 fill-current" style={{ color: accent }} />
            {t('wishlistHero.title')}
          </h1>
          {/* Uncapped on purpose, matching every other banner in this group
              (Library, Catalogs, Settings, Backup, Calibrations, Image
              gallery). A `max-w-xl` cap used to sit here, and this copy needs
              634px at 13px, so the cap wrapped it onto a second line and left
              this banner 19px taller than every sibling page's. */}
          <p className="mt-2 text-[13px] text-white/55">
            {t('wishlistHero.subtitle')}
          </p>

          <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-4 sm:gap-x-16">
            {stats.map(({ value, label }) => (
              <div key={label} className="min-w-0">
                <div className="font-display text-2xl font-bold leading-none tracking-tight text-white tabular-nums">
                  {value}
                </div>
                <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
