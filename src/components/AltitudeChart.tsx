import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import SunCalc from 'suncalc';
import { useTranslation } from 'react-i18next';
import { computeAltitudeCurve, buildTonightWindow } from '../lib/altaz';
import { computeMoonInterferenceCurve, type MoonVerdict } from '../lib/moonProximity';
import { formatHm } from '../lib/timeFormat';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** Astronomical twilight, in radians: the sun 18° below the horizon, the same
 *  mark lib/nightWindow.ts uses to call a window "dark". */
const SUN_DARK_ALT_RAD = (-18 * Math.PI) / 180;

interface AltitudeChartProps {
  /** RA in decimal hours */
  ra: number;
  /** Dec in decimal degrees */
  dec: number;
  /** Observer latitude in decimal degrees */
  lat: number;
  /** Observer longitude in decimal degrees, east positive */
  lon: number;
  /** Minimum altitude line (degrees). Pulled from user settings. */
  minAlt?: number;
  /** Tonight's moon illumination (0-100). When given, a thin strip above the
   *  curve shows where in the night the moon comes close enough to matter,
   *  so a wide bright gibbous doesn't have to be inferred from the altitude
   *  shape alone. Omitted entirely when this isn't provided. */
  moonIllumination?: number;
  /** IANA timezone for the noon-anchored window and time labels. Defaults to
   *  the viewing device's clock. */
  timeZone?: string;
  isDark: boolean;
  /**
   * Fired while the user scrubs the curve, with the time/alt/az under the
   * cursor (or null when the pointer leaves). Lets a parent sync another view
   * — e.g. rotate a sky preview to the scrubbed moment — to the chart.
   */
  onScrub?: (point: { time: Date; alt: number; az: number } | null) => void;
  /**
   * Fill the height the parent flex column leaves over, instead of hugging the
   * natural strip height. The extra room goes into the plot, so a chart sitting
   * in a row with taller content lines up with it rather than leaving dead
   * space between or around the cards. Off by default: standalone charts keep
   * their compact size.
   */
  fill?: boolean;
}

/**
 * Compact 24-hour altitude chart for a fixed sky object.
 *
 * Computes altitude at 15-minute intervals across tonight's local noon-to-noon
 * window entirely client-side — no server round-trip. Renders as an SVG curve
 * with fixed 4-hour tick labels (12, 16, 20, 00, 04, 08, 12) and a marker
 * showing the object's current position.
 */
