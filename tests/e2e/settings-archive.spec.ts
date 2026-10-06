import { test, expect, type Page } from '@playwright/test';
import { mockAdminAuth, mockAllRoutes, mockArchiveRoutes } from './fixtures/mocks';

/**
 * The archive Settings journey.
 *
 * The screen is one of three things: an introduction (off, never set up), a setup
 * wizard (off, being set up), or an overview (on). The assertions are deliberately
 * concrete about what renders, because a settings section is easy to test vacuously: a
 * locator that matches nothing makes every `toHaveCount(0)` pass. So each "this is
 * absent" claim is paired with proof that the thing it should have been is present.
 */

async function openArchiveSection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
}

/** Opens one group of the overview for editing. The Edit buttons are named for their
 *  group, so this cannot open the wrong one. */
async function editGroup(page: Page, group: 'Disk' | 'What to copy' | 'Schedule' | 'Cleanup'): Promise<void> {
  await page.getByRole('button', { name: `Edit: ${group}`, exact: true }).click();
}

/** Every PUT the page makes to the archive, so a test can assert what was sent and not
 *  only what is shown. */
function recordSaves(page: Page): Array<Record<string, unknown>> {
  const saves: Array<Record<string, unknown>> = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/storage/archive')) {
      saves.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  return saves;
}

