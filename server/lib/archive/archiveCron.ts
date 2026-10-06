/**
 * A five-field cron matcher, in-repo on purpose.
 *
 * The alternative was a dependency, and this app already runs its own one-minute tick
 * loop for the archive, so the only thing missing was the expression itself. Keeping it
 * here means the matching rules are visible and tested against the cases that matter
 * rather than trusted.
 *
 * What is supported, and nothing else:
 *
 *   - five fields: minute, hour, day of month, month, day of week
 *   - `*`, a number, `a-b`, `a,b,c`, and a step on any of those (as in every 15 minutes,
 *     written as a star, a slash and 15)
 *   - day of week `0` or `7` for Sunday
 *
 * Deliberately not supported: `@daily` and friends, names (`JAN`, `MON`), `?`, `L` and
 * `W`. Each of those is a different dialect, and a matcher that silently ignores what it
 * does not understand would either never fire or fire at the wrong time. An expression
 * using them is refused with a reason the settings page can show.
 *
 * Two things are accepted because they are what cron accepts, and are worth knowing
 * about rather than being surprising later:
 *
 *   - A day of the month the month cannot have (`0 0 31 2 *`) is valid and never fires.
 *     Only February is checked against the calendar indirectly, by the date the caller
 *     passes: nothing here refuses a date combination that comes round rarely or never.
 *   - A minute whose tick is missed is missed. The expression names minutes, not
 *     deadlines, so a process that was asleep across its minute waits for the next one.
 *     Daily and interval schedules catch up instead; custom deliberately does not.
 *
 * The day-of-month and day-of-week interaction follows the original cron rule, which
 * surprises people but is what a cron expression means: when both are restricted, the day
 * matches if either one does.
 */

import { localParts } from '../timezone.js';

export interface ParsedCron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** Whether each day field was restricted, which is what selects the OR rule. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export type CronParseResult = { ok: true; cron: ParsedCron } | { ok: false; reason: string };

const FIELD_RANGES: Array<{ label: string; min: number; max: number }> = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  { label: 'day of week', min: 0, max: 7 },
];

/** The values one field names, or a reason it could not be read. */
function parseField(raw: string, min: number, max: number, label: string): { ok: true; values: Set<number> } | { ok: false; reason: string } {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (part === '') return { ok: false, reason: `the ${label} field has an empty part` };

    const segments = part.split('/');
    // `*/15/3` is not a step of a step in any dialect. Refused rather than read as
    // `*/15`, which would run four times a day where the user asked for something else.
    if (segments.length > 2) return { ok: false, reason: `the ${label} field has more than one step` };
    const [range, stepText] = segments;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return { ok: false, reason: `the ${label} field has a step that is not a number` };
      step = Number(stepText);
      if (step < 1) return { ok: false, reason: `the ${label} field has a step of 0` };
    }

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (/^\d+$/.test(range)) {
      from = Number(range);
      // A bare number with a step means "from here to the end of the range", which is
      // what `5/10` means in every cron dialect.
      to = stepText === undefined ? from : max;
    } else if (/^\d+-\d+$/.test(range)) {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b;
      if (from > to) return { ok: false, reason: `the ${label} field has a range that counts backwards` };
    } else {
      return { ok: false, reason: `the ${label} field is not a number, a range, a list or a step` };
    }

    if (from < min || to > max) {
      return { ok: false, reason: `the ${label} field must be between ${min} and ${max}` };
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { ok: true, values };
}

/** Parse an expression, or say what is wrong with it, in words the settings page shows. */
export function parseCron(expression: string): CronParseResult {
  const trimmed = expression.trim();
  if (trimmed === '') return { ok: false, reason: 'a custom schedule needs a cron expression' };
  if (trimmed.startsWith('@')) {
    return { ok: false, reason: 'named schedules such as @daily are not supported; write the five fields' };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, reason: `a cron expression has five fields, and this has ${fields.length}` };
  }

  const parsed: Array<Set<number>> = [];
  for (let i = 0; i < FIELD_RANGES.length; i++) {
    const { label, min, max } = FIELD_RANGES[i];
    const field = parseField(fields[i], min, max, label);
    if (!field.ok) return field;
    parsed.push(field.values);
  }

  // Sunday is 0 and 7 in the wild, so both mean the same day here.
  const dayOfWeek = new Set(parsed[4]);
  if (dayOfWeek.has(7)) {
    dayOfWeek.delete(7);
    dayOfWeek.add(0);
  }

  return {
    ok: true,
    cron: {
      minute: parsed[0],
      hour: parsed[1],
      dayOfMonth: parsed[2],
      month: parsed[3],
      dayOfWeek,
      dayOfMonthRestricted: fields[2] !== '*',
      dayOfWeekRestricted: fields[4] !== '*',
    },
  };
}

/** Whether an expression is usable. Convenience for the config layer's validation. */
export function isValidCron(expression: string): boolean {
  return parseCron(expression).ok;
}

/** Whether the expression names this minute, in `timeZone` (the server's local time). */
export function cronMatches(cron: ParsedCron, date: Date, timeZone?: string | null): boolean {
  const p = localParts(date, timeZone);
  if (!cron.minute.has(p.minute)) return false;
  if (!cron.hour.has(p.hour)) return false;
  if (!cron.month.has(p.month)) return false;

  // The weekday of the local calendar date, read through UTC so the lookup cannot be
  // shifted by the timezone it was derived from.
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const dayOfMonthHit = cron.dayOfMonth.has(p.day);
  const dayOfWeekHit = cron.dayOfWeek.has(weekday);

  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dayOfMonthHit || dayOfWeekHit;
  if (cron.dayOfMonthRestricted) return dayOfMonthHit;
  if (cron.dayOfWeekRestricted) return dayOfWeekHit;
  return true;
}

/** Parse and match in one step, for callers that already know the expression is valid. */
export function cronExpressionMatches(expression: string, date: Date, timeZone?: string | null): boolean {
  const parsed = parseCron(expression);
  return parsed.ok ? cronMatches(parsed.cron, date, timeZone) : false;
}
