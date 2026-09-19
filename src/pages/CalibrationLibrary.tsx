/**
 * Calibration Library — browses every bias/dark/flat/flat-dark frame Nebulis
 * has archived from a telescope or a folder-import run (see
 * server/lib/library/calibrationScan.ts). These frames are never library
 * objects (a dark frame is not an observation of anything in the sky — see
 * archiveFolders.ts), so unlike every other nav section this one reads
 * straight off disk rather than the library database, and there is nothing
 * to import/edit here: it is a browser, not an editor.
 *
 * Frames are organized by capture settings (exposure, binning, gain, TEC/
 * sensor temperature) rather than by raw folder name — that is the grouping
 * that actually matters for matching calibration frames to lights in Siril/
 * PixInsight, and it works even when the source folder gives no hint at all
 * (a live ASIAIR sync's flat `Plan/Dark/` has no per-setting subfolders).
 * Each settings group downloads as one ZIP bundle, ready to hand to a
 * stacking app.
 *
 * Route: /calibrations
 */
import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, Aperture, Check, ChevronRight, Download, File, Link2, Loader2, Trash2, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import {
  getCalibrationLibrary,
  requestCalibrationBundleUrl,
  detachCalibrationBundle,
  deleteCalibrationBundle,
  type CalibrationFrameInfo,
  type CalibrationFrameType,
  type CalibrationGroup,
  type CalibrationSettingsGroup,
} from '../lib/api/library';
import { formatBytes } from '../lib/utils';
import { Sec } from '../components/settings/SettingsUI';
import { AttachCalibrationModal } from '../components/AttachCalibrationModal';
import { ConfirmModal } from '../components/ConfirmModal';

/** Only flats and their matching flat-darks are session-specific enough to
 *  need attaching to an object at all — bias/darks stay valid across
 *  sessions on a cooled camera and stay in the shared calibration pool. See
 *  server/lib/library/calibrationAttachments.ts. */
function isAttachableType(type: CalibrationFrameType): boolean {
  return type === 'flat' || type === 'flatDark';
}

/** Only bias/darks age out (Settings → Library → "Dark/bias validity") and
 *  can be permanently deleted from here — flats/flat-darks are managed by
 *  attaching them to an object instead. See calibrationScan.ts's
 *  isExpiredCalibration and deleteCalibrationBundle. */
function isDeletableType(type: CalibrationFrameType): boolean {
  return type === 'bias' || type === 'dark';
}

/** Rendered top-to-bottom, mirroring a real calibration workflow: bias first
 *  (used to derive the others' noise floor), then darks, then flats and their
 *  matching flat-darks, with Dwarf's blended folder last since it isn't one
 *  type. */
const TYPE_ORDER: CalibrationFrameType[] = ['bias', 'dark', 'flat', 'flatDark', 'mixed'];

