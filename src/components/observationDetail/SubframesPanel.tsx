import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Satellite, Download, Trash2, ArrowRight, Activity, Loader2 } from 'lucide-react';
import { SubframeQualityPanel } from './SubframeQualityPanel';
import { useSubFrameQuality } from '../../hooks/useSubFrameQuality';
import type { SubFrameQualityRow } from '../../lib/api/library';
import { FitsThumbnail } from '../FitsThumbnail';
import { useTheme } from '../../hooks/useTheme';
import type { SessionFile } from '../../types';
import { thumbSrcFor } from '../../lib/sessionImageSrc';

/** Smallest a tile may be. Tiles stretch past this to consume the leftover
 *  pixels of the row, so the strip always ends flush with the panel edge. */
const MIN_TILE = 64;
/** gap-1.5 */
const GAP = 6;

/**
 * Evenly spaced indices across [0, total), endpoints included, so the strip
 * represents the whole session rather than only its first few minutes. The
 * returned values are real indices into the subframe list, which is what the
 * viewer needs to open on the frame that was clicked.
 *
 * To go back to a plain "first N frames" strip, return
 * `Array.from({ length: Math.min(count, total) }, (_, i) => i)`.
 */
function sampleIndices(total: number, count: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count <= 1) return [0];
  return Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1)));
}

/** Telescope subframes tray: a single row of tiles that always fills the panel
 *  width exactly. The row renders as many columns as fit at MIN_TILE and no
 *  more, so it can never wrap and strand a tile on a second row. What is hidden
 *  is stated in the footer instead of in an overflow tile.
 *  The ResizeObserver measurement is entirely local to this panel. */
const GRADE_BADGE: Record<NonNullable<SubFrameQualityRow['grade']>, string> = {
  good: 'bg-emerald-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
};

