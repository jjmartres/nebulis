/**
 * Shared display-order constant for `ProcessingStatus` (unprocessed →
 * processing → processed). Labels are resolved through i18n at each call
 * site (a plain lib function that builds translated text takes `t`
 * explicitly) rather than baked in here, so this
 * file stays pure display-order logic, the same reason telescopeFov.ts's
 * pure logic lives apart from FitBadge.tsx.
 */
import type { ProcessingStatus } from '../types';

export const PROCESSING_STATUS_ORDER: ProcessingStatus[] = ['unprocessed', 'processing', 'processed'];

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export function processingStatusLabel(status: ProcessingStatus, t: TFunc): string {
  return t(`processingStatus.${status}`);
}
