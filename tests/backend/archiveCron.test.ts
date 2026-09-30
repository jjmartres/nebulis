import { describe, it, expect } from 'vitest';
import { parseCron, isValidCron, cronMatches, cronExpressionMatches } from '../../server/lib/archive/archiveCron.js';

/** A UTC date, so the assertions do not depend on the machine's timezone. */
const utc = (text: string) => new Date(text);

const parse = (expression: string) => {
  const parsed = parseCron(expression);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.cron;
};

describe('parseCron', () => {
  it('reads the five usual shapes', () => {
    const cron = parse('30 2 * * *');
    expect([...cron.minute]).toEqual([30]);
    expect([...cron.hour]).toEqual([2]);
    expect(cron.dayOfMonth.size).toBe(31);
    expect(cron.month.size).toBe(12);
    expect(cron.dayOfWeek.size).toBe(7);
    expect(cron.dayOfMonthRestricted).toBe(false);
    expect(cron.dayOfWeekRestricted).toBe(false);
  });

  it('reads a step across a whole field', () => {
    const cron = parse('*/15 * * * *');
    expect([...cron.minute]).toEqual([0, 15, 30, 45]);
  });

  it('reads a step across a range', () => {
    const cron = parse('0 1-9/2 * * *');
    expect([...cron.hour]).toEqual([1, 3, 5, 7, 9]);
  });

  it('reads a bare number with a step as "from here to the end"', () => {
    const cron = parse('0 5/6 * * *');
    expect([...cron.hour]).toEqual([5, 11, 17, 23]);
  });

  it('reads a list', () => {
    const cron = parse('0,30 8,12,18 * * *');
    expect([...cron.minute]).toEqual([0, 30]);
    expect([...cron.hour]).toEqual([8, 12, 18]);
  });

  it('treats 7 as Sunday, the same as 0', () => {
    expect([...parse('0 0 * * 7').dayOfWeek]).toEqual([0]);
    expect([...parse('0 0 * * 0').dayOfWeek]).toEqual([0]);
  });

  it('marks each day field restricted only when it says something', () => {
    expect(parse('0 0 * * 1').dayOfMonthRestricted).toBe(false);
    expect(parse('0 0 * * 1').dayOfWeekRestricted).toBe(true);
    expect(parse('0 0 1 * *').dayOfMonthRestricted).toBe(true);
    expect(parse('0 0 1 * 1').dayOfMonthRestricted).toBe(true);
    expect(parse('0 0 1 * 1').dayOfWeekRestricted).toBe(true);
  });

  it('refuses an expression of the wrong length', () => {
    const parsed = parseCron('0 2 * *');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toContain('five fields');
  });

  it('refuses an empty expression', () => {
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('   ')).toBe(false);
  });

  it('refuses the named macros rather than guessing at them', () => {
    const parsed = parseCron('@daily');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toContain('@daily');
  });

  it('refuses the dialects it does not implement', () => {
    expect(isValidCron('? * * * *')).toBe(false);
    expect(isValidCron('0 0 L * *')).toBe(false);
    expect(isValidCron('0 0 15W * *')).toBe(false);
    expect(isValidCron('0 0 * JAN *')).toBe(false);
    expect(isValidCron('0 0 * * MON')).toBe(false);
  });

  it('refuses out-of-range values and backwards ranges', () => {
    expect(isValidCron('60 0 * * *')).toBe(false);
    expect(isValidCron('0 24 * * *')).toBe(false);
    expect(isValidCron('0 0 0 * *')).toBe(false);
    expect(isValidCron('0 0 32 * *')).toBe(false);
    expect(isValidCron('0 0 * 13 *')).toBe(false);
    expect(isValidCron('0 0 * * 8')).toBe(false);
    expect(isValidCron('0 20-10 * * *')).toBe(false);
  });

  it('refuses a step of zero and an unreadable part', () => {
    expect(isValidCron('*/0 * * * *')).toBe(false);
    expect(isValidCron('*/x * * * *')).toBe(false);
    expect(isValidCron('0,,1 * * * *')).toBe(false);
  });

  it('refuses a second step rather than reading it as the first', () => {
    // `*/15/3` has no meaning in any dialect. Reading it as `*/15` would run four
    // times a day where the user asked for something the settings page cannot explain.
    const parsed = parseCron('*/15/3 * * * *');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toContain('minute');
    expect(isValidCron('0 2/3/4 * * *')).toBe(false);
  });

  it('names the field in the reason, so the settings page can say which one is wrong', () => {
    const parsed = parseCron('0 0 * 13 *');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.reason).toContain('month');
    expect(parsed.reason).toContain('1 and 12');
  });
});

