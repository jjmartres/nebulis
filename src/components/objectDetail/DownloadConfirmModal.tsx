/**
 * Confirmation shown before "Download" zips and downloads every file for an
 * object. A whole-object ZIP can run into the tens of gigabytes on a target
 * shot for years, and the old button fired the download with no warning at
 * all, so a slow connection or a nearly-full disk found out the hard way.
 * This surfaces the file count and total size up front and lets the user
 * back out, the same trade DangerConfirm makes for the destructive actions.
 *
 * Not built on DangerConfirm: this isn't destructive (no red styling, no
 * AlertTriangle), and it owns its own data fetch (the size summary) rather
 * than taking a body from the caller, which matches FileLocationModal's
 * shape more than DangerConfirm's.
 */
import { useTranslation, Trans } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Download, FileStack, HardDrive, Loader2, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useTheme } from '../../hooks/useTheme';
import { getObjectDownloadSummary } from '../../lib/api/library';
import { formatBytes } from '../../lib/utils';

function StatChip({ icon: Icon, label }: { icon: typeof FileStack; label: string }) {
  const { isDark } = useTheme();
  return (
    <div className={`flex flex-1 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium
      ${isDark ? 'bg-slate-800/70 text-slate-200' : 'bg-slate-100 text-slate-700'}`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
      {label}
    </div>
  );
}

export function DownloadConfirmModal({
  objectId,
  displayName,
  onClose,
  onConfirm,
}: {
  objectId: string;
  displayName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['object-download-summary', objectId],
    queryFn: () => getObjectDownloadSummary(objectId, { fileType: 'all', includeVariants: true }),
    staleTime: 30 * 1000,
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('objectDetail.hero.downloadConfirmTitle')}
      className={`mx-4 w-full max-w-md rounded-2xl border shadow-2xl ${
        isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`flex items-center justify-between border-b px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <h3 className={`flex items-center gap-2.5 text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          <Download className={`h-4 w-4 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          {t('objectDetail.hero.downloadConfirmTitle')}
        </h3>
        <button
          onClick={onClose}
          className={`rounded-lg p-1.5 transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">{t('fileLocationModal.close')}</span>
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
          <Trans
            i18nKey="objectDetail.hero.downloadConfirmBody"
            ns="library"
            values={{ name: displayName }}
            components={{ 1: <strong /> }}
          />
        </p>

        {isLoading && (
          <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('objectDetail.hero.downloadConfirmCalculating')}
          </div>
        )}

        {isError && (
          <p className={`text-sm ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('objectDetail.hero.downloadConfirmSizeUnavailable')}
          </p>
        )}

        {data && (
          <div className="flex gap-2.5">
            <StatChip
              icon={FileStack}
              label={t('objectDetail.hero.downloadConfirmFileCount', { count: data.fileCount })}
            />
            <StatChip icon={HardDrive} label={formatBytes(data.totalBytes)} />
          </div>
        )}
      </div>

      <div className={`flex justify-end gap-3 border-t px-5 py-3.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <button
          onClick={onClose}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
            isDark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {t('objectDetail.hero.downloadConfirmCancel')}
        </button>
        <button
          onClick={onConfirm}
          className="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2 text-sm font-semibold
            text-slate-950 transition hover:bg-accent-600"
        >
          <Download className="h-4 w-4" />
          {t('objectDetail.hero.download')}
        </button>
      </div>
    </Modal>
  );
}
