import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../../src/i18n';
import { ImagingWindow } from '../../src/components/forecast/ImagingWindow';
import enForecast from '../../src/locales/en/forecast.json';
import type { ForecastHour } from '../../src/lib/api/planner';

/**
 * Render-level checks, via react-dom/server rather than a testing library (the
 * repo has no @testing-library/react). The Moon column is the reason these
 * exist: the ported version repeated one illumination figure on every row and
 * warned about a "Bright Moon" all night, so a 92% Moon that set at 22:00 was
 * still being flagged at 04:00.
 */
const COPY = enForecast.imagingWindow;

/** `at('20:00')` is 20:00 on the 14th; `at('02:00', '15')` is 02:00 the next day. */
const at = (hhmm: string, day: '14' | '15' = '14') => `2026-03-${day}T${hhmm}:00.000Z`;

/** 20:00 through 05:00, one row per hour. */
function nightHours(): ForecastHour[] {
  const times: Array<[string, '14' | '15']> = [
    ['20:00', '14'], ['21:00', '14'], ['22:00', '14'], ['23:00', '14'],
    ['00:00', '15'], ['01:00', '15'], ['02:00', '15'], ['03:00', '15'],
    ['04:00', '15'], ['05:00', '15'],
  ];
  return times.map(([h, d]) => ({
    time: at(h, d),
    cloudCover: 10, cloudCoverLow: 10, cloudCoverMid: 10, cloudCoverHigh: 10,
    seeing: 2, transparency: 0.8, humidity: 60, temperature: 5, dewPoint: -2,
    wind: 8, visibility: 20, precipProb: 0, jetStream: 20, cape: 0,
  }));
}

const BASE = {
  moonIllumination: 92,
  sunset: at('18:30'),
  sunrise: at('06:30', '15'),
  astronomicalTwilightEnd: at('20:00'),
  astronomicalTwilightStart: at('05:00', '15'),
  nauticalTwilightEnd: at('19:00'),
  nauticalTwilightStart: at('06:00', '15'),
};

type Tonight = typeof BASE & { moonRise: string | null; moonSet: string | null };

function render(tonight: Tonight): string {
  return renderToStaticMarkup(
    <ImagingWindow
      hours={nightHours()}
      tonight={tonight}
      timeZone="UTC"
      darkWindow={null}
      tempUnit="celsius"
      windUnit="kmh"
      isDark={false}
    />,
  );
}

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

/** react-dom escapes apostrophes and quotes in the markup it emits. */
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

/** Recent ICU inserts a narrow no-break space before AM/PM; normalize it so the
 *  assertions below can use ordinary spaces. */
