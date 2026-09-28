import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Download, Trash2, Loader2, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { getProjectArchives, deleteProjectArchive } from '../../lib/api/library';
import { formatBytes } from '../../lib/utils';
import { formatDate } from '../../lib/formatLocale';
import { UploadProjectArchiveModal } from '../UploadProjectArchiveModal';
import { ConfirmModal } from '../ConfirmModal';

/**
 * Object-level list of uploaded processing-project archives — the working
 * Siril/PixInsight project (process icons, masters, logs) behind a finished
 * processed image, zipped up so it can be revisited or resumed later. Sits
 * right below ObjectProcessedSection: the deliverable picture lives there,
 * the project that produced it lives here.
 *
 * Same collapsed-when-empty convention as ObjectProcessedSection, so an
 * object with nothing archived yet doesn't take up permanent vertical space.
 */
export function ObjectProjectArchivesSection({
  objectId,
  isAdmin,
}: {
  objectId: string;
  isAdmin: boolean;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const queryClient = useQueryClient();

  const { data: archives = [] } = useQuery({
    queryKey: ['project-archives', objectId],
    queryFn: () => getProjectArchives(objectId),
    enabled: !!objectId,
  });

  const [uploadOpen, setUploadOpen] = useState(false);
  // Set by the empty-state dropzone below so the modal opens with that file
  // already loaded, instead of asking the user to drop or browse again.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const hasArchives = archives.length > 0;
  // Same null-means-follow-default / reset-on-object-change pattern as
  // ObjectProcessedSection — see its own comment for the react.dev rationale.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [prevObjectId, setPrevObjectId] = useState(objectId);
  if (objectId !== prevObjectId) {
    setPrevObjectId(objectId);
    setManualOpen(null);
  }
  const isOpen = manualOpen ?? hasArchives;

  const handleDelete = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await deleteProjectArchive(objectId, id);
      await queryClient.invalidateQueries({ queryKey: ['project-archives', objectId] });
    } catch { /* best-effort */ }
    finally { setDeletingId(null); }
  };

  return (
    <div className={`rounded-2xl border ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className={`flex items-center gap-2 p-4 ${isOpen ? `border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}` : ''}`}>
        <button
          type="button"
          onClick={() => setManualOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {isOpen
            ? <ChevronDown className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            : <ChevronRight className={`w-4 h-4 shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />}
          <FileArchive className={`w-4 h-4 shrink-0 ${isDark ? 'text-accent-400' : 'text-accent-600'}`} />
          <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
            {t('objectDetail.projectArchivesSection.heading')}
          </span>
          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {hasArchives
              ? t('objectDetail.projectArchivesSection.countArchived', { count: archives.length })
              : t('objectDetail.projectArchivesSection.noneYet')}
          </span>
        </button>
        {isOpen && isAdmin && hasArchives && (
          <button
            type="button"
            onClick={() => { setPendingFile(null); setUploadOpen(true); }}
            className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition ${
              isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            {t('objectDetail.projectArchivesSection.add')}
          </button>
        )}
      </div>

      {isOpen && (
        <>
          {!hasArchives && (
            <div className="p-4 space-y-3">
              <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {t('objectDetail.projectArchivesSection.emptyHint')}
              </p>
              {isAdmin ? (
                <ObjectArchiveDropzone
                  isDark={isDark}
                  onFile={file => { setPendingFile(file); setUploadOpen(true); }}
                />
              ) : (
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  {t('objectDetail.projectArchivesSection.adminOnlyUpload')}
                </p>
              )}
            </div>
          )}

          {hasArchives && (
            <div className={`divide-y ${isDark ? 'divide-slate-800' : 'divide-slate-100'}`}>
              {archives.map(archive => (
                <div
                  key={archive.id}
                  className="flex items-start gap-3 p-4"
                >
                  <div className={`p-2 rounded-lg shrink-0 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <FileArchive className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-sm font-medium truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                        {archive.title || archive.originalName}
                      </p>
                      {archive.software && (
                        <span className={`text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full ${
                          isDark ? 'bg-accent-500/10 text-accent-400' : 'bg-accent-50 text-accent-600'
                        }`}>
                          {archive.software}
                        </span>
                      )}
                    </div>
                    {archive.title && (
                      <p className={`text-xs truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                        {archive.originalName}
                      </p>
                    )}
                    {archive.notes && (
                      <p className={`text-xs mt-1 whitespace-pre-wrap ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        {archive.notes}
                      </p>
                    )}
                    <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                      {formatBytes(archive.size)} · {formatDate(new Date(archive.uploadedAt), { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={archive.url}
                      download={archive.originalName}
                      className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
                      title={t('objectDetail.projectArchivesSection.download')}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                    {isAdmin && (
                      <button
                        onClick={() => setConfirmDeleteId(archive.id)}
                        disabled={!!deletingId}
                        className={`p-2 rounded-lg transition disabled:opacity-50 ${isDark ? 'text-slate-400 hover:bg-red-500/10 hover:text-red-400' : 'text-slate-500 hover:bg-red-50 hover:text-red-600'}`}
                        title={t('objectDetail.projectArchivesSection.delete')}
                      >
                        {deletingId === archive.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <UploadProjectArchiveModal
        isOpen={uploadOpen}
        onClose={() => { setUploadOpen(false); setPendingFile(null); }}
        objectId={objectId}
        initialFile={pendingFile}
      />

      {confirmDeleteId && (
        <ConfirmModal
          title={t('objectDetail.projectArchivesSection.confirmDeleteTitle')}
          message={t('objectDetail.projectArchivesSection.confirmDeleteMessage')}
          confirmLabel={t('objectDetail.projectArchivesSection.confirmDeleteConfirmLabel')}
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => {
            const id = confirmDeleteId;
            setConfirmDeleteId(null);
            void handleDelete(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * Empty-state drop target, shown the moment the section is expanded so
 * reaching a real drag/drop surface never takes a second click — matching
 * ObjectProcessedSection's own inline dropzone. The metadata fields
 * (title/software/notes) still need the modal's form, so a picked file is
 * handed up via `onFile` rather than uploaded directly from here.
 */
function ObjectArchiveDropzone({ isDark, onFile }: { isDark: boolean; onFile: (file: File) => void }) {
  const { t } = useTranslation('library');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      className={`rounded-xl border-2 border-dashed transition cursor-pointer py-8 px-4 ${
        isDragging
          ? isDark ? 'border-accent-500/60 bg-accent-500/10' : 'border-accent-400 bg-accent-50'
          : isDark ? 'border-slate-700 hover:border-slate-600' : 'border-slate-200 hover:border-slate-300'
      }`}
      onClick={() => fileInputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={e => {
        e.preventDefault();
        setIsDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <div className="flex flex-col items-center justify-center gap-2">
        <FileArchive className={`w-6 h-6 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
        <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
          {t('objectDetail.uploadProjectArchiveModal.dropHere')}
        </p>
        <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('objectDetail.uploadProjectArchiveModal.acceptedFormatsHint')}
        </p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
    </div>
  );
}
