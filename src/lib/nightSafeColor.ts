/**
 * Telescope/device identity colors (`TelescopeProfile.color`, see
 * server/lib/types/telescopeKind.ts's COLOR_BY_KIND) are arbitrary,
 * user-customizable hex — there is no fixed enum a `.night` CSS override
 * could redirect, and they are always painted via an inline `style`, which
 * bypasses Tailwind's class-based color tokens entirely. Every call site that
 * renders one as a swatch/dot needs to route it through here in red-light
 * mode instead of showing the device's real (often blue/green/violet) color.
 *
 * `index` distinguishes a *stack* of dots (e.g. "which telescopes shot this
 * object") from each other by brightness once hue is off the table; leave it
 * at 0 for a single lone swatch.
 */
const NIGHT_LADDER = ['#dd3333', '#cc3333', '#a02828', '#882222', '#661a1a', '#4d1414'];

export function nightSafeColor(color: string, isNight: boolean, index = 0): string {
  return isNight ? NIGHT_LADDER[index % NIGHT_LADDER.length] : color;
}