const norm = (s: string) => s.replace(/[\u202F\u00A0]/g, ' ');

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ImagingWindow', () => {
  it('renders the heading, the window bounds and every column', () => {
    const html = norm(render({ ...BASE, moonRise: at('02:00', '15'), moonSet: at('22:00') }));
    expect(html).toContain(escaped(COPY.title));
    expect(html).toContain(escaped(COPY.astronomicalDark));
    for (const col of [
      COPY.colTime, COPY.colScore, COPY.colClouds, COPY.colSeeing,
      COPY.colMoon, COPY.colHumidity, COPY.colWind, COPY.colTemp, COPY.colDew,
    ]) {
      expect(html, col).toContain(col);
    }
    // 8:00 PM through 5:00 AM, which is the nine hours the badge claims.
    expect(html).toContain('8:00 PM');
    expect(html).toContain('5:00 AM');
    expect(html).toContain(COPY.durationHours.replace('{{hours}}', '9'));
  });

  it('marks the moonless rows as down and leaves the moonlit ones alone', () => {
    // Up until 22:00, then down until it rises again at 02:00: exactly three
    // rows (23:00, 00:00, 01:00) are moonless. Both ends of each span count as
    // up, so the 22:00 row (the hour it sets) is not one of them.
    const html = render({ ...BASE, moonRise: at('02:00', '15'), moonSet: at('22:00') });
    expect(countOf(html, `>${COPY.moonDown}<`)).toBe(3);
  });

  it('does NOT warn about a bright Moon that is never up during the window', () => {
    // The regression: 92% illuminated, but up only in daylight.
    const html = render({ ...BASE, moonRise: at('08:00'), moonSet: at('17:00') });
    expect(html).not.toContain(COPY.brightMoon);
    expect(html).toContain(COPY.moonDownAllWindow);
    expect(countOf(html, `>${COPY.moonDown}<`)).toBe(10);
  });

  it('does warn when a bright Moon really is up during the window', () => {
    const html = norm(render({ ...BASE, moonRise: at('02:00', '15'), moonSet: at('22:00') }));
    expect(html).toContain(COPY.brightMoon);
    expect(html).not.toContain(COPY.moonDownAllWindow);
  });

  it('describes a Moon that sets and rises again as two stretches, not one', () => {
    // Up at dusk, sets at 22:00, back up at 02:00. Saying "up from 8:00 PM to
    // 5:00 AM" would over-claim exactly as the old footer did.
    const html = norm(render({ ...BASE, moonRise: at('02:00', '15'), moonSet: at('22:00') }));
    expect(html).toContain(
      COPY.moonUpSplit.replace('{{until}}', '10:00 PM').replace('{{from}}', '2:00 AM'),
    );
    // And not the single-range phrasing, which would read as continuous.
    expect(html).not.toContain(COPY.moonUpDuring.split('{{')[0].trim());
  });

  it('describes a single moonlit stretch as one range', () => {
    // Rises at 23:00 and stays up for the rest of the window.
    const html = norm(render({ ...BASE, moonRise: at('23:00'), moonSet: null }));
    expect(html).toContain(
      COPY.moonUpDuring.replace('{{from}}', '11:00 PM').replace('{{to}}', '5:00 AM'),
    );
    expect(html).not.toContain(COPY.moonUpSplit.split('{{')[0].trim());
  });

  it('makes no claim about the Moon when its rise and set are unknown', () => {
    const html = render({ ...BASE, moonRise: null, moonSet: null });
    expect(html).not.toContain(COPY.brightMoon);
    expect(html).not.toContain(COPY.moonDownAllWindow);
    expect(html).toContain(COPY.moonTimesUnknown);
    // Illumination is still shown, just without an up/down claim.
    expect(countOf(html, `>${COPY.moonDown}<`)).toBe(0);
  });

  it('renders nothing when the twilight window is inverted', () => {
    const html = renderToStaticMarkup(
      <ImagingWindow
        hours={nightHours()}
        tonight={{
          ...BASE,
          astronomicalTwilightEnd: at('05:00', '15'),
          astronomicalTwilightStart: at('20:00'),
          nauticalTwilightEnd: null,
          nauticalTwilightStart: null,
          moonRise: null,
          moonSet: null,
        }}
        timeZone="UTC"
        darkWindow={null}
        tempUnit="celsius"
        windUnit="kmh"
        isDark={false}
      />,
    );
    expect(html).toBe('');
  });

  it('renders nothing when the window holds fewer than two hours', () => {
    const html = renderToStaticMarkup(
      <ImagingWindow
        hours={[nightHours()[0]]}
        tonight={{ ...BASE, moonRise: null, moonSet: null }}
        timeZone="UTC"
        darkWindow={null}
        tempUnit="celsius"
        windUnit="kmh"
        isDark={false}
      />,
    );
    expect(html).toBe('');
  });

  it('labels the nautical fallback as nautical, not astronomical', () => {
    const html = renderToStaticMarkup(
      <ImagingWindow
        hours={nightHours()}
        tonight={{
          ...BASE,
          astronomicalTwilightEnd: null,
          astronomicalTwilightStart: null,
          moonRise: null,
          moonSet: null,
        }}
        timeZone="UTC"
        darkWindow={null}
        tempUnit="celsius"
        windUnit="kmh"
        isDark={false}
      />,
    );
    expect(html).toContain(COPY.nauticalDark);
    expect(html).not.toContain(COPY.astronomicalDark);
  });
});