const TYPE_DESCRIPTION: Record<CalibrationFrameType, string> = {
  bias: 'Zero-length exposures that capture the sensor\'s fixed read noise, used to remove it from every other calibration frame.',
  dark: 'Exposures taken with the sensor covered, matched to a light frame\'s exposure/gain/temperature, used to subtract thermal noise.',
  flat: 'Evenly-illuminated exposures used to correct vignetting and dust motes across the frame.',
  flatDark: 'Dark frames matched to a flat\'s (usually much shorter) exposure, used when flats aren\'t bias-corrected instead.',
  mixed: 'Calibration frames archived as your Dwarf telescope wrote them — a blend of frame types the device does not separate.',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatExposure(v: number | null): string {
  if (v === null) return '—';
  return v < 1 ? `${Math.round(v * 1000)}ms` : `${v}s`;
}

function formatBinning(v: number | null): string {
  return v === null ? '—' : `${v}×${v}`;
}

function formatGain(v: number | null): string {
  return v === null ? '—' : String(v);
}

/** Rounded to the nearest whole degree for display: `set.sensorTempC` is a
 *  bundle's own mean (see calibrationScan.ts's TEC clustering), not
 *  necessarily any single frame's exact reading, so showing it to a decimal
 *  place reads as more precise than it is. A per-file reading in the
 *  expanded row below stays exact — see frameInfoSummary. */
function formatTemp(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}°C`;
}

/** A short "5.0s · Bin1 · gain100 · -8.0°C" line from parsed filename
 *  metadata, omitting whichever fields weren't recognized rather than
 *  showing a placeholder for each. */
function frameInfoSummary(info: CalibrationFrameInfo | null): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.exposureSec !== undefined) parts.push(formatExposure(info.exposureSec));
  if (info.binning !== undefined) parts.push(`Bin${info.binning}`);
  if (info.gain !== undefined) parts.push(`gain${info.gain}`);
  if (info.sensorTempC !== undefined) parts.push(`${info.sensorTempC}°C`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function rowKeyFor(group: CalibrationGroup, set: CalibrationSettingsGroup): string {
  return `${group.scope ?? 'unscoped'}:${group.folderName}:${set.key}`;
}

function SettingsGroupTable({
  group,
  isDark,
  expanded,
  onToggle,
  onDownload,
  downloadingKey,
  onAttach,
  onDetach,
  detachingId,
  onDeleteRequest,
  deletingKey,
}: {
  group: CalibrationGroup;
  isDark: boolean;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onDownload: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  downloadingKey: string | null;
  onAttach: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  onDetach: (attachmentId: string) => void;
  detachingId: string | null;
  onDeleteRequest: (group: CalibrationGroup, set: CalibrationSettingsGroup) => void;
  deletingKey: string | null;
}) {
  const borderClass = isDark ? 'border-slate-800' : 'border-slate-100';
  const headClass = `text-left font-medium px-4 py-2.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
  const attachable = isAttachableType(group.type);
  const deletable = isDeletableType(group.type);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className={isDark ? 'bg-slate-800/60' : 'bg-slate-50'}>
            <th className={headClass}>Exposure</th>
            <th className={headClass}>Bin</th>
            <th className={headClass}>Gain</th>
            <th className={headClass}>TEC</th>
            <th className={headClass}>Frames</th>
            <th className={headClass}>Size</th>
            <th className={headClass}>Modified</th>
            {attachable && <th className={headClass}>Attached to</th>}
            {deletable && <th className={headClass}>Status</th>}
            <th className={headClass} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {group.settingsGroups.map(set => {
            const key = rowKeyFor(group, set);
            const isOpen = expanded.has(key);
            const isDownloading = downloadingKey === key;
            const isDeleting = deletingKey === key;
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => onToggle(key)}
                  className={`cursor-pointer transition-colors border-t ${borderClass} ${
                    isDark ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'
                  }`}
                >
                  <td className={`px-4 py-3 font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    <div className="flex items-center gap-2">
                      <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''} ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
                      {formatExposure(set.exposureSec)}
                    </div>
                  </td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBinning(set.binning)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatGain(set.gain)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatTemp(set.sensorTempC)}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{set.fileCount}</td>
                  <td className={`px-4 py-3 tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{formatBytes(set.bytes)}</td>
                  <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{formatDateTime(set.modifiedAt)}</td>
                  {attachable && (
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(set.attachments ?? []).map(a => (
                          <span
                            key={a.id}
                            title={a.date ? `Session: ${a.date}` : 'Every session of this object'}
                            className={`inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full text-xs font-medium ${
                              isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                            }`}
                          >
                            <span className="truncate max-w-[9rem]">{a.objectName}{a.date ? ` · ${a.date}` : ''}</span>
                            <button
                              type="button"
                              onClick={() => onDetach(a.id)}
                              disabled={detachingId === a.id}
                              title="Detach"
                              className={`p-0.5 rounded-full transition disabled:opacity-40 ${isDark ? 'hover:bg-emerald-500/20' : 'hover:bg-emerald-100'}`}
                            >
                              {detachingId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() => onAttach(group, set)}
                          title="Attach to an object"
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition ${
                            isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          <Link2 className="w-3 h-3" />
                          {(set.attachments ?? []).length === 0 ? 'Attach' : ''}
                        </button>
                      </div>
                    </td>
                  )}
                  {deletable && (
                    <td className="px-4 py-3">
                      {set.isExpired ? (
                        <span
                          title="Older than the configured validity window (Settings → Library → Dark/bias validity) — consider re-shooting and deleting this set."
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          <AlertTriangle className="w-3 h-3" />
                          Expired
                        </span>
                      ) : set.capturedAt ? (
                        <span
                          title="Within the configured validity window (Settings → Library → Dark/bias validity)."
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          <Check className="w-3 h-3" />
                          Valid
                        </span>
                      ) : (
                        <span
                          title="No capture date could be read from these filenames, so validity can't be checked."
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-100 text-slate-400'
                          }`}
                        >
                          Unknown
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onDownload(group, set); }}
                        disabled={isDownloading}
                        title="Download this bundle as a ZIP"
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                          isDark ? 'bg-accent-500/10 text-accent-400 hover:bg-accent-500/20' : 'bg-accent-50 text-accent-700 hover:bg-accent-100'
                        }`}
                      >
                        {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        <span className="hidden sm:inline">ZIP</span>
                      </button>
                      {deletable && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onDeleteRequest(group, set); }}
                          disabled={isDeleting}
                          title="Permanently delete this bundle from the archive"
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition disabled:opacity-50 ${
                            isDark ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-red-50 text-red-700 hover:bg-red-100'
                          }`}
                        >
                          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && set.files.map(file => (
                  <tr key={`${key}/${file.name}`} className={`border-t ${borderClass} ${isDark ? 'bg-slate-900/40' : 'bg-slate-50/60'}`}>
                    <td colSpan={4} className={`px-4 py-2 pl-11 font-mono text-xs truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <div className="flex items-center gap-2">
                        <File className="w-3.5 h-3.5 shrink-0 opacity-60" />
                        <span className="truncate" title={file.path}>{file.name}</span>
                      </div>
                    </td>
                    <td className={`px-4 py-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      {frameInfoSummary(file.info) ?? '—'}
                    </td>
                    <td className={`px-4 py-2 text-xs tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{formatBytes(file.size)}</td>
                    <td className={`px-4 py-2 text-xs whitespace-nowrap ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{formatDateTime(file.modifiedAt)}</td>
                    {attachable && <td />}
                    {deletable && <td />}
                    <td />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CalibrationLibrary() {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['calibration-library'],
    queryFn: getCalibrationLibrary,
    staleTime: 60_000,
  });
  const groups = useMemo(() => data?.groups ?? [], [data]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [attachTarget, setAttachTarget] = useState<{ group: CalibrationGroup; set: CalibrationSettingsGroup } | null>(null);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ group: CalibrationGroup; set: CalibrationSettingsGroup } | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // The "Download" button can't be a plain <a href>: the ZIP route needs a
  // credential, and a browser download navigation can't send the auth
  // header. Mint a short-lived signed URL, then click a synthetic <a> at it
  // — same pattern ObjectDetail.tsx's "Download All" uses.
  async function handleDownload(group: CalibrationGroup, set: CalibrationSettingsGroup) {
    const key = rowKeyFor(group, set);
    setDownloadError(null);
    setDownloadingKey(key);
    try {
      const { url } = await requestCalibrationBundleUrl(group.scope, group.folderName, set.key);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not start the download. Try again.');
    } finally {
      setDownloadingKey(null);
    }
  }

  function handleAttached() {
    queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
  }

  async function handleDetach(attachmentId: string) {
    setAttachError(null);
    setDetachingId(attachmentId);
    try {
      await detachCalibrationBundle(attachmentId);
      queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Could not detach this bundle. Try again.');
    } finally {
      setDetachingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const { group, set } = deleteTarget;
    const key = rowKeyFor(group, set);
    setDeleteError(null);
    setDeletingKey(key);
    try {
      await deleteCalibrationBundle(group.scope, group.folderName, set.key);
      queryClient.invalidateQueries({ queryKey: ['calibration-library'] });
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete this bundle. Try again.');
    } finally {
      setDeletingKey(null);
    }
  }

  const groupsByType = useMemo(() => {
    const map = new Map<CalibrationFrameType, CalibrationGroup[]>();
    for (const g of groups) {
      const list = map.get(g.type) ?? [];
      list.push(g);
      map.set(g.type, list);
    }
    return map;
  }, [groups]);

  // Folder-per-scope badges are only useful once more than one scope is
  // actually present — a single-telescope household (the common case) would
  // otherwise see a redundant "Unassigned"/telescope-name tag on every row.
  const multiScope = useMemo(() => new Set(groups.map(g => g.scope)).size > 1, [groups]);

  const totalFiles = groups.reduce((sum, g) => sum + g.fileCount, 0);
  const totalBytes = groups.reduce((sum, g) => sum + g.bytes, 0);

  const tileClass = `p-4 rounded-xl ${isDark ? 'bg-slate-800' : 'bg-slate-50'}`;
  const tileLabel = `text-xs font-medium uppercase tracking-wider mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`;
  const tileValue = `text-xl font-bold font-display ${isDark ? 'text-white' : 'text-slate-900'}`;

  return (
    <div className="space-y-8">
      <div className="text-center space-y-3">
        <h1 className={`font-display text-4xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          Calibrations
        </h1>
        <p className={`text-lg max-w-2xl mx-auto ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Bias, dark, flat and flat-dark frames archived from your telescopes, organized by exposure,
          binning, gain and TEC temperature — download any bundle as a ZIP for post-processing.
        </p>
      </div>

      {(downloadError || attachError || deleteError) && (
        <div className={`max-w-2xl mx-auto flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm ${
          isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-700'
        }`}>
          <AlertCircle className="w-4 h-4 shrink-0" />
          {downloadError ?? attachError ?? deleteError}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 py-16 justify-center">
          <Loader2 className={`w-5 h-5 animate-spin ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
          <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>Loading…</span>
        </div>
      )}

      {!isLoading && error && (
        <div className={`flex flex-col items-center gap-2 py-16 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          <AlertCircle className="w-6 h-6 text-red-500" />
          <p>Couldn't load the calibration library.</p>
        </div>
      )}

      {!isLoading && !error && groups.length === 0 && (
        <div className={`flex flex-col items-center gap-3 py-16 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
          <Aperture className="w-10 h-10 opacity-30" />
          <p className="max-w-sm">
            Nothing archived yet. Bias, dark, flat and flat-dark folders are picked up automatically
            the next time a telescope syncs or a folder import runs.
          </p>
        </div>
      )}

      {!isLoading && !error && groups.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-2xl mx-auto">
            <div className={tileClass}>
              <p className={tileLabel}>Frames</p>
              <p className={tileValue}>{totalFiles.toLocaleString()}</p>
            </div>
            <div className={tileClass}>
              <p className={tileLabel}>Total size</p>
              <p className={tileValue}>{formatBytes(totalBytes)}</p>
            </div>
            <div className={tileClass}>
              <p className={tileLabel}>Frame types</p>
              <p className={tileValue}>{groupsByType.size}</p>
            </div>
          </div>

          {TYPE_ORDER.filter(type => groupsByType.has(type)).map(type => {
            const typeGroups = groupsByType.get(type)!;
            return (
              <Sec key={type} title={typeGroups[0].typeLabel} description={TYPE_DESCRIPTION[type]} isDark={isDark}>
                <div className="divide-y divide-slate-800/50">
                  {typeGroups.map(group => (
                    <div key={`${group.scope ?? 'unscoped'}:${group.folderName}`}>
                      {(typeGroups.length > 1 || multiScope) && (
                        <div className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider ${
                          isDark ? 'text-slate-500 bg-slate-800/30' : 'text-slate-400 bg-slate-50'
                        }`}>
                          {group.folderName}{multiScope ? ` · ${group.scopeLabel}` : ''}
                        </div>
                      )}
                      <SettingsGroupTable
                        group={group}
                        isDark={isDark}
                        expanded={expanded}
                        onToggle={toggle}
                        onDownload={handleDownload}
                        downloadingKey={downloadingKey}
                        onAttach={(g, s) => setAttachTarget({ group: g, set: s })}
                        onDetach={handleDetach}
                        detachingId={detachingId}
                        onDeleteRequest={(g, s) => setDeleteTarget({ group: g, set: s })}
                        deletingKey={deletingKey}
                      />
                    </div>
                  ))}
                </div>
              </Sec>
            );
          })}
        </>
      )}

      {attachTarget && (
        <AttachCalibrationModal
          isDark={isDark}
          scope={attachTarget.group.scope}
          folderName={attachTarget.group.folderName}
          settingsKey={attachTarget.set.key}
          bundleLabel={`${attachTarget.group.typeLabel} · ${formatExposure(attachTarget.set.exposureSec)} · ${formatBinning(attachTarget.set.binning)} · gain ${formatGain(attachTarget.set.gain)} · ${formatTemp(attachTarget.set.sensorTempC)}`}
          onClose={() => setAttachTarget(null)}
          onAttached={handleAttached}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete this calibration bundle?"
          message={`This permanently removes ${deleteTarget.set.fileCount} file${deleteTarget.set.fileCount === 1 ? '' : 's'} (${formatBytes(deleteTarget.set.bytes)}) from the archive — ${deleteTarget.group.typeLabel} · ${formatExposure(deleteTarget.set.exposureSec)} · ${formatBinning(deleteTarget.set.binning)} · gain ${formatGain(deleteTarget.set.gain)} · ${formatTemp(deleteTarget.set.sensorTempC)}.\n\nThis cannot be undone.`}
          confirmLabel="Delete"
          pending={deletingKey === rowKeyFor(deleteTarget.group, deleteTarget.set)}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
