/** Class strings shared by the Library and Image Gallery toolbars. */

export const TOOLBAR_BTN = 'flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium whitespace-nowrap ring-1 ring-inset transition-colors';
export const POPOVER = 'absolute right-0 top-full mt-1.5 z-30 rounded-2xl border shadow-lg';

export function popoverSurface(isDark: boolean): string {
  return isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200';
}
