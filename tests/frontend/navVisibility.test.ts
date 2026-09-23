import { describe, it, expect } from 'vitest';
import { applyDefaultSeeds, type NavItemId } from '../../src/hooks/useNavVisibility';

/**
 * The top nav's visibility defaults, which are localStorage-seeded rather than
 * plain fallbacks: most browsers already hold a `nebulis-nav-hidden` list, so a
 * changed default reaches an existing user only through the per-item seed flags
 * `applyDefaultSeeds` maintains. These tests pin the current defaults (Forecast
 * and Calibrations off, Wishlist on) and the two ways seeding can go wrong:
 * re-hiding an item a user turned back on, and never un-hiding an item whose
 * default flipped the other way.
 */
const WISHLIST_OLD_HIDDEN_SEED = 'nebulis-nav-wishlist-default-seeded-v1';
const FORECAST_SEED = 'nebulis-nav-forecast-default-seeded-v1';
const CALIBRATIONS_SEED = 'nebulis-nav-calibrations-default-seeded-v1';
const WISHLIST_VISIBLE_SEED = 'nebulis-nav-wishlist-default-visible-v1';

/** Stand-in for localStorage. */
function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

function ids(hidden: Set<NavItemId>): NavItemId[] {
  return [...hidden].sort();
}

describe('top nav visibility defaults', () => {
  it('hides Forecast and Calibrations, and shows Wishlist, on a browser with no storage', () => {
    const store = fakeStore();
    const { hidden } = applyDefaultSeeds(new Set(), store);

    expect(ids(hidden)).toEqual(['calibrations', 'forecast']);
    expect(hidden.has('wishlist')).toBe(false);
    // Settings is the one item that can never be hidden (it is the way back to
    // this very setting), so no seed may ever add it.
    expect(hidden.has('settings')).toBe(false);
  });

  it('seeds each flag once, so a second pass changes nothing', () => {
    const store = fakeStore();
    const first = applyDefaultSeeds(new Set(), store);
    expect(first.changed).toBe(true);

    const second = applyDefaultSeeds(first.hidden, store);
    expect(second.changed).toBe(false);
    expect(ids(second.hidden)).toEqual(ids(first.hidden));
  });

  it('un-hides Wishlist for a browser seeded hidden by the old default', () => {
    // The realistic old state: the v1 flag applied, so Wishlist sits in the
    // stored hidden list and nothing would ever remove it again.
    const store = fakeStore({ [WISHLIST_OLD_HIDDEN_SEED]: '1', [FORECAST_SEED]: '1' });
    const { hidden } = applyDefaultSeeds(new Set(['forecast', 'wishlist']), store);

    expect(hidden.has('wishlist')).toBe(false);
    expect(hidden.has('forecast')).toBe(true);
    expect(store.getItem(WISHLIST_VISIBLE_SEED)).toBe('1');
  });

  it('does not re-hide an item the user turned back on after its seed ran', () => {
    // Calibrations seeded off, then turned on by hand: the seed flag is set and
    // the stored list no longer carries the id. Seeding must not re-add it.
    const store = fakeStore({ [CALIBRATIONS_SEED]: '1', [FORECAST_SEED]: '1', [WISHLIST_VISIBLE_SEED]: '1' });
    const { hidden, changed } = applyDefaultSeeds(new Set(['forecast']), store);

    expect(changed).toBe(false);
    expect(hidden.has('calibrations')).toBe(false);
  });

  it('keeps Wishlist visible once a user re-enabled it after the flip', () => {
    const store = fakeStore({ [WISHLIST_OLD_HIDDEN_SEED]: '1', [WISHLIST_VISIBLE_SEED]: '1' });
    const { hidden } = applyDefaultSeeds(new Set(), store);

    expect(hidden.has('wishlist')).toBe(false);
  });
});
