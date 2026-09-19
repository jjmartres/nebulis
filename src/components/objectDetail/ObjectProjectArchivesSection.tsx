import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Download, Trash2, Loader2, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { getProjectArchives, deleteProjectArchive } from '../../lib/api/library';
import { formatBytes } from '../../lib/utils';
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
  const queryClient = useQueryClient();

  const { data: archives = [] } = useQuery({
    queryKey: ['project-archives', objectId],
    queryFn: () => getProjectArchives(objectId),
    enabled: !!objectId,
  });

  const [uploadOpen, setUploadOpen] = useState(false);
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
          <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Processing Projects</span>
          <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {hasArchives ? `${archives.length} archived` : 'None yet'}
          </span>
        </button>
        {isOpen && isAdmin && hasArchives && (
          <button
            type="button"
            onClick={() => setUploadOpen(true)}
            className={`shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition ${
              isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )}
      </div>

      {isOpen && (
        <>
          {!hasArchives && (
            <div className="p-4 space-y-3">
              <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                No processing projects archived yet. Save your Siril or PixInsight project — process icons,
                masters, logs — as a .zip so you can revisit or resume it later.
              </p>
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => setUploadOpen(true)}
                  className={`inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg transition ${
                    isDark
                      ? 'bg-accent-500/15 text-accent-400 hover:bg-accent-500/25 border border-accent-500/30'
                      : 'bg-accent-500 text-white hover:bg-accent-600'
                  }`}
                >
                  <FileArchive className="w-4 h-4" />
                  Upload project .zip
                </button>
              ) : (
                <p className={`text-xs ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                  Sign in as an admin to upload.
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
                      {formatBytes(archive.size)} · {new Date(archive.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <a
                      href={archive.url}
                      download={archive.originalName}
                      className={`p-2 rounded-lg transition ${isDark ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
                      title="Download"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                    {isAdmin && (
                      <button
                        onClick={() => setConfirmDeleteId(archive.id)}
                        disabled={!!deletingId}
                        className={`p-2 rounded-lg transition disabled:opacity-50 ${isDark ? 'text-slate-400 hover:bg-red-500/10 hover:text-red-400' : 'text-slate-500 hover:bg-red-50 hover:text-red-600'}`}
                        title="Delete"
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
        onClose={() => setUploadOpen(false)}
        objectId={objectId}
      />

      {confirmDeleteId && (
        <ConfirmModal
          title="Delete project archive?"
          message="This will permanently delete the uploaded project archive. This cannot be undone."
          confirmLabel="Delete"
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
