import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { deleteLibrarySession } from '../lib/api/library';
import { useTheme } from '../hooks/useTheme';
import { Modal } from './ui/Modal';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  objectId: string;
  date: string;
  displayName: string;
  formattedDate: string;
}

export function DeleteSessionModal({ isOpen, onClose, objectId, date, displayName, formattedDate }: Props) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // The heading, the input placeholder, and this check all read from the same
  // key so they can never drift apart in a translated UI.
  const confirmWord = t('observationDetail.deleteSessionModal.confirmWord');

  const handleDelete = useCallback(async () => {
    // Re-entry guard: the confirm input fires this on Enter, and key auto-repeat
    // can land a second call before React commits the disabled state.
    if (isDeleting) return;
    if (confirmText.toLowerCase() !== confirmWord.toLowerCase()) return;
    setIsDeleting(true);
    try {
      await deleteLibrarySession(objectId, date);
      // This route back always lands on the object page, and without these
      // its session grid and "N deleted" restore link both read from caches
      // that still show the world as it was before the delete: the default
      // staleTime is 30s, so navigating back within that window (the normal
      // case) would otherwise show nothing had changed.
      queryClient.invalidateQueries({ queryKey: ['library-sessions', objectId] });
      queryClient.invalidateQueries({ queryKey: ['deleted-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['library-objects'] });
      queryClient.invalidateQueries({ queryKey: ['observations'] });
      onClose();
      navigate(-1);
    } catch {
      setIsDeleting(false);
    }
  }, [isDeleting, confirmText, confirmWord, objectId, date, onClose, navigate, queryClient]);

  // Guards both Escape and backdrop-click, matching the Cancel button's own
  // `disabled={isDeleting}` so a delete already in flight can't be dismissed
  // out from under itself.
  const handleModalClose = useCallback(() => {
    if (!isDeleting) onClose();
  }, [isDeleting, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleModalClose} title={t('observationDetail.deleteSessionModal.title')} backdropClassName="bg-black/70">
      <div className={`w-full max-w-md mx-4 rounded-2xl border p-6 space-y-4 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-xl'}`}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-red-500/10">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <h3 className={`font-display font-semibold text-lg ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {t('observationDetail.deleteSessionModal.title')}
          </h3>
        </div>
        <div className={`text-sm space-y-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <p>
            <Trans
              i18nKey="observationDetail.deleteSessionModal.confirmMessage"
              ns="observations"
              values={{ name: displayName, date: formattedDate }}
              components={{
                1: <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`} />,
                2: <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`} />,
                3: <span className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`} />,
              }}
            />
          </p>
          <p>
            {t('observationDetail.deleteSessionModal.warningText')}
          </p>
          <p>{t('observationDetail.deleteSessionModal.unaffectedText')}</p>
        </div>
        <div className="space-y-1.5">
          <label className={`text-xs font-medium ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {t('observationDetail.deleteSessionModal.typeToConfirmBefore')}{' '}
            <span className="font-bold text-red-500">{confirmWord}</span>{' '}
            {t('observationDetail.deleteSessionModal.typeToConfirmAfter')}
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleDelete(); }}
            placeholder={confirmWord}
            autoFocus
            className={`w-full px-3 py-2 rounded-lg border text-sm transition ${
              isDark
                ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-600 focus:border-red-500'
                : 'bg-white border-slate-300 text-slate-900 placeholder-slate-400 focus:border-red-500'
            } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500`}
          />
        </div>
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={handleModalClose}
            disabled={isDeleting}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
            }`}
          >
            {t('confirmModal.cancel', { ns: 'common' })}
          </button>
          <button
            onClick={handleDelete}
            disabled={confirmText.toLowerCase() !== confirmWord.toLowerCase() || isDeleting}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white transition hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('observationDetail.deleteSessionModal.title')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
