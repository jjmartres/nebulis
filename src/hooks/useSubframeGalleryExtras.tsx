import { useMemo } from 'react';
import type { GalleryItem, GalleryItemExtras } from '../components/GalleryModal';
import { SubframeQualityBar } from '../components/observationDetail/SubframeQualityBar';
import type { SubFrameQualityRow } from '../lib/api/library';
import { useSubFrameQuality, useSubFrameReview } from './useSubFrameQuality';

const GRADE_DOT: Record<NonNullable<SubFrameQualityRow['grade']>, string> = {
  good: 'bg-emerald-500',
  fair: 'bg-amber-500',
  poor: 'bg-red-500',
};

/**
 * What the sub-frame viewer adds to each frame once the night has a quality
 * report: the measurements and Keep under the picture, a grade dot on each
 * strip tile, dimmed tiles for subs that are not kept, and K to toggle Keep.
 *
 * Undefined while there is no report, so the viewer is unchanged for nights
 * without FITS subs or before anyone has measured them.
 */
export function useSubframeGalleryExtras(
  objectId: string,
  date: string,
  enabled: boolean,
  isAdmin: boolean,
): GalleryItemExtras | undefined {
  const { data: report } = useSubFrameQuality(objectId, date, enabled);
  const review = useSubFrameReview(objectId, date);

  return useMemo(() => {
    if (!enabled || !report || report.total === 0) return undefined;
    const byPath = new Map<string, SubFrameQualityRow>();
    const byName = new Map<string, SubFrameQualityRow>();
    for (const f of report.frames) {
      byPath.set(f.relPath, f);
      byName.set(f.fileName, f);
    }
    const rowFor = (item: GalleryItem) =>
      item.kind === 'file' ? byPath.get(item.file.path) ?? byName.get(item.file.name) : undefined;
    const reviewable = (row: SubFrameQualityRow | undefined): row is SubFrameQualityRow =>
      !!row && (row.measured || !!row.error);

    return {
      info: item => item.kind === 'file'
        ? <SubframeQualityBar row={rowFor(item)} isAdmin={isAdmin} onReview={review} />
        : null,
      thumbBadge: item => {
        const row = rowFor(item);
        if (!row?.measured || !row.grade) return null;
        return (
          <span
            aria-hidden="true"
            className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-slate-950 ${GRADE_DOT[row.grade]}`}
          />
        );
      },
      dimmed: item => {
        const row = rowFor(item);
        return reviewable(row) && !row.accepted;
      },
      onToggleKeep: isAdmin
        ? item => {
          const row = rowFor(item);
          // A failed request is visible as the box flipping back on refetch.
          if (reviewable(row)) void review(row, row.accepted).catch(() => {});
        }
        : undefined,
    };
  }, [enabled, report, isAdmin, review]);
}