describe('cronMatches', () => {
  it('matches a daily expression at its minute and not the minutes around it', () => {
    const cron = parse('30 2 * * *');
    expect(cronMatches(cron, utc('2026-03-11T02:30:00Z'), 'UTC')).toBe(true);
    expect(cronMatches(cron, utc('2026-03-11T02:29:00Z'), 'UTC')).toBe(false);
    expect(cronMatches(cron, utc('2026-03-11T03:30:00Z'), 'UTC')).toBe(false);
  });

  it('holds each minute of a step expression', () => {
    const cron = parse('*/15 * * * *');
    expect(cronMatches(cron, utc('2026-03-11T09:00:00Z'), 'UTC')).toBe(true);
    expect(cronMatches(cron, utc('2026-03-11T09:15:00Z'), 'UTC')).toBe(true);
    expect(cronMatches(cron, utc('2026-03-11T09:07:00Z'), 'UTC')).toBe(false);
  });

  it('reads the calendar day in the schedule timezone, not UTC', () => {
    // 23:30 in New York on the 10th is 03:30 UTC on the 11th. A cron that fires at
    // 23:30 on the 10th must match, and one that fires on the 11th must not.
    const tenth = utc('2026-03-11T03:30:00Z');
    expect(cronExpressionMatches('30 23 10 * *', tenth, 'America/New_York')).toBe(true);
    expect(cronExpressionMatches('30 23 11 * *', tenth, 'America/New_York')).toBe(false);
  });

  it('reads the weekday in the schedule timezone too', () => {
    // 00:30 UTC on the 11th is 20:30 on Tuesday the 10th in New York, and the US
    // moved to daylight time on the 8th, so it is four hours behind rather than five.
    const lateTuesday = utc('2026-03-11T00:30:00Z');
    expect(cronExpressionMatches('30 20 * * 2', lateTuesday, 'America/New_York')).toBe(true);
    expect(cronExpressionMatches('30 20 * * 3', lateTuesday, 'America/New_York')).toBe(false);
  });

  it('matches either day field when both are restricted, the way cron does', () => {
    // The 13th of March 2026 is a Friday. This fires on the 1st or on any Friday.
    expect(cronExpressionMatches('0 0 1 * 5', utc('2026-03-13T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 0 1 * 5', utc('2026-05-01T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 0 1 * 5', utc('2026-03-12T00:00:00Z'), 'UTC')).toBe(false);
  });

  it('requires both day fields when only one is restricted', () => {
    // Restricted day of month alone: the 13th, whatever weekday it is.
    expect(cronExpressionMatches('0 0 13 * *', utc('2026-03-13T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 0 13 * *', utc('2026-03-14T00:00:00Z'), 'UTC')).toBe(false);
    // Restricted weekday alone: any Friday.
    expect(cronExpressionMatches('0 0 * * 5', utc('2026-03-13T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 0 * * 5', utc('2026-03-12T00:00:00Z'), 'UTC')).toBe(false);
  });

  it('matches every day when neither day field is restricted', () => {
    expect(cronExpressionMatches('0 4 * * *', utc('2026-03-13T04:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 4 * * *', utc('2026-03-14T04:00:00Z'), 'UTC')).toBe(true);
  });

  it('honours a month restriction', () => {
    expect(cronExpressionMatches('0 4 1 6 *', utc('2026-06-01T04:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 4 1 6 *', utc('2026-07-01T04:00:00Z'), 'UTC')).toBe(false);
  });

  it('honours the end of a month, which is where a day-of-month rule goes wrong', () => {
    // 30 June is day 30 of 30; 1 July is day 1 of 31. An off-by-one in the day
    // comparison shows up here and nowhere else.
    expect(cronExpressionMatches('0 4 30 6 *', utc('2026-06-30T04:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 4 30 6 *', utc('2026-07-01T04:00:00Z'), 'UTC')).toBe(false);
    expect(cronExpressionMatches('0 4 31 1 *', utc('2026-01-31T04:00:00Z'), 'UTC')).toBe(true);
    expect(cronExpressionMatches('0 4 31 1 *', utc('2026-02-01T04:00:00Z'), 'UTC')).toBe(false);
  });

  it('matches 29 February in a leap year and no day at all in a common one', () => {
    expect(cronExpressionMatches('0 4 29 2 *', utc('2028-02-29T04:00:00Z'), 'UTC')).toBe(true);

    // The whole of February 2026 has 28 days, so a rule naming the 29th must never
    // fire in it. Checked day by day rather than at one instant, because a matcher
    // that ignored the month would still look correct at a single date.
    const fired: string[] = [];
    for (let day = 1; day <= 28; day++) {
      const date = utc(`2026-02-${String(day).padStart(2, '0')}T04:00:00Z`);
      if (cronExpressionMatches('0 4 29 2 *', date, 'UTC')) fired.push(date.toISOString());
    }
    expect(fired).toEqual([]);
  });

  it('accepts a day of the month the month cannot have, and never fires on it', () => {
    // Standard cron accepts this, and so does this matcher: refusing it would need a
    // calendar rule for every month, and February is already handled by the date the
    // caller passes. Pinned here so the behaviour is a decision rather than a surprise.
    expect(isValidCron('0 0 31 2 *')).toBe(true);
    const fired: string[] = [];
    for (let day = 1; day <= 28; day++) {
      const date = utc(`2026-02-${String(day).padStart(2, '0')}T00:00:00Z`);
      if (cronExpressionMatches('0 0 31 2 *', date, 'UTC')) fired.push(date.toISOString());
    }
    expect(fired).toEqual([]);
  });

  it('returns false rather than throwing on an expression it cannot parse', () => {
    expect(cronExpressionMatches('@daily', utc('2026-03-13T04:00:00Z'), 'UTC')).toBe(false);
    expect(cronExpressionMatches('', utc('2026-03-13T04:00:00Z'), 'UTC')).toBe(false);
  });
});
