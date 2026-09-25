import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getImportTempUsage, cleanupImportTemp } from '../../lib/api/library';
import { formatBytes } from '../../lib/utils';
import { Sec } from './SettingsUI';

/**
 * Shows what the folder-import wizard is holding in its upload staging area
 * and lets the user reclaim it.
 *
 * Uploading a folder writes a full second copy of it to the server's data
 * drive before anything is imported. That copy is removed as the import runs
 * and swept if a wizard session is abandoned, but a failed or cancelled upload
 * can still leave a lot of disk in use until the sweep catches it. This is the
 * button for getting that space back now.
 */
export function TemporaryFilesSection({ isDark }: { isDark: boolean }) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ deleted: number; bytes: number; skippedActive: number } | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ['import-temp-usage'],
    queryFn: getImportTempUsage,
    staleTime: 30_000,
  });

  const bytes = data?.bytes ?? 0;
  const sessions = data?.sessions ?? 0;

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await cleanupImportTemp();
      setResult(res);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('temporaryFiles.cleanupFailed'));
    } finally {
      setBusy(false);
    }
  };

  const btnBase = 'px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <Sec
      title={t('temporaryFiles.title')}
      description={t('temporaryFiles.description')}
      isDark={isDark}
    >
      <div className="px-5 py-5 space-y-4">
        {sessions === 0 ? (
          <p className={`text-[13px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {t('temporaryFiles.nothingStaged')}
          </p>
        ) : (
          <>
            <p className={`text-[13px] leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {t('temporaryFiles.usageInfo', { size: formatBytes(bytes), count: sessions })}
            </p>
            <p className={`text-[12px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              {t('temporaryFiles.reviewNote')}
            </p>
            <p className={`text-[12px] font-mono break-all ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {data?.path}
            </p>
          </>
        )}

        {result && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] leading-relaxed ${
              isDark ? 'bg-emerald-500/10 text-emerald-200/90' : 'bg-emerald-50 text-emerald-900'
            }`}
          >
            {result.deleted === 0
              ? t('temporaryFiles.nothingToCleanUp')
              : t('temporaryFiles.freed', { size: formatBytes(result.bytes), count: result.deleted })}
            {result.skippedActive > 0 && ` ${t('temporaryFiles.skippedActive')}`}
          </div>
        )}

        {error && (
          <div
            className={`rounded-lg px-3.5 py-3 text-[12px] ${
              isDark ? 'bg-red-500/10 text-red-200/90' : 'bg-red-50 text-red-900'
            }`}
          >
            {error}
          </div>
        )}

        <button
          onClick={run}
          disabled={busy || sessions === 0}
          className={`${btnBase} ${
            isDark
              ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
          }`}
        >
          {busy ? t('temporaryFiles.cleaningUp') : t('temporaryFiles.cleanUpNow')}
        </button>
      </div>
    </Sec>
  );
}
