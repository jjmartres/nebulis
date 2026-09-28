import { test, expect } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

// The planner is a split-pane layout: a searchable object library on the left
// and a dusk-to-dawn schedule timeline on the right. Targets are dragged from
// the library onto the timeline. These tests cover the library pane, the
// details modal, and the below-horizon search backfill.
test.describe('Planner Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/planner');
  });

  test('shows page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /planner/i })).toBeVisible();
  });

  test('lists tonight\'s observable targets in the library', async ({ page }) => {
    await expect(page.getByText('Orion Nebula').first()).toBeVisible();
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy').first()).toBeVisible();
  });

  test('shows the search box and filter controls', async ({ page }) => {
    await expect(page.getByPlaceholder(/search/i)).toBeVisible();
    for (const label of ['All', 'Galaxies', 'Nebulae', 'Clusters']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /hide blocked/i })).toBeVisible();
  });

  test('search narrows the library to matching targets', async ({ page }) => {
    await page.getByPlaceholder(/search/i).fill('Pleiades');
    await expect(page.getByText('Pleiades').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
    await expect(page.getByText('Whirlpool Galaxy')).not.toBeVisible();
  });

  test('galaxies filter shows only galaxies', async ({ page }) => {
    await page.getByRole('button', { name: 'Galaxies', exact: true }).click();
    await expect(page.getByText('Whirlpool Galaxy').first()).toBeVisible();
    await expect(page.getByText('Orion Nebula')).not.toBeVisible();
  });

  test('observable targets are draggable onto the timeline', async ({ page }) => {
    // @dnd-kit marks draggable rows with aria-roledescription="draggable".
    await expect(
      page.locator('[aria-roledescription="draggable"]', { hasText: 'Orion Nebula' }),
    ).toBeVisible();
  });

  test('opens the object details modal from a library row', async ({ page }) => {
    await page.getByRole('button', { name: 'Show details for Orion Nebula', exact: true }).click();
    await expect(page.getByText('Reference image')).toBeVisible();
    await expect(page.getByRole('button', { name: /close details/i })).toBeVisible();
  });

  // Scrubbing the altitude chart drives the sky tracker's moment, and the
  // caption under the chart swaps between the short scrubbed wording and the
  // longer "(highest tonight)" default. Both states have to occupy the same
  // height: this modal is vertically centered, so a line of difference there
  // slid the whole dialog up and down under the cursor while scrubbing.
  test('scrubbing the altitude chart does not move the details modal', async ({ page }) => {
    // Tall enough that the modal is not already clamped to its 92vh ceiling,
    // where the body scrolls and would hide the shift.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole('button', { name: 'Show details for Orion Nebula', exact: true }).click();
    const panel = page.locator('div.relative.flex.flex-col.rounded-2xl');
    await expect(panel).toBeVisible();

    const rest = await panel.boundingBox();
    expect(rest).not.toBeNull();

    const chart = panel.locator('svg.cursor-crosshair').first();
    const chartBox = await chart.boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(chartBox!.x + chartBox!.width * 0.5, chartBox!.y + chartBox!.height * 0.5);

    // The caption did switch to the scrubbed wording (the period right after
    // the time is what the default "(highest tonight)" variant lacks)...
    await expect(page.getByText(/Sky shown at \d{2}:\d{2}\./)).toBeVisible();

    // ...and the modal's box is unchanged.
    const scrubbed = await panel.boundingBox();
    expect(Math.abs(scrubbed!.height - rest!.height)).toBeLessThan(1);
    expect(Math.abs(scrubbed!.y - rest!.y)).toBeLessThan(1);
  });

  test('shows the moon summary and sky-map control', async ({ page }) => {
    // The illumination no longer repeats the word "Moon": the block is already
    // labelled, and the line has to leave room for the rise/set times, which
    // were being truncated mid-number when everything shared one line.
    await expect(page.getByText('Moon', { exact: true })).toBeVisible();
    await expect(page.getByText(/42% lit/i)).toBeVisible();
    // The visible-sky editor sits with the night picker, not on the night
    // panel: it is a property of the observing site, not of tonight.
    await expect(page.getByRole('button', { name: /visible sky/i })).toBeVisible();
  });

  // The planner reads the same forecast the Sky Forecast page does, and shows
  // the full hour-by-hour picture in a popup rather than sending you to
  // another page for it.
  test.describe('night weather popup', () => {
    test('the rating opens the full forecast for the night', async ({ page }) => {
      await page.getByRole('button', { name: /open the hour-by-hour forecast/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/dark hours/i)).toBeVisible();
      await expect(dialog.getByText(/best window/i)).toBeVisible();
    });

    test('an hour on the weather gutter opens its breakdown', async ({ page }) => {
      await page.locator('button[aria-label^="Forecast for"]').nth(4).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Landing on an hour means its score breakdown is already open.
      await expect(dialog.getByText(/transparency/i).first()).toBeVisible();
    });

    test('the popup closes again', async ({ page }) => {
      await page.getByRole('button', { name: /open the hour-by-hour forecast/i }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: /close weather/i }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });

  // The feature under test: an object that never clears the horizon tonight is
  // dropped from /planner/tonight, but a search must still surface it from the
  // full catalog as a dimmed, non-draggable "not observable" row.
  test.describe('below-horizon search backfill', () => {
    test('surfaces a below-horizon object under a "not observable" heading', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await expect(page.getByText(/not observable on this night/i)).toBeVisible();
      await expect(page.getByText('47 Tucanae')).toBeVisible();
    });

    test('the below-horizon row is not draggable', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await expect(page.getByText('47 Tucanae')).toBeVisible();
      await expect(
        page.locator('[aria-roledescription="draggable"]', { hasText: '47 Tucanae' }),
      ).toHaveCount(0);
    });

    test('the below-horizon row still opens details', async ({ page }) => {
      await page.getByPlaceholder(/search/i).fill('Tucanae');
      await page.getByRole('button', { name: 'Show details for 47 Tucanae', exact: true }).click();
      await expect(page.getByText('Reference image')).toBeVisible();
    });
  });

  test('prompts for location when none is set', async ({ page }) => {
    // locationSet:false makes the planner render the location empty-state
    // instead of the library/timeline panes.
    await page.route('**/api/planner/tonight**', r =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok({
          locationSet: false,
          targets: [],
          nightStart: null,
          nightEnd: null,
          timelineStart: null,
          timelineEnd: null,
          moonIllumination: 0,
          moonPhase: 'Unknown',
          observerTimezone: null,
        })),
      }));
    await page.goto('/planner');
    await expect(page.getByText(/location not set/i)).toBeVisible();
  });
});
