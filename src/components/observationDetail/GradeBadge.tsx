import { useTranslation } from 'react-i18next';
import { Check, AlertTriangle, XCircle } from 'lucide-react';
import type { SubFrameGradeLevel } from '../../lib/api/library';

/** A sub-frame grade as icon + label, so colour is never the only signal.
 *  Used by the quality table and the sub-frame viewer. */
export function GradeBadge({ grade, isDark }: { grade: SubFrameGradeLevel | null; isDark: boolean }) {
  const { t } = useTranslation('observations');
  if (!grade) return <span className={isDark ? 'text-slate-600' : 'text-slate-400'}>–</span>;
  const cls = grade === 'good'
    ? isDark ? 'text-emerald-400' : 'text-emerald-700'
    : grade === 'fair'
      ? isDark ? 'text-amber-400' : 'text-amber-700'
      : isDark ? 'text-red-400' : 'text-red-700';
  const Icon = grade === 'good' ? Check : grade === 'fair' ? AlertTriangle : XCircle;
  return (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(`subframeQuality.grade.${grade}`)}
    </span>
  );
}
