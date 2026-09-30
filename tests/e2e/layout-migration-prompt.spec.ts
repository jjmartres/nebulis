import { test, expect, type Page } from '@playwright/test';
import { mockAdminAuth, mockAllRoutes, mockViewerAuth, json, ok } from './fixtures/mocks';

/**
 * The one-time "your library needs an update" popup for libraries still in the old
 * flat folder layout.
 *
 * The server owns the truth (a count of unconverted objects), so these tests drive the
 * whole flow through a small fake of the two renest routes and assert what the person
 * actually reads at each step, including the two ways the popup must stay away.
 */

interface RenestState {
  flatObjects: number;
  running: boolean;
  objectsDone: number;
  objectsTotal: number;
  currentObject: string | null;
  summary: { objects: number; moved: number; failed: number; results: unknown[] } | null;
}

function idle(flatObjects: number): RenestState {
  return { flatObjects, running: false, objectsDone: 0, objectsTotal: 0, currentObject: null, summary: null };
}

async function mockRenest(page: Page, state: RenestState, onStart?: (s: RenestState) => void): Promise<{ starts: () => number }> {
  let starts = 0;
  await page.route('**/api/storage/renest/status', r => r.fulfill(json(ok({
    renest: {
      running: state.running,
      startedAt: null,
      objectsTotal: state.objectsTotal,
      objectsDone: state.objectsDone,
      currentObject: state.currentObject,
      summary: state.summary,
      error: null,
    },
    flatObjects: state.flatObjects,
  }))));
  await page.route('**/api/storage/renest', r => {
    if (r.request().method() !== 'POST') return r.fallback();
    starts++;
    onStart?.(state);
    return r.fulfill(json(ok({ started: true })));
  });
  return { starts: () => starts };
}

test.describe('Library layout migration prompt', () => {
  test('explains the update in plain words and converts the library on request', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    const state = idle(3);
    const { starts } = await mockRenest(page, state, s => {
      s.running = true;
      s.objectsTotal = 3;
      s.objectsDone = 1;
      s.currentObject = 'M31';
    });
    await page.goto('/');

    // One dialog at a time. Not looked up by name: its accessible name follows the title,
    // which changes from the question to the result.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Your library needs a one-time update' }).first()).toBeVisible();
    await expect(dialog.getByText('3 objects in your library will be converted.')).toBeVisible();
    await expect(dialog.getByText('Files are moved into new folders. Nothing is deleted.')).toBeVisible();
    // The honest limit: existing names are not restored.
    await expect(dialog.getByText(/Files already in your library keep their current names/)).toBeVisible();
    expect(starts()).toBe(0);

    await dialog.getByRole('button', { name: 'Update my library' }).click();
    await expect(dialog.getByText('Converting 1 of 3 (M31)')).toBeVisible();
    expect(starts()).toBe(1);
    // Nothing to click away while it runs.
    await expect(dialog.getByRole('button', { name: 'Remind me later' })).toHaveCount(0);

    // The run finishes: the server now reports zero flat objects and a summary.
    state.running = false;
    state.flatObjects = 0;
    state.summary = { objects: 3, moved: 42, failed: 0, results: [] };
    await expect(dialog.getByText('42 files were moved into the new layout.')).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('a failed object keeps the popup honest and offers another try', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    const state = idle(2);
    await mockRenest(page, state, s => {
      s.running = false;
      s.flatObjects = 1;
      s.summary = { objects: 2, moved: 5, failed: 1, results: [] };
    });
    await page.goto('/');

    // One dialog at a time. Not looked up by name: its accessible name follows the title,
    // which changes from the question to the result.
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Update my library' }).click();
    await expect(dialog.getByRole('heading', { name: 'Some objects could not be converted' }).first()).toBeVisible();
    await expect(dialog.getByText(/1 object could not be converted\. Nothing was lost/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('"Remind me later" hides it for this session without starting anything', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    const { starts } = await mockRenest(page, idle(2));
    await page.goto('/');

    // One dialog at a time. Not looked up by name: its accessible name follows the title,
    // which changes from the question to the result.
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Remind me later' }).click();
    await expect(dialog).toHaveCount(0);
    expect(starts()).toBe(0);

    // Same session, next page load: still quiet. (A new browser session asks again.)
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Your library needs a one-time update' })).toHaveCount(0);
  });

  test('never appears when every object is already converted', async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await mockRenest(page, idle(0));
    await page.goto('/');
    await expect(page.getByRole('link', { name: /library/i }).first()).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Your library needs a one-time update' })).toHaveCount(0);
  });

  test('is not shown to a viewer, who cannot run the conversion', async ({ page }) => {
    await mockAllRoutes(page);
    await mockViewerAuth(page);
    await mockRenest(page, idle(4));
    await page.goto('/');
    await expect(page.getByRole('link', { name: /library/i }).first()).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Your library needs a one-time update' })).toHaveCount(0);
  });
});