test.describe('Settings — archive', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await mockArchiveRoutes(page);
    await page.goto('/settings');
  });

  test('is reachable from the Storage group', async ({ page }) => {
    await openArchiveSection(page);
    await expect(page.getByRole('heading', { name: /external archive/i })).toBeVisible();
  });

  /* ─── Overview: the archive is on ─────────────────────────────────────────── */

  test.describe('when the archive is on', () => {
    test.beforeEach(async ({ page }) => {
      await openArchiveSection(page);
    });

    test('shows the disk, whether it is theirs, and that the archive is on', async ({ page }) => {
      await expect(page.getByText('Archive is on', { exact: true })).toBeVisible();
      await expect(page.getByText('/Volumes/Archive', { exact: true })).toBeVisible();
      // The state line is what tells the user whether the disk is really theirs, so it
      // is asserted rather than assumed.
      await expect(page.getByText(/this is your archive disk/i)).toBeVisible();
    });

    test('keeps every setting collapsed until it is opened, one group at a time', async ({ page }) => {
      // Present first: the rows are there, only their controls are not.
      for (const group of ['Disk', 'What to copy', 'Schedule', 'Cleanup']) {
        await expect(page.getByRole('button', { name: `Edit: ${group}`, exact: true })).toBeVisible();
      }
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Archive disk' })).toHaveCount(0);

      await editGroup(page, 'What to copy');
      await expect(page.getByRole('switch', { name: /include subframes/i })).toBeVisible();

      // Opening another closes the first, so the page never grows into one long form.
      await editGroup(page, 'Cleanup');
      await expect(page.getByRole('switch', { name: /include subframes/i })).toHaveCount(0);
      await expect(page.getByRole('switch', { name: /prune the archive automatically/i })).toBeVisible();
    });

    test('offers the picker beside a destination that is wide enough to read', async ({ page }) => {
      await editGroup(page, 'Disk');
      await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Archive disk' })).toHaveValue('/Volumes/Archive');
      // Squeezed into a third of a row, the path field used to be 200px wide.
      const field = await page.getByRole('textbox', { name: 'Archive disk' }).boundingBox();
      expect(field).not.toBeNull();
      expect(field!.width).toBeGreaterThan(400);
    });

    test('offers the disk actions as filled buttons, not as outlined text', async ({ page }) => {
      // `exact` matters: a description that names one of these buttons would otherwise
      // match and be measured.
      for (const name of ['Archive now', 'Browse archive', 'Turn off']) {
        const button = page.getByRole('button', { name, exact: true });
        const box = await button.boundingBox();
        expect(box, `${name} has no box`).not.toBeNull();
        expect(box!.height, `${name} is not padded`).toBeGreaterThan(30);
        const fill = await button.evaluate(el => getComputedStyle(el).backgroundColor);
        expect(fill, `${name} has no fill`).not.toBe('rgba(0, 0, 0, 0)');
      }
    });

    test('runs the archive on demand and reports what it did', async ({ page }) => {
      await page.getByRole('button', { name: 'Archive now', exact: true }).click();
      await expect(page.getByText(/archived 2 files/i)).toBeVisible();
    });

    test('turns off without asking, because nothing can be lost that way', async ({ page }) => {
      let asked = false;
      page.on('dialog', () => {
        asked = true;
      });
      const saves = recordSaves(page);

      await page.getByRole('button', { name: 'Turn off', exact: true }).click();

      await expect(page.getByText('The archive is off', { exact: true })).toBeVisible();
      expect(asked).toBe(false);
      expect(saves.at(-1)).toEqual({ enabled: false });
      // The settings are kept and there are no inert controls left behind.
      await expect(page.getByRole('button', { name: 'Review and turn on', exact: true })).toBeVisible();
      await expect(page.getByRole('switch')).toHaveCount(0);
    });

    test('saves one group, and sends only that group', async ({ page }) => {
      const saves = recordSaves(page);
      await editGroup(page, 'What to copy');
      await page.getByRole('switch', { name: /include subframes/i }).click();
      await page.getByRole('spinbutton', { name: 'Wait before archiving' }).fill('7');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect(page.getByText(/^Saved\.$/)).toBeVisible();
      expect(saves.at(-1)).toEqual({ includeSubframes: false, copyMinAgeDays: 7, copyMinAgeEnabled: true });
      // Saved, so the group closes and reads as a sentence again.
      await expect(page.getByRole('spinbutton', { name: 'Wait before archiving' })).toHaveCount(0);
      await expect(page.getByText('Only files at least 7 days old are archived; newer captures wait.')).toBeVisible();
    });

    test('waits zero days by switching the wait off, so it cannot be saved half-armed', async ({ page }) => {
      await mockArchiveRoutes(page, { config: { copyMinAgeEnabled: true, copyMinAgeDays: 5 } });
      await page.reload();
      await openArchiveSection(page);
      const saves = recordSaves(page);

      await editGroup(page, 'What to copy');
      await expect(page.getByRole('spinbutton', { name: 'Wait before archiving' })).toHaveValue('5');
      await page.getByRole('spinbutton', { name: 'Wait before archiving' }).fill('0');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect(page.getByText(/^Saved\.$/)).toBeVisible();
      expect(saves.at(-1)).toMatchObject({ copyMinAgeDays: 0, copyMinAgeEnabled: false });
    });

    test('drops an edit when the group is closed without saving', async ({ page }) => {
      const saves = recordSaves(page);
      await editGroup(page, 'What to copy');
      await page.getByRole('spinbutton', { name: 'Wait before archiving' }).fill('9');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      expect(saves).toHaveLength(0);
      await editGroup(page, 'What to copy');
      await expect(page.getByRole('spinbutton', { name: 'Wait before archiving' })).toHaveValue('0');
    });

    test('shows the help text for a setting where it is chosen, not behind an icon', async ({ page }) => {
      await editGroup(page, 'What to copy');
      await expect(page.getByText(/subframes are the individual raw exposures/i)).toBeVisible();
      await editGroup(page, 'Cleanup');
      await expect(page.getByText(/Frees space on this machine/i)).toBeVisible();
    });
  });

  /* ─── Adopting the disk ───────────────────────────────────────────────────── */

  test('offers adoption only when there is a disk to adopt', async ({ page }) => {
    await mockArchiveRoutes(page, { destinationState: 'absent' });
    await page.reload();
    await openArchiveSection(page);

    await expect(page.getByRole('button', { name: /adopt this disk/i })).toBeVisible();
    await expect(page.getByText(/no archive in this folder yet/i)).toBeVisible();
    // A disk that has not been claimed cannot be copied to.
    await expect(page.getByRole('button', { name: 'Archive now', exact: true })).toBeDisabled();
  });

  test('names the archive it would take over, and asks first', async ({ page }) => {
    await mockArchiveRoutes(page, { destinationState: 'foreign', foundArchiveId: 'someone-elses' });
    await page.reload();
    await openArchiveSection(page);

    let prompt = '';
    page.on('dialog', dialog => {
      prompt = dialog.message();
      dialog.dismiss();
    });

    await page.getByRole('button', { name: /adopt this disk/i }).click();
    // Polled rather than read once: the confirm fires inside an async handler, after
    // the click has already been dispatched and resolved. The confirmation has to name
    // what is being replaced, or it is asking the user to agree to nothing in particular.
    await expect.poll(() => prompt).toContain('someone-elses');
  });

  /* ─── The schedule editor ─────────────────────────────────────────────────── */

  test.describe('the schedule', () => {
    test.beforeEach(async ({ page }) => {
      await mockArchiveRoutes(page, {
        config: { enabled: true, scheduleEnabled: true, scheduleMode: 'daily', scheduleHour: 2, scheduleMinute: 30 },
      });
      await page.reload();
      await openArchiveSection(page);
      await editGroup(page, 'Schedule');
    });

    test('is one choice, and shows the time for the daily one', async ({ page }) => {
      for (const choice of ['Manual only', 'Every day', 'Every few hours', 'Custom']) {
        await expect(page.getByRole('button', { name: choice, exact: true })).toBeVisible();
      }
      await expect(page.locator('#archive-time')).toHaveValue('02:30');
      await expect(page.locator('#archive-cron')).toHaveCount(0);
      await expect(page.locator('#archive-interval')).toHaveCount(0);
    });

    test('swaps the field for each choice, and saves the expression', async ({ page }) => {
      const saves = recordSaves(page);

      await page.getByRole('button', { name: 'Custom', exact: true }).click();
      // Only the field that choice needs: the time is gone, the expression is here.
      await expect(page.locator('#archive-time')).toHaveCount(0);
      await page.locator('#archive-cron').fill('*/15 2-6 * * 1-5');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/^Saved\.$/)).toBeVisible();
      expect(saves.at(-1)).toMatchObject({
        scheduleEnabled: true,
        scheduleMode: 'custom',
        scheduleCron: '*/15 2-6 * * 1-5',
      });
    });

    test('offers the interval, and saves it', async ({ page }) => {
      const saves = recordSaves(page);
      await page.getByRole('button', { name: 'Every few hours', exact: true }).click();
      await expect(page.locator('#archive-time')).toHaveCount(0);
      await page.locator('#archive-interval').fill('6');

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Runs every 6 hours.')).toBeVisible();
      expect(saves.at(-1)).toMatchObject({ scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalHours: 6 });
    });

    test('turns the schedule off with "Manual only", and says nothing runs on its own', async ({ page }) => {
      const saves = recordSaves(page);
      await page.getByRole('button', { name: 'Manual only', exact: true }).click();
      await expect(page.getByText(/nothing runs on its own/i)).toBeVisible();

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Runs only when you press Archive now.')).toBeVisible();
      expect(saves.at(-1)).toMatchObject({ scheduleEnabled: false });
    });

    test('saves from a simple choice even when the cron box was left half-typed', async ({ page }) => {
      const saves = recordSaves(page);

      await page.getByRole('button', { name: 'Custom', exact: true }).click();
      await page.locator('#archive-cron').fill('not a cron expression');
      await page.getByRole('button', { name: 'Every day', exact: true }).click();

      // The expression is off screen, so it must not be sent: a refusal over an
      // invisible field would block every other setting in the group.
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/^Saved\.$/)).toBeVisible();
      expect(saves.at(-1)).not.toHaveProperty('scheduleCron');
      expect(saves.at(-1)).toMatchObject({ scheduleMode: 'daily' });
    });

    test('keeps every label on one line', async ({ page }) => {
      await page.getByRole('button', { name: 'Every few hours', exact: true }).click();
      for (const name of ['Run', 'Hours between runs']) {
        const label = await page.getByText(name, { exact: true }).boundingBox();
        expect(label, `${name} is not rendered`).not.toBeNull();
        expect(label!.height, `${name} wrapped`).toBeLessThan(28);
      }
    });
  });

  /* ─── The cleanup editor ──────────────────────────────────────────────────── */

  test.describe('cleanup', () => {
    test.beforeEach(async ({ page }) => {
      await mockArchiveRoutes(page, { config: { enabled: true, retentionEnabled: false, retentionDays: 0 } });
      await page.reload();
      await openArchiveSection(page);
      await editGroup(page, 'Cleanup');
    });

    test('has both destructive options off, with the controls present', async ({ page }) => {
      for (const name of [/prune the archive automatically/i, /remove local subframes after archiving/i]) {
        const control = page.getByRole('switch', { name });
        // Present first: a missing switch would make the assertion below vacuous.
        await expect(control).toBeVisible();
        await expect(control).toHaveAttribute('aria-checked', 'false');
      }
      await expect(page.getByText(/deletes subframes from your library permanently/i)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Prune now', exact: true })).toBeDisabled();
    });

    test('does not switch local removal on when the confirmation is dismissed', async ({ page }) => {
      page.on('dialog', dialog => dialog.dismiss());
      await page.getByRole('switch', { name: /remove local subframes after archiving/i }).click();
      await expect(page.getByRole('switch', { name: /remove local subframes after archiving/i })).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText(/deletes subframes from your library permanently/i)).toHaveCount(0);
    });

    test('switches local removal on, and warns where it is, once accepted', async ({ page }) => {
      page.on('dialog', dialog => dialog.accept());
      await page.getByRole('switch', { name: /remove local subframes after archiving/i }).click();
      await expect(page.getByRole('switch', { name: /remove local subframes after archiving/i })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByText(/deletes subframes from your library permanently/i)).toBeVisible();
    });

    test('asks before arming pruning, and offers a period at the same time', async ({ page }) => {
      let warning = '';
      page.on('dialog', dialog => {
        warning = dialog.message();
        dialog.accept();
      });

      await page.getByRole('switch', { name: /prune the archive automatically/i }).click();

      await expect(page.getByRole('switch', { name: /prune the archive automatically/i })).toHaveAttribute('aria-checked', 'true');
      // Armed with no period would be refused by the server, so the pair arrives
      // together rather than leaving the form in a state it cannot save.
      await expect(page.getByRole('spinbutton', { name: 'Delete from the archive after' })).toHaveValue('30');
      expect(warning).toMatch(/will be deleted/i);
    });

    test('hides the period and mode until pruning is on, and offers both modes as a choice', async ({ page }) => {
      await expect(page.getByRole('spinbutton', { name: 'Delete from the archive after' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Whole objects', exact: true })).toHaveCount(0);

      page.on('dialog', dialog => dialog.accept());
      await page.getByRole('switch', { name: /prune the archive automatically/i }).click();
      await expect(page.getByRole('button', { name: 'Whole objects', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Subframes only', exact: true }).click();

      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/subframes are deleted from the archive 30 days/i)).toBeVisible();
    });

    test('does not arm Prune now from an unsaved switch', async ({ page }) => {
      const prune = page.getByRole('button', { name: 'Prune now', exact: true });
      await expect(prune).toBeDisabled();

      page.on('dialog', dialog => dialog.accept());
      await page.getByRole('switch', { name: /prune the archive automatically/i }).click();

      // The switch is on screen, but nothing is stored yet and the apply route reads
      // what is stored. A live button here would open a confirmation naming real files
      // and then refuse the request.
      await expect(page.getByRole('switch', { name: /prune the archive automatically/i })).toHaveAttribute('aria-checked', 'true');
      await expect(prune).toBeDisabled();

      // And with the switch stored on, the button is usable. Reloaded rather than read
      // straight after a save, because saving re-reads the disk and the fixture reports
      // a freshly saved destination as having no archive on it yet.
      await mockArchiveRoutes(page, { config: { enabled: true, retentionEnabled: true, retentionDays: 30 } });
      await page.reload();
      await openArchiveSection(page);
      await editGroup(page, 'Cleanup');
      await expect(page.getByRole('button', { name: 'Prune now', exact: true })).toBeEnabled();
    });

    test('puts the destructive options in one box, with the switch on its heading line', async ({ page }) => {
      const label = await page.getByText('Prune the archive automatically', { exact: true }).boundingBox();
      const control = await page.getByRole('switch', { name: /prune the archive automatically/i }).boundingBox();
      expect(label).not.toBeNull();
      expect(control).not.toBeNull();
      expect(Math.abs(control!.y + control!.height / 2 - (label!.y + label!.height / 2))).toBeLessThan(12);

      // Both options sit in the same red box, so they read as one "this deletes" area
      // rather than as one danger block and an orphaned second toggle.
      const removal = await page.getByRole('switch', { name: /remove local subframes after archiving/i }).boundingBox();
      expect(removal).not.toBeNull();
      expect(Math.abs(removal!.x - control!.x)).toBeLessThan(2);
    });
  });

  /* ─── Intro and wizard: the archive is off ────────────────────────────────── */

  test.describe('when the archive is off and was never set up', () => {
    test.beforeEach(async ({ page }) => {
      await mockArchiveRoutes(page, { config: { enabled: false, path: '' } });
      await page.reload();
      await openArchiveSection(page);
    });

    test('offers one button, and no page of inert controls', async ({ page }) => {
      await expect(page.getByText('Set up your archive', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Set up archive', exact: true })).toBeVisible();
      // The old page showed every control, dimmed, under an off switch.
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Archive now', exact: true })).toHaveCount(0);
    });

    test('walks the steps in order, and arms nothing until the last', async ({ page }) => {
      const saves = recordSaves(page);
      let asked = false;
      page.on('dialog', () => {
        asked = true;
      });

      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();

      // 1. Disk. Next waits for a folder, because there is nothing to save without one.
      await expect(page.getByRole('heading', { name: 'Choose the archive disk' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
      await page.getByRole('textbox', { name: 'Archive disk' }).fill('/Volumes/New');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      // The folder is recorded, and only the folder: the switch is still off.
      await expect.poll(() => saves.length).toBe(1);
      expect(saves[0]).toEqual({ path: '/Volumes/New' });

      // 2. What to copy.
      await expect(page.getByRole('heading', { name: 'What should be copied?' })).toBeVisible();
      await page.getByRole('switch', { name: /include subframes/i }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();

      // 3. Schedule.
      await expect(page.getByRole('heading', { name: 'When should it run?' })).toBeVisible();
      await page.getByRole('button', { name: 'Every day', exact: true }).click();
      await page.locator('#archive-time').fill('03:15');
      await page.getByRole('button', { name: 'Next', exact: true }).click();

      // 4. Cleanup, left at its defaults: nothing deletes.
      await expect(page.getByRole('heading', { name: 'Delete anything afterward?' })).toBeVisible();
      await page.getByRole('button', { name: 'Next', exact: true }).click();

      // 5. Review, which says what will happen before anything happens.
      await expect(page.getByRole('heading', { name: 'Ready to turn it on?' })).toBeVisible();
      await expect(page.getByText('Copies every object in your library to /Volumes/New.')).toBeVisible();
      await expect(page.getByText(/Runs every day at 0?3:15/)).toBeVisible();
      await expect(page.getByText('Nothing is deleted from the archive.')).toBeVisible();
      expect(saves).toHaveLength(1);

      await page.getByRole('button', { name: 'Turn on archive', exact: true }).click();
      await expect(page.getByText('Archive is on', { exact: true })).toBeVisible();

      // Everything arrives in one save, with the switch, and no confirmation was
      // needed for a step-by-step choice the user has just reviewed.
      expect(saves).toHaveLength(2);
      expect(saves[1]).toMatchObject({
        enabled: true,
        path: '/Volumes/New',
        includeSubframes: false,
        scheduleEnabled: true,
        scheduleMode: 'daily',
        scheduleHour: 3,
        scheduleMinute: 15,
        retentionEnabled: false,
        removeLocalAfter: false,
      });
      expect(asked).toBe(false);
    });

    test('claims a disk that has no archive on it, after the switch and not before', async ({ page }) => {
      const order: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url()).pathname;
        if (request.method() === 'PUT' && url.endsWith('/storage/archive')) {
          order.push(`save:${JSON.stringify(request.postDataJSON())}`);
        }
        if (request.method() === 'POST' && url.endsWith('/archive/adopt')) order.push('adopt');
      });

      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();
      await page.getByRole('textbox', { name: 'Archive disk' }).fill('/Volumes/New');
      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
      // Says so on the review, because the disk is about to be written to.
      await expect(page.getByText(/will claim this folder as your archive when you turn the archive on/i)).toBeVisible();
      await page.getByRole('button', { name: 'Turn on archive', exact: true }).click();

      await expect.poll(() => order.includes('adopt')).toBe(true);
      // The server refuses a claim while the archive is off, so it has to come last.
      expect(order.at(-1)).toBe('adopt');
      expect(order.at(-2)).toContain('"enabled":true');
    });

    test('lets a passed step be revisited, but not skipped ahead to', async ({ page }) => {
      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();
      const steps = page.getByRole('list', { name: 'Setup steps' });
      await expect(steps.getByRole('button', { name: /Schedule/ })).toBeDisabled();

      await page.getByRole('textbox', { name: 'Archive disk' }).fill('/Volumes/New');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'What should be copied?' })).toBeVisible();

      await steps.getByRole('button', { name: /Disk/ }).click();
      await expect(page.getByRole('heading', { name: 'Choose the archive disk' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Archive disk' })).toHaveValue('/Volumes/New');
      await expect(steps.getByRole('button', { name: /Schedule/ })).toBeDisabled();
    });

    test('holds a custom schedule until it has an expression', async ({ page }) => {
      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();
      await page.getByRole('textbox', { name: 'Archive disk' }).fill('/Volumes/New');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();

      await page.getByRole('button', { name: 'Custom', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
      await page.locator('#archive-cron').fill('0 3 * * *');
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    });

    test('asks before arming a destructive option, on the cleanup step', async ({ page }) => {
      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();
      await page.getByRole('textbox', { name: 'Archive disk' }).fill('/Volumes/New');
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();

      await expect(page.getByRole('switch', { name: /prune the archive automatically/i })).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByRole('switch', { name: /remove local subframes after archiving/i })).toHaveAttribute('aria-checked', 'false');

      let warning = '';
      page.on('dialog', dialog => {
        warning = dialog.message();
        dialog.dismiss();
      });
      await page.getByRole('switch', { name: /remove local subframes after archiving/i }).click();
      await expect.poll(() => warning).toMatch(/permanent deletion of local subframes/i);
      await expect(page.getByRole('switch', { name: /remove local subframes after archiving/i })).toHaveAttribute('aria-checked', 'false');
    });

    test('sends nothing when setup is cancelled', async ({ page }) => {
      const saves = recordSaves(page);
      await page.getByRole('button', { name: 'Set up archive', exact: true }).click();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      await expect(page.getByText('Set up your archive', { exact: true })).toBeVisible();
      expect(saves).toHaveLength(0);
    });
  });

  test.describe('when the archive is off but was set up before', () => {
    test.beforeEach(async ({ page }) => {
      await mockArchiveRoutes(page, { config: { enabled: false } });
      await page.reload();
      await openArchiveSection(page);
    });

    test('says the settings are kept, and goes straight to the review', async ({ page }) => {
      await expect(page.getByText('The archive is off', { exact: true })).toBeVisible();
      await expect(page.getByText(/your settings are saved/i)).toBeVisible();

      await page.getByRole('button', { name: 'Review and turn on', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Ready to turn it on?' })).toBeVisible();
      await expect(page.getByText('Copies every object in your library to /Volumes/Archive.')).toBeVisible();

      const saves = recordSaves(page);
      await page.getByRole('button', { name: 'Turn on archive', exact: true }).click();
      await expect(page.getByText('Archive is on', { exact: true })).toBeVisible();
      expect(saves.at(-1)).toMatchObject({ enabled: true, path: '/Volumes/Archive' });
    });

    test('can go back through the steps to change something first', async ({ page }) => {
      await page.getByRole('button', { name: 'Change settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Choose the archive disk' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Archive disk' })).toHaveValue('/Volumes/Archive');
    });
  });

  test('asks about a foreign disk before saving anything, and leaves the archive off when declined', async ({ page }) => {
    // A share, because saving a local path in this fixture rewrites the disk's state
    // and would lose the foreign one this test is about.
    await mockArchiveRoutes(page, {
      config: {
        enabled: false,
        locationType: 'network',
        path: '',
        network: { host: 'nas.local', share: 'Archive', domain: '', username: 'alice', hasPassword: true, subpath: 'Other' },
      },
      destinationState: 'foreign',
      foundArchiveId: 'someone-elses',
    });
    await page.reload();
    await openArchiveSection(page);
    const saves = recordSaves(page);

    let prompt = '';
    page.on('dialog', dialog => {
      prompt = dialog.message();
      dialog.dismiss();
    });

    await page.getByRole('button', { name: 'Review and turn on', exact: true }).click();
    await page.getByRole('button', { name: 'Turn on archive', exact: true }).click();

    await expect.poll(() => prompt).toContain('someone-elses');
    expect(saves).toHaveLength(0);
    await expect(page.getByRole('heading', { name: 'Ready to turn it on?' })).toBeVisible();
  });
});