export function SubframesPanel({
  objectId,
  date,
  subFrames,
  isAdmin,
  telescopeOnline,
  archiveState,
  onDownloadToComputer,
  onOpenSync,
  onScanTrails,
  onDeleteAllSubframes,
  onOpenGallery,
}: {
  /** Library object and night, for the sub-frame quality view. */
  objectId: string;
  date: string;
  subFrames: SessionFile[];
  isAdmin: boolean;
  telescopeOnline: boolean;
  archiveState: { done: number; total: number } | 'idle' | 'error';
  onDownloadToComputer: () => void;
  onOpenSync: () => void;
  onScanTrails: () => void;
  onDeleteAllSubframes: () => void;
  onOpenGallery: (index: number, source?: 'files' | 'subframes') => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('observations');
  const hasSubFrames = subFrames.length > 0;
  const hasFits = hasSubFrames && subFrames.some(f => f.type === 'fits');

  // Sub-frame quality: the toolbar button toggles the view inside this tile;
  // once a night is measured, thumbnails carry a grade dot either way.
  const quality = useSubFrameQuality(objectId, date, hasFits);
  const report = quality.data;
  const [qualityOpen, setQualityOpen] = useState(false);
  const measuring = !!report?.job?.running;
  const showQuality = qualityOpen || measuring;
  const qualityByName = useMemo(() => {
    const map = new Map<string, SubFrameQualityRow>();
    for (const f of report?.frames ?? []) if (f.measured) map.set(f.fileName, f);
    return map;
  }, [report]);

  // Measured on the grid itself, which carries no padding of its own, so
  // clientWidth is exactly the space the tiles have to divide up.
  const subFramesRowRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(16);
  useEffect(() => {
    const el = subFramesRowRef.current;
    if (!el) return;
    const measure = () => {
      setColumns(Math.max(1, Math.floor((el.clientWidth + GAP) / (MIN_TILE + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shownIndices = sampleIndices(subFrames.length, columns);
  const hiddenCount = subFrames.length - shownIndices.length;

  return (
    <div className={`rounded-2xl border min-w-0 flex flex-col ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}>
      {/* No title row: the selected tab immediately above already names this
          panel and carries its count, so the bar is only its controls. */}
      <div className={`flex items-center justify-end p-4 border-b ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
        <div className="flex items-center gap-2">
          {isAdmin && hasFits && (
            <button
              onClick={onScanTrails}
              title={t('observationDetail.subframesPanel.scanTrailsTitle')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                isDark
                  ? 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                  : 'border-amber-300 text-amber-600 hover:bg-amber-50'
              }`}
            >
              <Satellite className="w-3.5 h-3.5" />
              {t('observationDetail.subframesPanel.scanTrails')}
            </button>
          )}
          {hasFits && report && report.total > 0 && (isAdmin || report.measured > 0) && (
            <button
              onClick={() => setQualityOpen(o => !o)}
              aria-expanded={showQuality}
              title={t('observationDetail.subframesPanel.qualityTitle')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                showQuality
                  ? isDark
                    ? 'border-accent-500/50 bg-accent-500/10 text-accent-300'
                    : 'border-accent-400 bg-accent-50 text-accent-700'
                  : isDark
                    ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              {measuring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
              {t('observationDetail.subframesPanel.quality')}
              {report.measured > 0 && !measuring && (
                <span className="tabular-nums opacity-80">{report.accepted}/{report.total}</span>
              )}
            </button>
          )}
          {isAdmin && (
            <span
              title={!telescopeOnline ? t('observationDetail.subframesPanel.telescopeOfflineTitle') : t('observationDetail.subframesPanel.downloadFromTelescopeTitle')}
              className={!telescopeOnline ? 'cursor-not-allowed' : undefined}
            >
              <button
                onClick={onOpenSync}
                disabled={!telescopeOnline}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                  !telescopeOnline
                    ? isDark
                      ? 'border-slate-800 text-slate-600 cursor-not-allowed'
                      : 'border-slate-200 text-slate-300 cursor-not-allowed'
                    : isDark
                      ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                      : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                {t('observationDetail.subframesPanel.syncSubs')}
              </button>
            </span>
          )}
          {hasSubFrames && (
            <button
              onClick={onDownloadToComputer}
              disabled={archiveState !== 'idle'}
              title={
                archiveState === 'error'
                  ? t('observationDetail.subframesPanel.retryTitle')
                  : t('observationDetail.subframesPanel.zipToComputerTitle')
              }
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition disabled:cursor-wait ${
                archiveState === 'error'
                  ? isDark
                    ? 'border-red-500/30 text-red-400'
                    : 'border-red-300 text-red-600'
                  : isDark
                    ? 'border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              {archiveState === 'idle'
                ? t('observationDetail.subframesPanel.downloadToComputer')
                : archiveState === 'error'
                  ? t('observationDetail.subframesPanel.downloadFailed')
                  : t('observationDetail.subframesPanel.zipping', { done: archiveState.done, total: archiveState.total })}
            </button>
          )}
          {isAdmin && hasSubFrames && (
            <button
              onClick={onDeleteAllSubframes}
              title={t('observationDetail.subframesPanel.deleteAllTitle')}
              className={`p-1.5 rounded-lg transition ${isDark ? 'text-slate-600 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {showQuality && hasFits && (
        <SubframeQualityPanel objectId={objectId} date={date} isAdmin={isAdmin} />
      )}

      {subFrames.length > 0 ? (
        <>
          <div className="p-3">
            <div
              ref={subFramesRowRef}
              className="grid gap-1.5"
              // An explicit column count, rather than flex-wrap or auto-fill,
              // is what guarantees a single row: the tiles divide up whatever
              // width there is instead of overflowing onto a second line when
              // the measurement is a pixel off.
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {shownIndices.map(idx => {
                const file = subFrames[idx];
                const q = qualityByName.get(file.name);
                const frameTitle = t('observationDetail.subframesPanel.frameTitle', { name: file.name, index: idx + 1, total: subFrames.length });
                return (
                  <button
                    key={file.path}
                    onClick={() => onOpenGallery(idx, 'subframes')}
                    title={q?.grade
                      ? `${frameTitle} · ${t(`subframeQuality.grade.${q.grade}`)}${q.accepted ? '' : ` · ${t('observationDetail.subframesPanel.notKept')}`}`
                      : frameTitle}
                    className={`relative aspect-square rounded-lg overflow-hidden border-2 ${
                      isDark ? 'border-slate-700 hover:border-slate-500 bg-slate-800' : 'border-slate-200 hover:border-slate-400 bg-slate-100'
                    } ${q && !q.accepted ? 'opacity-50' : ''}`}
                  >
                    {q?.grade && (
                      <span
                        className={`absolute right-1 top-1 z-10 h-2 w-2 rounded-full ring-2 ${isDark ? 'ring-slate-900' : 'ring-white'} ${GRADE_BADGE[q.grade]}`}
                        aria-hidden="true"
                      />
                    )}
                    {file.type === 'fits' ? (
                      <FitsThumbnail url={file.downloadUrl} thumbUrl={file.thumbUrl} stretch={1.0} isDark={isDark} />
                    ) : (
                      <img
                        src={thumbSrcFor(file)}
                        alt={file.name}
                        className="w-full h-full object-cover"
                        onError={e => { if (e.target instanceof HTMLImageElement) e.target.style.display = 'none'; }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`px-4 py-2.5 border-t flex items-center justify-between gap-3 ${
            isDark ? 'border-slate-800' : 'border-slate-200'
          }`}>
            <span className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {hiddenCount > 0
                ? t('observationDetail.subframesPanel.showingSampled', { shown: shownIndices.length, total: subFrames.length })
                : t('observationDetail.subframesPanel.showingAll', { total: subFrames.length })}
            </span>
            <button
              onClick={() => onOpenGallery(0, 'subframes')}
              className={`flex items-center gap-1.5 text-xs font-medium transition flex-shrink-0 ${
                isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {hiddenCount > 0 ? t('observationDetail.subframesPanel.viewAll', { total: subFrames.length }) : t('observationDetail.subframesPanel.openViewer')}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </>
      ) : (
        <div className={`p-8 text-center ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
          {t('observationDetail.subframesPanel.empty')}
        </div>
      )}
    </div>
  );
}
