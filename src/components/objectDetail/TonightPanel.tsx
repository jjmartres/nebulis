/**
 * Whether you can shoot this target tonight, and when in the year it is worth
 * shooting at all.
 *
 * This is the question the object page never answered. Everything it showed was
 * a record of the past: nights already captured and catalog numbers. The one
 * thing you come to an imaged target for, "can I add to this tonight?", meant
 * leaving for the Planner and searching for the object again. The Catalogs
 * modal already answers it for objects you have never shot; this brings the
 * same answer to the ones you have.
 *
 * Everything here is computed in the browser from the object's coordinates and
 * the active observing site, with no server round-trip.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, MapPin, Telescope } from 'lucide-react';
import { AltitudeChart } from '../AltitudeChart';
import { SitePicker } from '../SitePicker';
import { Fact, FactGrid, PanelEmpty, SessionPanel } from '../ui/Panel';
import { computeAltitudeCurve } from '../../lib/altaz';
import { computeBestImagingWindow } from '../../lib/bestImagingWindow';
import { nightWindowFor, plannerToday } from '../../lib/nightWindow';
import { useTheme } from '../../hooks/useTheme';
import { getSites, type ObservingSite } from '../../lib/api/sites';
import { formatHm } from '../../lib/timeFormat';

interface Props {
  /** Decimal hours. Null when the catalog has no coordinates for this object. */
  raHours: number | null;
  /** Decimal degrees. */
  decDegrees: number | null;
  site: ObservingSite | null | undefined;
}

