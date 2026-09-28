import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Sparkles,
  Library,
  CalendarRange,
  CloudMoon,
  Compass,
  BookOpen,
  ScrollText,
  Telescope,
  RefreshCw,
  DatabaseBackup,
  Maximize2,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** First-login flow only: persists the dismissal. Omitted for the "see it
   *  again from Settings" entry point, which then shows a plain "Done" footer. */
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  /** Hands off to the full ChangelogModal. Omit to hide the link. */
  onViewAll?: () => void;
}

interface Feature {
  icon: React.ElementType;
  /** Key group under help.json's whatsNewV20 namespace (title/lead/description). */
  key: string;
  /** Filename under /whatsnew/v2-0/ in `public/`. Missing files fall back
   *  to an icon tile, so screenshots can be dropped in after the fact. */
  screenshot: string;
}

const FEATURES: Feature[] = [
  { icon: CalendarRange, key: 'planner', screenshot: 'planner.webp' },
  { icon: CloudMoon, key: 'forecast', screenshot: 'forecast.webp' },
  { icon: Library, key: 'catalogs', screenshot: 'catalogs.webp' },
  { icon: Telescope, key: 'observations', screenshot: 'observations.webp' },
  { icon: Compass, key: 'guidedTour', screenshot: 'guided-tour.webp' },
  { icon: BookOpen, key: 'helpPage', screenshot: 'help-page.webp' },
  { icon: ScrollText, key: 'systemLog', screenshot: 'system-log.webp' },
  { icon: RefreshCw, key: 'backupStatus', screenshot: 'backup-status.webp' },
  { icon: DatabaseBackup, key: 'databaseBackup', screenshot: 'database-backup.webp' },
];

function FeatureCard({ feature, isDark, onExpand, t }: { feature: Feature; isDark: boolean; onExpand: () => void; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const Icon = feature.icon;
  const cardBg = isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200';
  const shotBg = isDark ? 'bg-slate-900' : 'bg-slate-100';
  const title = t(`whatsNewV20.${feature.key}.title`);

  return (
    <div className={`rounded-xl border overflow-hidden ${cardBg}`}>
      <div className={`relative aspect-video flex items-center justify-center ${shotBg}`}>
        {!imgFailed ? (
          <button
            type="button"
            onClick={onExpand}
            className="group relative w-full h-full cursor-zoom-in"
            aria-label={t('whatsNewV20.viewFullSize', { title })}
          >
            <img
              src={`/whatsnew/v2-0/${feature.screenshot}`}
              alt={title}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
              <Maximize2 className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </span>
          </button>
        ) : (
          <Icon className={`w-8 h-8 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />
        )}
      </div>
      <div className="p-3.5">
        <div className="flex items-center gap-2 mb-1.5">
          <Icon className={`w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{title}</h3>
        </div>
        <p className={`text-xs leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          <strong className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{t(`whatsNewV20.${feature.key}.lead`)}</strong>{' '}
          {t(`whatsNewV20.${feature.key}.description`)}
        </p>
      </div>
    </div>
  );
}

/** Full-screen view of a single feature screenshot. Nests inside the main
 *  modal's Modal (supported: see Modal.tsx's nested-dialog handling), so
 *  Escape/Tab trapping and backdrop click work the same as any other dialog. */
function Lightbox({ feature, onClose, t }: { feature: Feature; onClose: () => void; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const title = t(`whatsNewV20.${feature.key}.title`);
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${title} ${t('whatsNewV20.screenshotSuffix')}`}
      backdropClassName="bg-black/90"
      className="w-full h-full max-w-[95vw] max-h-[95vh] flex items-center justify-center"
      focusOnOpen="dialog"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label={t('whatsNewV20.close')}
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={`/whatsnew/v2-0/${feature.screenshot}`}
        alt={title}
        onClick={onClose}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-zoom-out"
      />
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-sm font-medium text-white/90 bg-black/50 px-3 py-1.5 rounded-full whitespace-nowrap">
        {title}
      </p>
    </Modal>
  );
}

/**
 * Enhanced first-login popup for the 2.0 release. Larger than the standard
 * ChangelogModal, with a screenshot card per headline feature. See
 * ENHANCED_SERIES in WhatsNewAutoPopup for how a release series gets one of
 * these instead of the plain changelog.
 */
export function WhatsNewV20Modal({ isOpen, onClose, onAcknowledge, acknowledging, onViewAll }: Props) {
  const { t } = useTranslation('help');
  const { isDark } = useTheme();
  const [lightboxFeature, setLightboxFeature] = useState<Feature | null>(null);

  const bg = isDark ? 'bg-slate-900' : 'bg-white';
  const border = isDark ? 'border-slate-800' : 'border-slate-200';
  const heading = isDark ? 'text-slate-100' : 'text-slate-900';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const divider = isDark ? 'border-slate-800' : 'border-slate-100';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('whatsNewV20.title')}
      className="w-full max-w-6xl max-h-[85vh] flex flex-col"
    >
      <div className={`flex flex-col rounded-2xl border shadow-xl overflow-hidden ${bg} ${border}`}>
        {/* Header */}
        <div
          className={`relative px-6 py-5 border-b ${divider} ${
            isDark
              ? 'bg-gradient-to-br from-accent-500/15 via-slate-900 to-slate-900'
              : 'bg-gradient-to-br from-accent-50 via-white to-white'
          }`}
        >
          <button
            onClick={onClose}
            className={`absolute top-4 right-4 p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            aria-label={t('whatsNewV20.close')}
          >
            <X className="w-4 h-4" />
          </button>
          <div className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full mb-2 ${isDark ? 'bg-accent-500/15 text-accent-300' : 'bg-accent-100 text-accent-700'}`}>
            <Sparkles className="w-3 h-3" />
            {t('whatsNewV20.badge')}
          </div>
          <h2 className={`text-xl font-bold pr-8 ${heading}`}>{t('whatsNewV20.title')}</h2>
          <p className={`text-sm mt-1 ${muted}`}>
            {t('whatsNewV20.subtitle')}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {FEATURES.map(f => (
              <FeatureCard key={f.key} feature={f} isDark={isDark} onExpand={() => setLightboxFeature(f)} t={t} />
            ))}
          </div>

        </div>

        {/* Footer */}
        <div className={`flex items-center justify-between gap-2 px-6 py-3 border-t ${divider}`}>
          {onViewAll ? (
            <button
              onClick={onViewAll}
              className={`text-xs font-medium transition ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
            >
              {t('whatsNewV20.viewFullReleaseNotes')}
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {onAcknowledge ? (
              <>
                <button
                  onClick={onClose}
                  disabled={acknowledging}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50 ${isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}
                >
                  {t('whatsNewV20.remindLater')}
                </button>
                <button
                  onClick={onAcknowledge}
                  disabled={acknowledging}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition disabled:opacity-50"
                >
                  {acknowledging ? t('whatsNewV20.saving') : t('whatsNewV20.gotIt')}
                </button>
              </>
            ) : (
              <button
                onClick={onClose}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-500 text-white hover:bg-accent-600 transition"
              >
                {t('whatsNewV20.done')}
              </button>
            )}
          </div>
        </div>
      </div>
      {lightboxFeature && (
        <Lightbox feature={lightboxFeature} onClose={() => setLightboxFeature(null)} t={t} />
      )}
    </Modal>
  );
}
