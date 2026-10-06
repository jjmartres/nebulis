/**
 * The choice a delete dialog offers when the object or night has files in a linked folder.
 *
 * Off by default: deleting drops the item from Nebulis and leaves the originals where they
 * are. Ticking it also deletes those files from the user's disk, which cannot be undone
 * because Nebulis holds no copy. Renders nothing when there is nothing linked to choose about.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getLinkedFilesSummary } from '../../lib/api/library';
import { formatBytes } from '../../lib/utils';
import { useTheme } from '../../hooks/useTheme';

export function LinkedFilesChoice({
  objectId, date, checked, onChange,
}: {
  objectId: string;
  date?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { isDark } = useTheme();
  const { t } = useTranslation('library');
  const { data } = useQuery({
    queryKey: ['linked-files-summary', objectId, date ?? null],
    queryFn: () => getLinkedFilesSummary(objectId, date),
  });
  if (!data || data.files === 0) return null;

  return (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${
        isDark ? 'border-red-500/30 bg-red-500/5 text-slate-300' : 'border-red-200 bg-red-50 text-slate-700'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
      />
      <span className="space-y-1">
        <span className="block font-medium">
          {t('linkedFilesChoice.label', { count: data.files, size: formatBytes(data.bytes) })}
        </span>
        <span className={`block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          {t('linkedFilesChoice.help', { folders: data.folders.join(', ') })}
        </span>
      </span>
    </label>
  );
}