export function AltitudeChart({ ra, dec, lat, lon, minAlt, moonIllumination, timeZone, isDark, onScrub, fill = false }: AltitudeChartProps) {
  const { t } = useTranslation('common');
  const { samples, start, end } = useMemo(() => {
    const { start, end } = buildTonightWindow(new Date(), timeZone);
    const samples = computeAltitudeCurve(ra, dec, lat, lon, start, end, 15);
    return { samples, start, end };
  }, [ra, dec, lat, lon, timeZone]);

  // Moon interference strip — same 15-min cadence as the altitude samples so
  // each band lines up with the curve directly below it. Undefined
  // moonIllumination (caller doesn't have tonight's phase) just means no bar.
  const moonBands = useMemo(() => {
    if (moonIllumination == null) return null;
    return computeMoonInterferenceCurve(ra, dec, lat, lon, start, end, moonIllumination, 15);
  }, [ra, dec, lat, lon, start, end, moonIllumination]);

  // Where the sun is still up, sampled on the strip's own cadence. The moon
  // being above the horizon at midday says nothing about tonight's imaging,
  // and drawing it made the row look busy on nights the moon never mattered:
  // a new moon drew a band across the afternoon. The threshold is the same
  // -18° (astronomical twilight) the rest of the app treats as dark — see
  // lib/nightWindow.ts. High-latitude summer has no such darkness, so the
  // whole row drops out, which is correct: there are no dark hours to spoil.
  const sunUpAt = useMemo(
    () => (moonBands ?? []).map(b => SunCalc.getPosition(b.time, lat, lon).altitude > SUN_DARK_ALT_RAD),
    [moonBands, lat, lon],
  );

  // Collapse consecutive same-state samples into one segment each, rather
  // than drawing 96 individual 15-minute rects — at the chart's actual pixel
  // width those read as a solid band with visible seams between every one
  // (a "barcode"), which for a nearly-uniform night looked like noise
  // instead of one continuous span.
  type MoonCategory = 'down' | 'daylight' | MoonVerdict;
  const moonSegments = useMemo(() => {
    if (!moonBands || moonBands.length === 0) return null;
    const segments: { startMs: number; endMs: number; category: MoonCategory }[] = [];
    for (let i = 0; i < moonBands.length; i++) {
      const band = moonBands[i];
      const category: MoonCategory = band.separation == null
        ? 'down'
        : sunUpAt[i]
          ? 'daylight'
          : band.verdict;
      const startMs = band.time.getTime();
      const endMs = moonBands[i + 1]?.time.getTime() ?? end.getTime();
      const last = segments[segments.length - 1];
      if (last && last.category === category) last.endMs = endMs;
      else segments.push({ startMs, endMs, category });
    }
    return segments;
  }, [moonBands, sunUpAt, end]);

  // Only runs where the moon is up AND the sky is dark get drawn. The row is
  // skipped entirely when there are none, rather than reserving height for an
  // empty strip.
  const moonVisibleSegments = useMemo(
    () => (moonSegments ?? []).filter(seg => seg.category !== 'down' && seg.category !== 'daylight'),
    [moonSegments],
  );

  const { pathD, currentPoint } = useMemo(() => {
    const startMs = start.getTime();
    const spanMs = end.getTime() - startMs;

    // Normalize samples — allow negative y so below-horizon portions flow
    // smoothly through the Catmull-Rom spline without distorting the curve.
    // The SVG clips anything outside the viewBox.
    const points = samples.map(s => ({
      x: (s.time.getTime() - startMs) / spanMs,
      y: s.alt / 90,
      alt: s.alt,
      az: s.az,
    }));

    const path = buildSmoothPath(points);

    const nowMs = Date.now();
    const tNow = (nowMs - startMs) / spanMs;
    let current: { x: number; y: number; alt: number; az: number } | null = null;
    if (tNow >= 0 && tNow <= 1 && points.length > 0) {
      // Linear interpolation between the two bracketing samples for a smooth dot
      const idxF = tNow * (points.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(points.length - 1, i0 + 1);
      const f = idxF - i0;
      const p0 = points[i0];
      const p1 = points[i1];
      let dAzNow = p1.az - p0.az;
      if (dAzNow > 180) dAzNow -= 360;
      if (dAzNow < -180) dAzNow += 360;
      current = {
        x: tNow,
        y: p0.y + (p1.y - p0.y) * f,
        alt: p0.alt + (p1.alt - p0.alt) * f,
        az: ((p0.az + dAzNow * f) % 360 + 360) % 360,
      };
    }

    return { pathD: path, currentPoint: current };
  }, [samples, start, end]);

  // Fixed chart geometry — not stretched across full width
  const W = 560;
  // Moon band sits in its own row above the plot, not overlaid on it —
  // reserving separate vertical space keeps it readable against the curve
  // instead of fighting for the same pixels near 90°.
  const moonBarH = 6;
  const moonBarGap = 5;
  const moonBarY = 2;
  // Whether the row exists at all — the moon is up during tonight's dark
  // hours. Otherwise the chart renders exactly as it did before this feature.
  const showMoonRow = moonVisibleSegments.length > 0;
  const naturalH = 160 + (showMoonRow ? moonBarH + moonBarGap : 0);
  // In fill mode the SVG's box is sized by the flex parent, so measure it and
  // hand the viewBox the height that matches that box exactly. Meeting the box
  // with a matching aspect ratio means the drawing scales uniformly (no
  // squashed text) and the leftover height becomes real plot, not letterbox.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [fillBox, setFillBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!fill || !el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setFillBox(prev =>
        prev && Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const H = fill && fillBox ? Math.max(naturalH, (fillBox.h / fillBox.w) * W) : naturalH;
  const padL = 10;
  const padR = 30;
  const padT = 10 + (showMoonRow ? moonBarH + moonBarGap : 0);
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xToPx = (x: number) => padL + x * plotW;
  const yToPx = (y: number) => padT + (1 - y) * plotH;

  const gridColor = isDark ? 'rgba(148,163,184,0.10)' : 'rgba(100,116,139,0.14)';
  const axisLabelColor = isDark ? '#64748b' : '#94a3b8';
  const curveColor = isDark ? '#e2e8f0' : '#475569';
  const dotFill = isDark ? '#ffffff' : '#0f172a';
  const dotStroke = isDark ? '#0f172a' : '#ffffff';

  // Fixed 4-hour ticks — start is local noon, so offsets of 0/4/8/12/16/20/24
  // produce the hour labels 12, 16, 20, 00, 04, 08, 12.
  const TICKS = [
    { t: 0 / 24, label: '12' },
    { t: 4 / 24, label: '16' },
    { t: 8 / 24, label: '20' },
    { t: 12 / 24, label: '00' },
    { t: 16 / 24, label: '04' },
    { t: 20 / 24, label: '08' },
    { t: 24 / 24, label: '12' },
  ];

  // Hover state — set by pointer move/click on the chart
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    alt: number;
    az: number;
    time: Date;
  } | null>(null);

  /**
   * Compute a scrubbed point at normalized [0..1] t across the window,
   * linearly interpolating between the two bracketing 15-min samples.
   */
  const interpAt = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(1, t));
      const idxF = clamped * (samples.length - 1);
      const i0 = Math.floor(idxF);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const f = idxF - i0;
      const s0 = samples[i0];
      const s1 = samples[i1];
      const alt = s0.alt + (s1.alt - s0.alt) * f;
      // Azimuth wraps 0↔360 — interpolate on the shorter arc
      let dAz = s1.az - s0.az;
      if (dAz > 180) dAz -= 360;
      if (dAz < -180) dAz += 360;
      const az = ((s0.az + dAz * f) % 360 + 360) % 360;
      const timeMs = s0.time.getTime() + (s1.time.getTime() - s0.time.getTime()) * f;
      return {
        x: clamped,
        y: alt / 90,
        alt,
        az,
        time: new Date(timeMs),
      };
    },
    [samples],
  );

  const handlePointer = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      // Map client X to viewBox X (SVG scales to container)
      const vbX = ((e.clientX - rect.left) / rect.width) * W;
      const clampedVbX = Math.max(padL, Math.min(W - padR, vbX));
      const t = (clampedVbX - padL) / plotW;
      const point = interpAt(t);
      setHover(point);
      onScrub?.({ time: point.time, alt: point.alt, az: point.az });
    },
    [interpAt, padL, plotW, onScrub],
  );

  const handleLeave = useCallback(() => {
    setHover(null);
    onScrub?.(null);
  }, [onScrub]);

  // The "active" point drives the header and the big marker.
  // Hover takes precedence over the real-time "now" position.
  const activePoint = hover ?? currentPoint;
  const headerAlt = activePoint ? Math.round(activePoint.alt) : 0;
  const headerDir = activePoint ? azToCompass(activePoint.az, t) : '';
  const headerLabel = hover
    ? formatHm(hover.time, timeZone)
    : currentPoint
      ? t('altitudeChart.currentAltitude')
      : '';

  if (samples.length === 0) return null;

  return (
    <div
      className={`rounded-xl border max-w-xl ${
        fill ? 'flex min-h-0 flex-1 flex-col' : ''
      } ${
        isDark ? 'bg-slate-900 border-slate-700' : 'bg-slate-50/80 border-slate-200'
      }`}
    >
      {/* Header — shows hovered point when scrubbing, otherwise live "now".
          The reading and its caption share one line: a second line of label
          cost vertical space the plot can use, and the number reads the same
          either way ("47°  04:42" while scrubbing). */}
      <div className="flex items-baseline justify-between gap-2 px-4 pt-2.5 pb-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={`text-2xl font-bold leading-none tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {headerAlt}°
          </span>
          {headerLabel && (
            <span className={`truncate text-[11px] tabular-nums ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {headerLabel}
            </span>
          )}
        </div>
        {headerDir && (
          <div className={`shrink-0 text-sm font-semibold tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {headerDir}
          </div>
        )}
      </div>

      {/* Chart. In fill mode the SVG carries the natural strip height as its
          CSS aspect ratio: that is the floor it grows from, and it stops the
          measured box from feeding back into the intrinsic size the card
          contributes, which would inflate the chart on every measure. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className={`w-full cursor-crosshair touch-none overflow-hidden ${fill ? 'min-h-0 grow' : ''}`}
        style={{ display: 'block', ...(fill ? { aspectRatio: `${W} / ${naturalH}` } : {}) }}
        onPointerMove={handlePointer}
        onPointerDown={handlePointer}
        onPointerLeave={handleLeave}
        onPointerCancel={handleLeave}
      >
        {/* Moon band — always moon-colored (pale gold when it's just up,
            saturating to amber then red as it gets close enough to matter),
            and only ever drawn across tonight's dark hours. No legend: an
            icon beside it either had to hold a gutter open for the case where
            the band starts at dusk, or sit somewhere it didn't line up. The
            band names itself on hover instead, and the surfaces this chart
            appears on all carry a Moon-labelled line next to it. One rect per
            merged run, not per sample, so a long uniform stretch reads as one
            solid band. */}
        {showMoonRow && (
          <g role="img" aria-label={t('altitudeChart.moonLabel')}>
            <title>{t('altitudeChart.moonLabel')}</title>
            {moonVisibleSegments.map((seg, i) => {
              const spanMs = end.getTime() - start.getTime();
              const x0 = xToPx((seg.startMs - start.getTime()) / spanMs);
              const x1 = xToPx((seg.endMs - start.getTime()) / spanMs);
              const bandFill = seg.category === 'warning'
                ? (isDark ? '#fb7185' : '#e11d48')
                : seg.category === 'caution'
                  ? (isDark ? '#fbbf24' : '#d97706')
                  : (isDark ? 'rgba(251,191,36,0.38)' : 'rgba(217,119,6,0.3)');
              return (
                <rect
                  key={i}
                  x={x0}
                  y={moonBarY}
                  width={Math.max(0, x1 - x0)}
                  height={moonBarH}
                  fill={bandFill}
                >
                  {/* Per-span tooltip: names the band and gives the hours it
                      covers, since only the color carries how bad it is. */}
                  <title>
                    {t('altitudeChart.moonStripSpan', {
                      start: formatHm(new Date(seg.startMs), timeZone),
                      end: formatHm(new Date(seg.endMs), timeZone),
                    })}
                  </title>
                </rect>
              );
            })}
          </g>
        )}

        {/* Horizontal grid at 0°, 30°, 60°, 90° */}
        {[0, 30, 60, 90].map(deg => {
          const y = yToPx(deg / 90);
          return (
            <g key={deg}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke={gridColor}
                strokeWidth={1}
                strokeDasharray={deg === 0 ? 'none' : '3 3'}
              />
              <text
                x={W - padR + 4}
                y={y + 3}
                fontSize={9}
                fill={axisLabelColor}
                fontFamily="system-ui, sans-serif"
              >
                {deg}°
              </text>
            </g>
          );
        })}

        {/* Minimum altitude threshold (user setting) */}
        {minAlt != null && minAlt > 0 && minAlt < 90 && (
          <line
            x1={padL}
            x2={W - padR}
            y1={yToPx(minAlt / 90)}
            y2={yToPx(minAlt / 90)}
            stroke={isDark ? 'rgba(251,146,60,0.4)' : 'rgba(251,146,60,0.55)'}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {/* Fixed hour ticks */}
        {TICKS.map((tick, i) => (
          <text
            key={i}
            x={xToPx(tick.t)}
            y={H - 6}
            fontSize={9}
            fill={axisLabelColor}
            textAnchor={i === 0 ? 'start' : i === TICKS.length - 1 ? 'end' : 'middle'}
            fontFamily="system-ui, sans-serif"
          >
            {tick.label}
          </text>
        ))}

        {/* Altitude curve */}
        <path
          d={transformPath(pathD, xToPx, yToPx)}
          fill="none"
          stroke={curveColor}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Real-time "now" marker — dim, stays put even while scrubbing */}
        {currentPoint && hover && (
          <circle
            cx={xToPx(currentPoint.x)}
            cy={yToPx(currentPoint.y)}
            r={3}
            fill={isDark ? 'rgba(226,232,240,0.4)' : 'rgba(71,85,105,0.4)'}
          />
        )}

        {/* Active marker — follows the cursor while hovering, else sits at "now" */}
        {activePoint && (
          <g>
            <line
              x1={xToPx(activePoint.x)}
              x2={xToPx(activePoint.x)}
              y1={padT}
              y2={H - padB}
              stroke={isDark ? 'rgba(226,232,240,0.35)' : 'rgba(71,85,105,0.35)'}
              strokeWidth={1}
            />
            <circle
              cx={xToPx(activePoint.x)}
              cy={yToPx(activePoint.y)}
              r={4.5}
              fill={dotFill}
              stroke={dotStroke}
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Smooth cubic-Bezier path through normalized points using a Catmull-Rom-to-
 * Bezier conversion. Tension 0.5 gives a soft, slightly taut curve that
 * reads naturally for altitude-over-time without overshoot.
 */
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const tension = 0.5;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;

    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension;

    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Remap an SVG path from normalized [0..1] coordinates into pixel space. */
function transformPath(
  d: string,
  xToPx: (x: number) => number,
  yToPx: (y: number) => number,
): string {
  let isX = true;
  return d.replace(/-?\d*\.?\d+/g, match => {
    const v = parseFloat(match);
    const out = isX ? xToPx(v) : yToPx(v);
    isX = !isX;
    return out.toFixed(1);
  });
}

function azToCompass(az: number, t: TFunc): string {
  const keys = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  const idx = Math.round((az % 360) / 45) % 8;
  return t(`compass8.${keys[idx]}`, { ns: 'common' });
}
