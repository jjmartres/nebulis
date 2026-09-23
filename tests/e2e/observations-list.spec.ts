import { test, expect } from '@playwright/test';
import { mockAllRoutes, ok } from './fixtures/mocks';

/**
 * The List view on the Observations page: a flat, sortable table of every
 * observation, as an alternative to the month-scoped calendar and the map.
 */
test.describe('Observations list view', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/observations');
    await page.getByRole('button', { name: 'List' }).click();
  });

  test('shows a table with object, catalog, and date columns', async ({ page }) => {
    const table = page.getByRole('table');
    await expect(table).toBeVisible();

    await expect(page.getByRole('columnheader', { name: /object/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /catalog/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /date/i })).toBeVisible();
  });

  test('lists every observation regardless of month', async ({ page }) => {
    // The two mocked observations are in different months (March and February),
    // so both appearing proves the list is not month-scoped like the calendar.
    await expect(page.getByRole('cell', { name: 'Orion Nebula' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Andromeda Galaxy' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(3); // header + 2 rows
  });

  test('shows the common name and the catalog id in separate columns', async ({ page }) => {
    const row = page.getByRole('row').filter({ hasText: 'Orion Nebula' });
    await expect(row.getByRole('cell').nth(0)).toHaveText('Orion Nebula');
    await expect(row.getByRole('cell').nth(1)).toHaveText('M42');
    await expect(row.getByRole('cell').nth(2)).toContainText('2024');
  });

  test('defaults to newest first and reverses when Date is clicked', async ({ page }) => {
    const firstObject = () => page.getByRole('row').nth(1).getByRole('cell').first();

    // March 2024 sorts above February 2024 by default.
    await expect(firstObject()).toHaveText('Orion Nebula');

    await page.getByRole('button', { name: 'Date' }).click();
    await expect(firstObject()).toHaveText('Andromeda Galaxy');
  });

  test('sorts by object name', async ({ page }) => {
    await page.getByRole('button', { name: 'Object' }).click();
    await expect(page.getByRole('row').nth(1).getByRole('cell').first())
      .toHaveText('Andromeda Galaxy');
  });

  test('rows link to the observation detail page', async ({ page }) => {
    await page.getByRole('link', { name: 'Orion Nebula' }).click();
    await expect(page).toHaveURL(/\/observations\/M42\/2024-03-15/);
  });

  test('switching back to Calendar restores the calendar', async ({ page }) => {
    await page.getByRole('button', { name: 'Calendar' }).click();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});

test.describe('Observations list view: pagination', () => {
  // A page's worth (25) plus a few, spread across enough distinct dates that
  // sorting/paging is meaningful. Overrides the shared 2-row mock so this
  // block is the only place carrying the larger fixture.
  const manyObservations = Array.from({ length: 28 }, (_, i) => ({
    id: `obs-many-${i}`,
    objectId: `OBJ${i}`,
    objectName: `Test Object ${String(i).padStart(2, '0')}`,
    catalogId: `NGC${1000 + i}`,
    type: 'Galaxy',
    constellation: 'Orion',
    date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    startTime: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T21:00:00Z`,
    endTime: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T23:00:00Z`,
    fileCount: 1,
    stackedCount: 1,
    fitsCount: 1,
    thumbnailUrl: `/api/library/objects/OBJ${i}/thumbnail`,
    ra: '05h 35m 17s',
    dec: '-05° 23′ 28″',
    hasNotes: false,
  }));

  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.route('**/api/library/observations', r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok(manyObservations)) }));
    await page.goto('/observations');
    await page.getByRole('button', { name: 'List' }).click();
  });

  test('shows only one page worth of rows at a time', async ({ page }) => {
    // header + 25 rows, not all 28.
    await expect(page.getByRole('row')).toHaveCount(26);
    await expect(page.getByText('1 / 2')).toBeVisible();
  });

  test('Next reveals the remaining rows and disables at the last page', async ({ page }) => {
    await page.getByRole('button', { name: 'Next page' }).click();
    // 28 total, 25 on page 1, so 3 remain on page 2.
    await expect(page.getByRole('row')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  });

  test('re-sorting jumps back to the first page', async ({ page }) => {
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('2 / 2')).toBeVisible();

    await page.getByRole('button', { name: 'Object' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
  });
});