function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function TonightPanel({ raHours, decDegrees, site: activeSite }: Props) {
  const { t } = useTranslation('library');
  const { isDark, isNight, isSpace } = useTheme();
  const accentText = isNight ? 'text-red-400' : isSpace ? 'text-violet-400' : 'text-accent-500';

  // Previewing a different site here is local to this panel and never
  // touches the app-wide active site (Planner/Forecast) — you're asking "how
  // would this look from my dark-sky site tonight", not relocating yourself.
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: getSites });
  const [previewSiteId, setPreviewSiteId] = useState<string | null>(null);
  // ObjectDetail doesn't remount this panel when navigating between objects
  // (same route, just a changed :objectId param), so without this a preview
  // picked on one object would silently leak into the next. Render-phase reset
  // (not an effect) so the stale preview never renders for a frame.
  const [coordSeed, setCoordSeed] = useState(`${raHours},${decDegrees}`);
  if (coordSeed !== `${raHours},${decDegrees}`) {
    setCoordSeed(`${raHours},${decDegrees}`);
    setPreviewSiteId(null);
  }
  const site = (previewSiteId && sites.find(s => s.id === previewSiteId)) || activeSite;

  const lat = site?.latitude ?? null;
  const lon = site?.longitude ?? null;
  const minAlt = site?.minAlt ?? 20;
  const hasEverything = raHours != null && decDegrees != null && lat != null && lon != null;

  /**
   * Tonight, sampled across astronomical darkness only. Sampling the whole
   * noon-to-noon window instead would report a peak that happens in daylight,
   * which is true and useless.
   */
  const tonight = useMemo(() => {
    if (!hasEverything) return null;
    const night = nightWindowFor(plannerToday(), lat, lon);
    if (!night) return { night: null, peakAlt: null, peakAt: null, minutesAbove: 0 };

    const samples = computeAltitudeCurve(raHours, decDegrees, lat, lon, night.start, night.end, 5);
    let peakAlt = -90;
    let peakAt: Date | null = null;
    let above = 0;
    for (const s of samples) {
      if (s.alt > peakAlt) { peakAlt = s.alt; peakAt = s.time; }
      if (s.alt >= minAlt) above += 5;
    }
    return { night, peakAlt, peakAt, minutesAbove: above };
  }, [hasEverything, raHours, decDegrees, lat, lon, minAlt]);

  const season = useMemo(() => {
    if (!hasEverything) return null;
    return computeBestImagingWindow(raHours, decDegrees, lat, lon, minAlt);
  }, [hasEverything, raHours, decDegrees, lat, lon, minAlt]);

  if (raHours == null || decDegrees == null) {
    return (
      <SessionPanel title={t('objectDetail.tonightPanel.title')} icon={Telescope}>
        <PanelEmpty>
          {t('objectDetail.tonightPanel.noCoords')}
        </PanelEmpty>
      </SessionPanel>
    );
  }

  if (lat == null || lon == null) {
    return (
      <SessionPanel title={t('objectDetail.tonightPanel.title')} icon={Telescope}>
        <PanelEmpty>
          <span className="inline-flex flex-wrap items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            <Trans
              i18nKey="objectDetail.tonightPanel.setSite"
              ns="library"
              components={{
                1: <Link to="/settings?tab=sky" className="font-medium underline underline-offset-2" />,
              }}
            />
          </span>
        </PanelEmpty>
      </SessionPanel>
    );
  }

  const peakAlt = tonight?.peakAlt ?? null;
  const peakAt = tonight?.peakAt ?? null;
  const noDarkness = tonight?.night === null;
  // Above the horizon at all is a different question from above the altitude
  // you would actually image at, and both are worth saying.
  const up = peakAlt != null && peakAlt > 0;
  const worthIt = tonight != null && tonight.minutesAbove > 0;

  return (
    <SessionPanel
      title={t('objectDetail.tonightPanel.title')}
      icon={Telescope}
      aside={
        sites.length > 1 ? (
          <SitePicker
            isDark={isDark}
            accentText={accentText}
            sites={sites}
            currentSite={site ?? null}
            fallbackLabel={site?.name ?? t('objectDetail.tonightPanel.chooseSite')}
            onSelect={id => setPreviewSiteId(id)}
          />
        ) : (
          <span className={`truncate text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {site?.name}
          </span>
        )
      }
    >
      <div className={`flex items-start gap-2 text-[13px] ${
        worthIt
          ? (isDark ? 'text-slate-200' : 'text-slate-800')
          : (isDark ? 'text-slate-400' : 'text-slate-500')
      }`}>
        {worthIt
          ? <Eye className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          : <EyeOff className={`mt-0.5 h-4 w-4 shrink-0 ${isDark ? 'text-slate-600' : 'text-slate-300'}`} />}
        <p>
          {noDarkness ? (
            t('objectDetail.tonightPanel.noDarkness')
          ) : worthIt && peakAt ? (
            // site's timezone, not the viewer's — a plan made for a remote site is read in that site's night
            <Trans
              i18nKey="objectDetail.tonightPanel.climbsTo"
              ns="library"
              values={{ deg: Math.round(peakAlt!), time: formatHm(peakAt, site?.timezone) }}
              components={{
                1: <span className="font-semibold tabular-nums" />,
                3: <span className="font-semibold tabular-nums" />,
              }}
            />
          ) : up ? (
            t('objectDetail.tonightPanel.risesButLow', { minAlt })
          ) : (
            t('objectDetail.tonightPanel.belowHorizon')
          )}
        </p>
      </div>

      {!noDarkness && (
        <div className="mt-4">
          <AltitudeChart
            ra={raHours}
            dec={decDegrees}
            lat={lat}
            lon={lon}
            minAlt={minAlt}
            timeZone={site?.timezone}
            isDark={isDark}
          />
        </div>
      )}

      <FactGrid className={`mt-4 border-t pt-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <Fact
          label={t('objectDetail.tonightPanel.aboveLabel', { minAlt })}
          value={worthIt ? formatHoursMinutes(tonight!.minutesAbove) : t('objectDetail.tonightPanel.noneTonight')}
          hint={t('objectDetail.tonightPanel.aboveHint', { siteName: site?.name ?? t('objectDetail.tonightPanel.thisSite') })}
        />
        <Fact
          label={t('objectDetail.tonightPanel.bestMonths')}
          value={season?.windowStart
            ? (season.windowStart === season.windowEnd
                ? season.windowStart
                : t('objectDetail.tonightPanel.monthsRange', { start: season.windowStart, end: season.windowEnd }))
            : season && !season.everVisible ? t('objectDetail.tonightPanel.neverWellPlaced') : t('objectDetail.tonightPanel.unknown')}
          hint={t('objectDetail.tonightPanel.bestMonthsHint')}
        />
      </FactGrid>
    </SessionPanel>
  );
}
