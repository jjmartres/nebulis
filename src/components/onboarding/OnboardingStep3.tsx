import { Clock, AlertTriangle, Image, FileText, Film, Download } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { OnboardingStorageChoice } from './OnboardingStorageChoice';

const INTERVAL_OPTIONS = [
  { value: 0, labelKey: 'step3.interval.manual' },
  { value: 5, labelKey: 'step3.interval.every5' },
  { value: 15, labelKey: 'step3.interval.every15' },
  { value: 60, labelKey: 'step3.interval.everyHour' },
  { value: 360, labelKey: 'step3.interval.every6Hours' },
] as const;

export { INTERVAL_OPTIONS };

interface OnboardingStep3Props {
  autoImportInterval: number;
  importJpg: boolean;
  importFits: boolean;
  importSubFrames: boolean;
  prefetchCatalogAssets: boolean;
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  helperClass: string;
  subText: string;
  onAutoImportIntervalChange: (value: number) => void;
  onImportJpgChange: (value: boolean) => void;
  onImportFitsChange: (value: boolean) => void;
  onImportSubFramesChange: (value: boolean) => void;
  onPrefetchCatalogAssetsChange: (value: boolean) => void;
}

export function OnboardingStep3({
  autoImportInterval,
  importJpg,
  importFits,
  importSubFrames,
  prefetchCatalogAssets,
  isDark,
  inputClass,
  labelClass,
  helperClass: _helperClass,
  subText,
  onAutoImportIntervalChange,
  onImportJpgChange,
  onImportFitsChange,
  onImportSubFramesChange,
  onPrefetchCatalogAssetsChange,
}: OnboardingStep3Props) {
  const { t } = useTranslation('onboarding');
  return (
    <>
      <OnboardingStorageChoice isDark={isDark} subText={subText} />

      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-xl ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
          <Clock className="w-5 h-5 text-accent-500" />
        </div>
        <div>
          <h3 className={`font-display font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            {t('step3.heading')}
          </h3>
          <p className={`text-xs ${subText}`}>{t('step3.subheading')}</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>{t('step3.importFrequencyLabel')}</label>
        <select
          value={autoImportInterval}
          onChange={e => onAutoImportIntervalChange(Number(e.target.value))}
          className={inputClass}
        >
          {INTERVAL_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
          ))}
        </select>
      </div>

      {/* Offline catalog data, downloaded after setup completes */}
      <label
        className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border transition ${
          prefetchCatalogAssets
            ? isDark
              ? 'bg-accent-500/5 border-accent-500/30'
              : 'bg-accent-50/50 border-accent-200'
            : isDark
              ? 'border-slate-800 hover:border-slate-700'
              : 'border-slate-200 hover:border-slate-300'
        }`}
      >
        <input
          type="checkbox"
          checked={prefetchCatalogAssets}
          onChange={e => onPrefetchCatalogAssetsChange(e.target.checked)}
          className="w-4 h-4 rounded accent-accent-500 mt-0.5"
        />
        <Download className={`w-4 h-4 mt-0.5 ${isDark ? 'text-accent-400' : 'text-accent-500'}`} />
        <div className="flex-1">
          <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            {t('step3.downloadCatalogLabel')}
          </span>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('step3.downloadCatalogDescription')}
          </p>
        </div>
      </label>

      <div>
        <label className={labelClass}>{t('step3.backupOptionsLabel')}</label>
        <div className="space-y-0.5">
          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importJpg}
              onChange={e => onImportJpgChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <Image className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('step3.stackedImagesLabel')}</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('step3.stackedImagesDescription')}</p>
            </div>
          </label>

          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importFits}
              onChange={e => onImportFitsChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <FileText className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div>
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('step3.fitsFilesLabel')}</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('step3.fitsFilesDescription')}</p>
            </div>
          </label>

          <label className={`flex items-center gap-3 py-2 px-2 rounded-lg cursor-pointer transition ${
            isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-50'
          }`}>
            <input
              type="checkbox"
              checked={importSubFrames}
              onChange={e => onImportSubFramesChange(e.target.checked)}
              className="w-4 h-4 rounded accent-accent-500"
            />
            <Film className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            <div className="flex-1">
              <span className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{t('step3.subframesLabel')}</span>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t('step3.subframesDescription')}</p>
            </div>
          </label>

          {importSubFrames && (
            <div className={`flex items-start gap-2 ml-10 p-3 rounded-lg text-xs ${
              isDark ? 'bg-amber-500/5 text-amber-400/80 border border-amber-500/10' : 'bg-amber-50 text-amber-700 border border-amber-100'
            }`}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                <Trans i18nKey="step3.subframesWarning" ns="onboarding" components={{ 1: <strong /> }} />
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
