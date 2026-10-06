import { test, expect, type Page } from '@playwright/test';
import { mockAdminAuth, mockAllRoutes, mockArchiveRoutes } from './fixtures/mocks';

/**
 * The plain-English account of what the archive will do.
 *
 * It appears twice: as one sentence per group in the overview once the archive is on,
 * and as the review at the end of setup. A summary that is merely present is worth
 * nothing, and this one is easy to write vacuously: a sentence that never changes still
 * renders. So the overview tests vary the stored settings and assert the sentence moved
 * with them, and the review tests change a setting in the wizard and assert the same,
 * including the cases where the honest answer is "nothing will happen".
 */
test.describe('Settings — archive summary', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await page.goto('/settings');
  });

  async function openArchiveSection(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Storage', exact: true }).click();
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
  }

  /** The archive is on, so the summary is the rows of the overview. */
  async function openWith(page: Page, config: Record<string, unknown>): Promise<void> {
    await mockArchiveRoutes(page, { config: { enabled: true, ...config } });
    await page.reload();
    await openArchiveSection(page);
    await expect(page.getByText('Archive is on', { exact: true })).toBeVisible();
  }

  /** The archive is off and set up, so the summary is the review step. */
  async function openReviewWith(page: Page, config: Record<string, unknown>): Promise<void> {
    await mockArchiveRoutes(page, { config: { enabled: false, ...config } });
    await page.reload();
    await openArchiveSection(page);
    await page.getByRole('button', { name: 'Review and turn on', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready to turn it on?' })).toBeVisible();
  }

  /** From the review, back to one step, change it, and forward to the review again. */
  async function changeStep(page: Page, step: string, change: () => Promise<void>): Promise<void> {
    await page.getByRole('list', { name: 'Setup steps' }).getByRole('button', { name: new RegExp(step) }).click();
    await change();
    const next = page.getByRole('button', { name: 'Next', exact: true });
    while (await next.isVisible()) await next.click();
    await expect(page.getByRole('heading', { name: 'Ready to turn it on?' })).toBeVisible();
  }

  test('names the destination and whether subframes are included', async ({ page }) => {
    await openWith(page, { path: '/Volumes/Archive', includeSubframes: true });
    await expect(page.getByText('Copies every object in your library to /Volumes/Archive.')).toBeVisible();
    await expect(page.getByText('Subframes are included in the copy.')).toBeVisible();
  });

  test('says subframes are left out when they are', async ({ page }) => {
    await openWith(page, { includeSubframes: false });
    await expect(page.getByText('Subframes are left out, so only finished images are copied.')).toBeVisible();
    await expect(page.getByText('Subframes are included in the copy.')).toHaveCount(0);
  });

  test('describes a stored selection rather than claiming the whole library', async ({ page }) => {
    // The form has no scope picker, so a selection made elsewhere survives a save from
    // here. The summary has to say what is stored, not what this form would send.
    await openWith(page, { scope: 'selected', selectedObjects: ['M31', 'M42'] });
    await expect(page.getByText('Copies the 2 objects you selected to /Volumes/Archive.')).toBeVisible();
    await expect(page.getByText(/Copies every object/)).toHaveCount(0);
  });

  test('says plainly when a stored selection is empty, because nothing would be copied', async ({ page }) => {
    await openWith(page, { scope: 'selected', selectedObjects: [] });
    await expect(page.getByText(/none are selected yet, so nothing would be copied/)).toBeVisible();
  });

  test('says nothing is copied while no destination is chosen', async ({ page }) => {
    await openWith(page, { path: '' });
    await expect(page.getByText('No archive disk is chosen yet, so nothing can be copied.')).toBeVisible();
  });

  test('says when new captures wait, and when they do not', async ({ page }) => {
    await openWith(page, { copyMinAgeEnabled: false });
    await expect(page.getByText('New captures are archived as soon as a run finds them.')).toBeVisible();

    await openWith(page, { copyMinAgeEnabled: true, copyMinAgeDays: 7 });
    await expect(page.getByText('Only files at least 7 days old are archived; newer captures wait.')).toBeVisible();
    await expect(page.getByText('New captures are archived as soon as a run finds them.')).toHaveCount(0);
  });

  test('follows the schedule from off, to a time, to an interval, to an expression', async ({ page }) => {
    await openWith(page, { scheduleEnabled: false, scheduleMode: 'daily' });
    await expect(page.getByText('Runs only when you press Archive now.')).toBeVisible();

    await openWith(page, { scheduleEnabled: true, scheduleMode: 'daily', scheduleHour: 4, scheduleMinute: 15 });
    await expect(page.getByText(/Runs every day at 0?4:15/)).toBeVisible();

    await openWith(page, { scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 6 });
    await expect(page.getByText('Runs every 6 hours.')).toBeVisible();

    await openWith(page, { scheduleEnabled: true, scheduleMode: 'custom', scheduleCron: '*/15 2-6 * * 1-5' });
    await expect(page.getByText('Runs on the schedule */15 2-6 * * 1-5.')).toBeVisible();

    // An expression that is empty says so rather than rendering an empty sentence or,
    // worse, nothing at all.
    await openWith(page, { scheduleEnabled: true, scheduleMode: 'custom', scheduleCron: '' });
    await expect(page.getByText('Runs on the schedule not set, so nothing will run.')).toBeVisible();
  });

  test('describes retention, including the mode, the singular, and the case where nothing is deleted', async ({ page }) => {
    await openWith(page, { retentionEnabled: false, retentionDays: 0 });
    await expect(page.getByText('Nothing is deleted from the archive.')).toBeVisible();

    await openWith(page, { retentionEnabled: true, retentionDays: 30, retentionSubframesOnly: false });
    await expect(
      page.getByText('Objects are deleted from the archive 30 days after they were last archived. Files your library no longer has are kept.'),
    ).toBeVisible();

    await openWith(page, { retentionEnabled: true, retentionDays: 30, retentionSubframesOnly: true });
    await expect(
      page.getByText('Subframes are deleted from the archive 30 days after they were last archived. Finished images, and files your library no longer has, are kept.'),
    ).toBeVisible();

    // The singular is a different sentence in English, so it is asserted rather than
    // left to the reader to assume the plural key covers it.
    await openWith(page, { retentionEnabled: true, retentionDays: 1, retentionSubframesOnly: true });
    await expect(
      page.getByText('Subframes are deleted from the archive 1 day after they were last archived. Finished images, and files your library no longer has, are kept.'),
    ).toBeVisible();
  });

  test('says subframes will be deleted from this local Nebulis instance when that option is on', async ({ page }) => {
    await openWith(page, { removeLocalAfter: false });
    await expect(page.getByText(/are also deleted from this local Nebulis instance/)).toHaveCount(0);

    await openWith(page, { removeLocalAfter: true });
    await expect(
      page.getByText('Subframes are also deleted from this local Nebulis instance once their archived copy is verified.'),
    ).toBeVisible();
  });

  test.describe('the review step', () => {
    test('shows the stored settings before anything is changed', async ({ page }) => {
      await openReviewWith(page, { path: '/Volumes/Archive', includeSubframes: true });
      await expect(page.getByText('Copies every object in your library to /Volumes/Archive.')).toBeVisible();
      await expect(page.getByText('Subframes are included in the copy.')).toBeVisible();
      await expect(page.getByText('Runs only when you press Archive now.')).toBeVisible();
    });

    test('follows an edit made on an earlier step', async ({ page }) => {
      await openReviewWith(page, { includeSubframes: true });

      await changeStep(page, 'What to copy', async () => {
        await page.getByRole('switch', { name: /include subframes/i }).click();
        await page.getByRole('spinbutton', { name: 'Wait before archiving' }).fill('7');
      });
      await expect(page.getByText('Subframes are left out, so only finished images are copied.')).toBeVisible();
      await expect(page.getByText('Only files at least 7 days old are archived; newer captures wait.')).toBeVisible();
    });

    test('follows the schedule choice, from a time to an interval to an expression', async ({ page }) => {
      await openReviewWith(page, {});

      await changeStep(page, 'Schedule', async () => {
        await page.getByRole('button', { name: 'Every day', exact: true }).click();
        await page.locator('#archive-time').fill('04:15');
      });
      await expect(page.getByText(/Runs every day at 0?4:15/)).toBeVisible();

      await changeStep(page, 'Schedule', async () => {
        await page.getByRole('button', { name: 'Every few hours', exact: true }).click();
        await page.locator('#archive-interval').fill('6');
      });
      await expect(page.getByText('Runs every 6 hours.')).toBeVisible();

      await changeStep(page, 'Schedule', async () => {
        await page.getByRole('button', { name: 'Custom', exact: true }).click();
        await page.locator('#archive-cron').fill('*/15 2-6 * * 1-5');
      });
      await expect(page.getByText('Runs on the schedule */15 2-6 * * 1-5.')).toBeVisible();
    });

    test('follows the cleanup choices, including the mode', async ({ page }) => {
      await openReviewWith(page, { retentionEnabled: false, retentionDays: 0 });
      await expect(page.getByText('Nothing is deleted from the archive.')).toBeVisible();

      page.on('dialog', dialog => dialog.accept());
      await changeStep(page, 'Cleanup', async () => {
        await page.getByRole('switch', { name: /prune the archive automatically/i }).click();
      });
      await expect(
        page.getByText('Objects are deleted from the archive 30 days after they were last archived. Files your library no longer has are kept.'),
      ).toBeVisible();

      await changeStep(page, 'Cleanup', async () => {
        await page.getByRole('button', { name: 'Subframes only', exact: true }).click();
        await page.getByRole('switch', { name: /remove local subframes after archiving/i }).click();
      });
      await expect(
        page.getByText('Subframes are deleted from the archive 30 days after they were last archived. Finished images, and files your library no longer has, are kept.'),
      ).toBeVisible();
      await expect(
        page.getByText('Subframes are also deleted from this local Nebulis instance once their archived copy is verified.'),
      ).toBeVisible();
    });

    test('sends a group back to its step from its Edit link', async ({ page }) => {
      await openReviewWith(page, {});
      await page.getByRole('button', { name: 'Edit', exact: true }).nth(2).click();
      await expect(page.getByRole('heading', { name: 'When should it run?' })).toBeVisible();
    });
  });
});
