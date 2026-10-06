import { test, expect } from '@playwright/test';
import { mockAdminAuth, mockAllRoutes, mockArchiveRoutes } from './fixtures/mocks';

/**
 * Browsing the archive disk and restoring from it.
 *
 * The restore path is the one that writes into the library, so the assertions here
 * care most about the case where the local file differs: the user must be told which
 * files are at stake, by name, before anything is replaced.
 */
test.describe('Archive disk — browse and restore', () => {
  async function openBrowser(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Storage', exact: true }).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: /browse archive/i }).click();
  }

  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await mockArchiveRoutes(page);
  });

  test('lists what is on the disk, and what is missing locally', async ({ page }) => {
    await openBrowser(page);

    const modal = page.getByRole('dialog');
    await expect(modal.getByText('M 31')).toBeVisible();
    // Counted with their nouns, so a single file cannot read as "1 files".
    await expect(modal.getByText(/2 files/)).toBeVisible();
    await expect(modal.getByText(/1 subframe\b/)).toBeVisible();
    await expect(modal.getByText(/1 missing locally/i)).toBeVisible();
  });

  test('lists the files of an object with their local presence', async ({ page }) => {
    await openBrowser(page);
    await page.getByRole('button', { name: /M 31/ }).click();

    await expect(page.getByText(/sub_00001_M31\.fit/)).toBeVisible();
    await expect(page.getByText(/missing locally/)).toBeVisible();
    await expect(page.getByText(/present locally/)).toBeVisible();
  });

  test('restores a selected file and reports it', async ({ page }) => {
    await openBrowser(page);
    await page.getByRole('button', { name: /M 31/ }).click();

    await page.getByRole('checkbox', { name: /sub_00001_M31\.fit/ }).check();
    await page.getByRole('button', { name: /restore 1/i }).click();

    await expect(page.getByText(/1 file restored/i)).toBeVisible();
  });

  test('restores nothing when nothing is selected', async ({ page }) => {
    await openBrowser(page);
    await page.getByRole('button', { name: /M 31/ }).click();

    // Present but disabled, rather than absent: an absent button would make this
    // assertion prove nothing.
    const restore = page.getByRole('button', { name: /restore 0/i });
    await expect(restore).toBeVisible();
    await expect(restore).toBeDisabled();
  });

  test('names the differing files before replacing them', async ({ page }) => {
    await mockArchiveRoutes(page, {
      restore: { restored: 0, conflicts: ['2026-01-01_22-00-00/sub_00001_M31.fit'] },
    });

    await openBrowser(page);
    await page.getByRole('button', { name: /M 31/ }).click();
    await page.getByRole('checkbox', { name: /sub_00001_M31\.fit/ }).check();

    let prompt = '';
    page.on('dialog', dialog => {
      prompt = dialog.message();
      dialog.dismiss();
    });

    await page.getByRole('button', { name: /restore 1/i }).click();
    // Polled, not asserted directly: `click()` resolves when the click is
    // dispatched, and the confirm fires later inside the async restore. Reading the
    // captured message immediately is a race that passes or fails on timing. The
    // prompt has to name the file, not just count it: that file is the user's only
    // copy of whatever they changed.
    await expect.poll(() => prompt).toContain('sub_00001_M31.fit');
  });

  test('goes back to the object list', async ({ page }) => {
    await openBrowser(page);
    await page.getByRole('button', { name: /M 31/ }).click();
    await page.getByRole('button', { name: /back to objects/i }).click();

    await expect(page.getByRole('button', { name: /M 31/ })).toBeVisible();
    // Assert the file list actually went away, so this cannot pass on a modal that
    // never changed view.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  test('opens at the width of the app\'s other modals', async ({ page }) => {
    await openBrowser(page);

    // The panel classes have to sit on `Modal`'s dialog element. On an inner
    // `w-full` div they resolve against a shrink-to-fit parent and the dialog
    // collapses to the width of its content: this one rendered 226px wide against a
    // `max-w-lg` that never applied. `max-w-lg` is 512px.
    const dialog = await page.getByRole('dialog').boundingBox();
    expect(dialog).not.toBeNull();
    expect(dialog!.width).toBeGreaterThan(480);
  });
});
