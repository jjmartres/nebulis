/**
 * Wishlist card states. An object that is not up tonight used to be a dead end
 * ("Not visible tonight") with the follow-up question ("so when is it?") only
 * answerable by opening the card, so the card now carries the same 12-month
 * max-altitude chart the detail modal shows, at card size.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockAllRoutes, mockWishlist } from './fixtures/mocks';

async function openWishlist(page: Page, width = 1440) {
  await mockAllRoutes(page);
  await mockWishlist(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/wishlist');
  // Role, not text: the empty state's own copy ("Nothing on your wishlist yet")
  // also contains "your wishlist", and getByText is a case-insensitive substring
  // match that would trip strict mode while the query is still in flight.
  await expect(page.getByRole('heading', { name: 'Your wishlist' })).toBeVisible();
  await expect(page.getByText('Orion Nebula')).toBeVisible();
}

function card(page: Page, name: string): Locator {
  // Each card is the clickable tile carrying the object's name.
  return page.locator('div[role="button"]').filter({ hasText: name }).first();
}

/** Bars in the card's month chart, excluding the icons' own SVG shapes. */
function monthBars(scope: Locator): Locator {
  return scope.locator('svg[role="img"] rect');
}

test.describe('Wishlist cards', () => {
  test('an object that is not up tonight shows its month chart', async ({ page }) => {
    await openWishlist(page);

    const off = card(page, 'M94');
    await expect(off.getByText('Not visible tonight')).toBeVisible();
    // The season, spelled out, next to the chart.
    await expect(off.getByText(/^Best: /)).toBeVisible();
    // One bar per month of the year.
    expect(await monthBars(off).count()).toBe(12);
  });

  test('an object that never clears the minimum altitude says so instead of charting', async ({ page }) => {
    await openWishlist(page);

    const never = card(page, 'Tucanae');
    await expect(never.getByText('Not visible tonight')).toBeVisible();
    // It never rises above the horizon from the mock site, so every month's bar
    // would be zero height: an empty box with a dashed line through it. Words.
    await expect(never.getByText(/minimum all year/i)).toBeVisible();
    expect(await monthBars(never).count()).toBe(0);
    await expect(never.getByText(/^Best: /)).toHaveCount(0);
  });

  test('an object that is up tonight keeps its stats and gains no chart', async ({ page }) => {
    await openWishlist(page);

    const up = card(page, 'Orion Nebula');
    await expect(up.getByText('Max alt')).toBeVisible();
    await expect(up.getByText('Window')).toBeVisible();
    await expect(up.getByText('Not visible tonight')).toHaveCount(0);
    expect(await monthBars(up).count()).toBe(0);
  });
});
