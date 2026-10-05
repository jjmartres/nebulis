import { useState, type ReactNode } from 'react';
import { ChevronDown, RotateCcw, X } from 'lucide-react';
import type { TypeFilter } from '../../lib/objectTypeFilters';

/** Shared building blocks for the Library and Image Gallery toolbars: one row of
 *  buttons, with every narrowing control inside a Filters popover. */

export function FilterSection({ title, isDark, children }: { title: string; isDark: boolean; children: ReactNode }) {
  return (
    <div>
      <div className={`mb-2 text-xs font-semibold uppercase tracking-wider ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{title}</div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function Pill({ active, isDark, onClick, children }: { active: boolean; isDark: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? isDark ? 'bg-accent-500/15 text-accent-400 ring-1 ring-inset ring-accent-500/30' : 'bg-accent-500 text-white'
          : isDark ? 'text-slate-400 ring-1 ring-inset ring-slate-700/60 hover:bg-slate-800 hover:text-slate-100' : 'text-slate-500 ring-1 ring-inset ring-slate-200 hover:bg-slate-100 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

export interface GroupChip { id: string; label: string; count: number }

interface TypeSectionProps {
  isDark: boolean;
  activeId: string;
  allId: string;
  groups: GroupChip[];
  types: TypeFilter[];
  onSelect: (id: string) => void;
  labels: { title: string; all: string; more: (count: number) => string; fewer: string };
}

/** Type filter: curated groups first, exact types behind a full-width toggle. */
export function TypeFilterSection({ isDark, activeId, allId, groups, types, onSelect, labels }: TypeSectionProps) {
  const [open, setOpen] = useState(false);
  // An exact type that is active must stay visible, so it pins the list open.
  const expanded = open || types.some(tf => tf.id === activeId);
  return (
    <FilterSection title={labels.title} isDark={isDark}>
      <Pill active={activeId === allId} isDark={isDark} onClick={() => onSelect(allId)}>{labels.all}</Pill>
      {groups.map(g => (
        <Pill key={g.id} active={activeId === g.id} isDark={isDark} onClick={() => onSelect(g.id)}>
          {g.label}
          <span className="opacity-60 text-xs">{g.count}</span>
        </Pill>
      ))}
      {types.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={expanded}
            className={`w-full flex items-center gap-1 pt-1.5 text-xs font-medium ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            {expanded ? labels.fewer : labels.more(types.length)}
          </button>
          {expanded && types.map(tf => (
            <Pill key={tf.id} active={activeId === tf.id} isDark={isDark} onClick={() => onSelect(tf.id)}>
              {tf.label}
              <span className="opacity-60 text-xs">{tf.count}</span>
            </Pill>
          ))}
        </>
      )}
    </FilterSection>
  );
}

export interface ActiveChip { key: string; label: string; clear: () => void }

/** Removable chips for whatever is currently narrowing the list. Renders nothing when empty. */
export function ActiveFilterChips({ chips, isDark, removeLabel, clearAllLabel, onClearAll }: {
  chips: ActiveChip[];
  isDark: boolean;
  removeLabel: (name: string) => string;
  clearAllLabel: string;
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap -mt-3">
      {chips.map(c => (
        <button
          key={c.key}
          type="button"
          onClick={c.clear}
          aria-label={removeLabel(c.label)}
          className={`inline-flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-full text-sm font-medium ring-1 ring-inset transition-colors ${
            isDark ? 'bg-accent-500/15 text-accent-400 ring-accent-500/30 hover:bg-accent-500/25' : 'bg-accent-50 text-accent-700 ring-accent-300 hover:bg-accent-100'
          }`}
        >
          {c.label}
          <X className="w-3.5 h-3.5" />
        </button>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className={`px-2 py-1 text-sm ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'}`}
      >
        {clearAllLabel}
      </button>
    </div>
  );
}

/** Top-right icon of a popover: puts every setting inside it back to its default. Dimmed when nothing differs. */
export function PopoverResetButton({ onReset, disabled, isDark, label }: { onReset: () => void; disabled: boolean; isDark: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onReset}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`absolute top-3 right-3 flex items-center justify-center w-7 h-7 rounded-full transition-colors disabled:opacity-30 disabled:cursor-default ${
        isDark ? 'text-slate-400 enabled:hover:bg-slate-800 enabled:hover:text-slate-100' : 'text-slate-500 enabled:hover:bg-slate-100 enabled:hover:text-slate-800'
      }`}
    >
      <RotateCcw className="w-4 h-4" />
    </button>
  );
}
