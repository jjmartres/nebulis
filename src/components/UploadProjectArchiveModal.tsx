import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileArchive, X, AlertTriangle, Loader2, UploadCloud } from 'lucide-react';
import { uploadProjectArchive } from '../lib/api/library';
import { formatBytes } from '../lib/utils';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  // Pre-fills the drop zone with a file the caller already picked up (e.g.
  // from an inline dropzone rendered before this modal was open), so the
  // user isn't asked to drop or browse for the same file twice.
  initialFile?: File | null;
}

/**
 * Upload the working project behind a finished processed image — a Siril
 * project/log bundle or a PixInsight process-icons/masters folder, zipped up
 * — as opposed to UploadProcessedModal, which uploads the finished picture
 * itself. Object-scoped only (no session picker): a real project routinely
 * draws on more than one night's subs, so there is no single observation to
 * file it under, the same reasoning a Dwarf RESTACKED processed image is
 * object-scoped for.
 *
 * A real project archive can run up to 20 GB (see the server's
 * projectArchiveUpload limit), easily an hour or more on a home upload
 * link, so, unlike UploadProcessedModal's bare "Uploading..." spinner, this
 * shows real progress and lets the user actually cancel a transfer already
 * in flight rather than just disabling the button.
 */
export function UploadProjectArchiveModal({ isOpen, onClose, objectId, initialFile }: Props) {
  const { isDark, isNight, isSpace } = useTheme();
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [software, setSoftware] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  const handleSelectFile = useCallback((f: File) => {
    if (!/\.zip$/i.test(f.name)) {
      setError(t('objectDetail.uploadProjectArchiveModal.onlyZipError'));
      return;
    }
    setError('');
    setFile(f);
  }, [t]);

  useEffect(() => {
    if (!isOpen) return;
    setTitle('');
    setNotes('');
    setSoftware('');
    setFile(null);
    setError('');
    setIsDragging(false);
    setIsUploading(false);
    setProgress(null);
    if (initialFile) handleSelectFile(initialFile);
    // Only re-run when the modal opens or a new pre-picked file arrives, not
    // on every handleSelectFile identity change (it depends on `t`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialFile]);

  // Abort an in-flight transfer if the modal unmounts outright (not just
  // closes via the Cancel button below, which already aborts explicitly) —
  // otherwise a multi-GB upload keeps running against a component with
  // nothing left to receive its result.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleUpload = useCallback(async () => {
    if (!file || isUploading) return;
    setIsUploading(true);
    setProgress({ loaded: 0, total: file.size });
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await uploadProjectArchive(
        objectId, file, title, notes, software,
        (loaded, total) => setProgress({ loaded, total }),
        controller.signal,
      );
      await queryClient.invalidateQueries({ queryKey: ['project-archives', objectId] });
      onClose();
    } catch (err) {
      // A user-initiated cancel (the Cancel button below) is not a failure —
      // leave the modal open with no error, ready to pick a file again.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('');
      } else {
        setError(err instanceof Error ? err.message : t('objectDetail.uploadProjectArchiveModal.uploadFailed'));
      }
    } finally {
      abortRef.current = null;
      setIsUploading(false);
      setProgress(null);
    }
  }, [file, isUploading, objectId, title, notes, software, queryClient, onClose, t]);

  const handleCancel = useCallback(() => {
    if (isUploading) {
      abortRef.current?.abort();
      return;
    }
    onClose();
  }, [isUploading, onClose]);

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  // Guards both Escape and backdrop-click, matching the header X button's own
  // `disabled={isUploading}` — the "Cancel upload" button is the deliberate,
  // explicit way to abort a transfer already in flight.
  const handleModalClose = () => {
    if (!isUploading) onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleModalClose} title={t('objectDetail.uploadProjectArchiveModal.title')} backdropClassName="bg-black/70">
      <div className={`w-full max-w-lg rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
        <div className={`flex items-center justify-between p-5 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full ${isDark ? 'bg-accent-500/10' : 'bg-accent-50'}`}>
              <FileArchive className={`w-4 h-4 ${accentText}`} />
            </div>
            <h3 className={`font-display font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {t('objectDetail.uploadProjectArchiveModal.title')}
            </h3>
          </div>
          <button
            onClick={handleModalClose}
            disabled={isUploading}
            title={isUploading ? t('objectDetail.uploadProjectArchiveModal.closeDisabledHint') : t('objectDetail.uploadProjectArchiveModal.close')}
            className={`p-2 rounded-lg transition disabled:opacity-30 disabled:cursor-not-allowed ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div
            className={`rounded-xl border-2 border-dashed transition ${isUploading ? 'cursor-default' : 'cursor-pointer'} ${
              isDragging
                ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
                : file
                  ? isDark ? 'border-accent-500/40 bg-accent-500/5' : 'border-accent-300 bg-accent-50/50'
                  : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
            }`}
            onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}
            onDragOver={e => { if (!isUploading) { e.preventDefault(); setIsDragging(true); } }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => {
              e.preventDefault();
              setIsDragging(false);
              if (isUploading) return;
              const f = e.dataTransfer.files[0];
              if (f) handleSelectFile(f);
            }}
          >
            {file ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 px-4">
                <div className={`px-3 py-2 rounded-lg font-mono text-sm font-bold ${isDark ? 'bg-slate-800 text-accent-400' : 'bg-slate-100 text-accent-600'}`}>
                  ZIP
                </div>
                <p className={`text-sm font-medium px-4 text-center break-all ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                  {file.name}
                </p>
                {isUploading && progress ? (
                  <div className="w-full max-w-xs space-y-1.5 pt-1">
                    <div className={`h-1.5 w-full rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
                      <div
                        className={`h-full rounded-full transition-all ${isNight ? 'bg-red-500' : isSpace ? 'bg-violet-500' : 'bg-accent-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className={`text-xs text-center tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {t('objectDetail.uploadProjectArchiveModal.progressStatus', {
                        pct,
                        loaded: formatBytes(progress.loaded),
                        total: formatBytes(progress.total),
                      })}
                    </p>
                  </div>
                ) : (
                  <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {formatBytes(file.size)}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-8">
                <div className={`p-3 rounded-full ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <UploadCloud className={`w-6 h-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                </div>
                <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {t('objectDetail.uploadProjectArchiveModal.dropHere')}
                </p>
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {t('objectDetail.uploadProjectArchiveModal.acceptedFormatsHint')}
                </p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleSelectFile(f); }}
          />

          <div className="space-y-1">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('objectDetail.uploadProjectArchiveModal.titleLabel')}
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={isUploading}
              placeholder={t('objectDetail.uploadProjectArchiveModal.titlePlaceholder')}
              className={`w-full px-3 py-2 rounded-lg border text-sm transition disabled:opacity-50 ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
          </div>

          <div className="space-y-1">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('objectDetail.uploadProjectArchiveModal.softwareLabel')}
            </label>
            <input
              type="text"
              value={software}
              onChange={e => setSoftware(e.target.value)}
              disabled={isUploading}
              placeholder={t('objectDetail.uploadProjectArchiveModal.softwarePlaceholder')}
              className={`w-full px-3 py-2 rounded-lg border text-sm transition disabled:opacity-50 ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
          </div>

          <div className="space-y-1">
            <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {t('objectDetail.uploadProjectArchiveModal.notesLabel')}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              disabled={isUploading}
              placeholder={t('objectDetail.uploadProjectArchiveModal.notesPlaceholder')}
              rows={3}
              className={`w-full px-3 py-2 rounded-lg border text-sm resize-none transition disabled:opacity-50 ${
                isDark
                  ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-violet-500'
                  : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-accent-500'
              } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500`}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 pb-5">
          <button
            onClick={handleCancel}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            {isUploading ? t('objectDetail.uploadProjectArchiveModal.cancelUpload') : t('objectDetail.uploadProjectArchiveModal.cancel')}
          </button>
          <button
            onClick={handleUpload}
            disabled={!file || isUploading}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 ${
              isDark
                ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                : 'bg-accent-500 text-white hover:bg-accent-600'
            }`}
          >
            {isUploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isUploading ? t('objectDetail.uploadProjectArchiveModal.uploading', { pct }) : t('objectDetail.uploadProjectArchiveModal.uploadProject')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
