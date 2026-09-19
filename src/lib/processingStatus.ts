/**
 * Shared constants for `ProcessingStatus` (unprocessed → processing →
 * processed). Split out of `ProcessingStatusBadge.tsx` (not colocated with
 * it) because a component file that exports anything besides components
 * trips `react-refresh/only-export-components` — the same reason
 * `telescopeFov.ts`'s pure logic lives apart from `FitBadge.tsx`.
 */
import type { ProcessingStatus } from '../types';

/** Display order for any UI that lists all three (dropdowns, filters). */
export const PROCESSING_STATUS_ORDER: ProcessingStatus[] = ['unprocessed', 'processing', 'processed'];

export const PROCESSING_STATUS_LABEL: Record<ProcessingStatus, string> = {
  unprocessed: 'Unprocessed',
  processing: 'Processing',
  processed: 'Processed',
};
