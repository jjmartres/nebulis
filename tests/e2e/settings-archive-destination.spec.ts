import { test, expect, type Page } from '@playwright/test';
import { json, mockAdminAuth, mockAllRoutes, mockArchiveRoutes, ok } from './fixtures/mocks';

/**
 * Choosing the archive destination: the drive, the folder, and the share.
 *
 * The journey this file exists for is the one the feature was asked for: point the
 * archive at a folder without typing a path, or at a share on the network with
 * credentials, and have the section show what was chosen. So each test walks the real
 * modal and then asserts what the settings section shows afterwards, which is where a
 * choice that was silently dropped would show up.
 */

const VOLUME = '/Volumes/TestDisk';

async function mockDrives(page: Page): Promise<void> {
  await page.route('**/api/storage/volumes', r =>
    r.fulfill(json(ok({
      volumes: [
        { path: VOLUME, label: 'Test Disk', totalBytes: 1e12, freeBytes: 512e9, writable: true, external: true },
      ],
    }))));
  await page.route('**/api/storage/browse**', r => {
    const requested = new URL(r.request().url()).searchParams.get('path') ?? '';
    const directories = requested === VOLUME
      ? [{ name: 'Archive', path: `${VOLUME}/Archive` }]
      : [];
    r.fulfill(json(ok({ path: requested, directories })));
  });
}

async function openSection(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  // The destination is edited from the Disk group of the overview, which is collapsed
  // until it is opened. Everything below starts from the open editor.
  await page.getByRole('button', { name: 'Edit: Disk', exact: true }).click();
}

/** Every PUT and POST the page makes, so the test can assert what was sent rather
 *  than only what is shown. */
function recordWrites(page: Page): Array<{ method: string; url: string; body: unknown }> {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  page.on('request', request => {
    const method = request.method();
    if (method !== 'PUT' && method !== 'POST') return;
    if (!request.url().includes('/api/storage/archive')) return;
    writes.push({
      method,
      url: new URL(request.url()).pathname,
      body: request.postDataJSON() as unknown,
    });
  });
  return writes;
}

test.describe('Settings — choosing the archive destination', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await mockAdminAuth(page);
    await mockArchiveRoutes(page);
    await mockDrives(page);
  });

  test('opens the picker from the destination row and lists the drives', async ({ page }) => {
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { level: 3, name: /choose the archive destination/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Test Disk/ })).toBeVisible();
    await expect(dialog.getByText(VOLUME)).toBeVisible();
  });

  test('drills into a folder and puts it in the destination field', async ({ page }) => {
    const writes = recordWrites(page);
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Test Disk/ }).click();
    await dialog.getByRole('button', { name: /Archive/ }).first().click();
    await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();

    // The section shows the chosen folder, and the save went out as a local path.
    await expect(page.getByRole('textbox', { name: 'Archive disk' })).toHaveValue(`${VOLUME}/Archive`);
    await expect(page.getByText(/^Destination saved\.$/)).toBeVisible();
    expect(writes.find(w => w.method === 'PUT')?.body).toMatchObject({
      locationType: 'local',
      path: `${VOLUME}/Archive`,
    });
  });

  test('creates a folder the user names, and adopts it as one to create', async ({ page }) => {
    const writes = recordWrites(page);
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Test Disk/ }).click();
    await dialog.getByLabel('Folder name', { exact: true }).fill('Nebulis Archive');
    // Shown twice on purpose: under the field and in the footer summary.
    await expect(dialog.getByText(`${VOLUME}/Nebulis Archive`).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();

    // Adopting a folder the picker named is the one case that may create it.
    await page.getByRole('button', { name: /adopt this disk/i }).click();
    await expect.poll(() => writes.filter(w => w.url.endsWith('/archive/adopt')).length).toBe(1);
    const adopt = writes.find(w => w.url.endsWith('/archive/adopt'));
    expect(adopt?.body).toMatchObject({ createFolder: true });
  });

  test('picks an existing folder without asking for it to be created', async ({ page }) => {
    const writes = recordWrites(page);
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /Test Disk/ }).click();
    await dialog.getByRole('button', { name: /Archive/ }).first().click();
    await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await page.getByRole('button', { name: /adopt this disk/i }).click();

    await expect.poll(() => writes.filter(w => w.url.endsWith('/archive/adopt')).length).toBe(1);
    expect(writes.find(w => w.url.endsWith('/archive/adopt'))?.body).toMatchObject({ createFolder: false });
  });

  test('saves a network share, with the credentials, and shows the share afterwards', async ({ page }) => {
    const writes = recordWrites(page);
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Network share', exact: true }).click();
    await dialog.getByLabel('Server', { exact: true }).fill('nas.local');
    await dialog.getByLabel('Share', { exact: true }).fill('Archive');
    await dialog.getByLabel('Username', { exact: true }).fill('alice');
    await dialog.getByLabel('Password', { exact: true }).fill('hunter2');
    await dialog.getByRole('button', { name: /test connection/i }).click();

    await expect(dialog.getByText(/^Connected\./)).toBeVisible();

    // The subpath starts empty, so the click below is what puts a value in it: the
    // field is not pre-filled with the folder this test clicks, which is what made an
    // earlier version of this assertion pass without the browser working at all.
    await expect(dialog.getByLabel('Folder inside the share', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: /Other/ }).first().click();
    await expect(dialog.getByLabel('Folder inside the share', { exact: true })).toHaveValue('Other');
    await dialog.getByRole('button', { name: 'Use this share', exact: true }).click();

    // Shown in the status block and in the open editor, so either is the answer.
    await expect(page.getByText('\\\\nas.local\\Archive\\Other', { exact: true }).first()).toBeVisible();
    const put = writes.find(w => w.method === 'PUT');
    expect(put?.body).toMatchObject({
      locationType: 'network',
      network: { host: 'nas.local', share: 'Archive', username: 'alice', subpath: 'Other', password: 'hunter2' },
    });
  });

  test('forgets a stored password when asked, and says so in the save', async ({ page }) => {
    const writes = recordWrites(page);
    await mockArchiveRoutes(page, {
      config: {
        locationType: 'network',
        path: '',
        network: {
          host: 'nas.local', share: 'Archive', domain: '', username: 'alice', hasPassword: true, subpath: 'Other',
        },
      },
      destinationState: 'offline',
    });
    await openSection(page);
    await page.getByRole('button', { name: 'Change share', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/a password is saved/i)).toBeVisible();
    await dialog.getByRole('button', { name: /test connection/i }).click();
    await expect(dialog.getByText(/^Connected\./)).toBeVisible();

    await dialog.getByRole('button', { name: 'Forget the saved password', exact: true }).click();
    // The credential changed, so the connection test no longer stands and the save has
    // to wait for a new one. That is the honest behaviour, not a wart.
    await expect(dialog.getByText(/a password is saved/i)).toHaveCount(0);
    await dialog.getByRole('button', { name: /test connection/i }).click();
    await expect(dialog.getByText(/^Connected\./)).toBeVisible();
    await dialog.getByRole('button', { name: 'Use this share', exact: true }).click();

    const put = writes.find(w => w.method === 'PUT');
    expect(put?.body).toMatchObject({ network: { clearPassword: true, password: '' } });
  });

  test('takes a pasted UNC path and splits it into the fields', async ({ page }) => {
    // What a person who knows what a UNC path is does first. It used to be refused as
    // "characters that cannot be used", which is true of the field and not the address.
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Network share', exact: true }).click();
    await dialog.getByLabel('Server', { exact: true }).fill('\\\\192.168.1.12\\Nebulis2');

    await expect(dialog.getByLabel('Server', { exact: true })).toHaveValue('192.168.1.12');
    await expect(dialog.getByLabel('Share', { exact: true })).toHaveValue('Nebulis2');
  });

  test('reports why a share could not be reached, and refuses to save it', async ({ page }) => {
    await mockArchiveRoutes(page, {
      testResult: { ok: false, reason: 'Authentication failed. Check the username, password, and domain.' },
    });
    await openSection(page);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Network share', exact: true }).click();
    await dialog.getByLabel('Server', { exact: true }).fill('nas.local');
    await dialog.getByLabel('Share', { exact: true }).fill('Archive');
    await dialog.getByRole('button', { name: /test connection/i }).click();

    // The server's own words, not a generic failure.
    await expect(dialog.getByText(/Authentication failed/)).toBeVisible();
    // And nothing can be saved on the strength of a failed test.
    const useShare = dialog.getByRole('button', { name: 'Use this share', exact: true });
    await expect(useShare).toBeVisible();
    await expect(useShare).toBeDisabled();
  });

  test('reports an unconnected share as offline, and does not offer to adopt it', async ({ page }) => {
    await mockArchiveRoutes(page, {
      config: {
        locationType: 'network',
        path: '',
        network: { host: 'nas.local', share: 'Archive', domain: '', username: 'alice', hasPassword: true, subpath: 'Nebulis-Archive' },
      },
      destinationState: 'offline',
    });
    await openSection(page);

    // Said in the status block and again in the open editor.
    await expect(page.getByText(/this share is not connected/i).first()).toBeVisible();
    await expect(page.getByText('\\\\nas.local\\Archive\\Nebulis-Archive', { exact: true }).first()).toBeVisible();
    // The important half: an unmounted share must not look like a disk waiting to be
    // adopted, because its mount directory is an ordinary empty folder underneath.
    await expect(page.getByRole('button', { name: /adopt this disk/i })).toHaveCount(0);
  });

  test('keeps the chosen share editable through the same picker', async ({ page }) => {
    await mockArchiveRoutes(page, {
      config: {
        locationType: 'network',
        path: '',
        network: { host: 'nas.local', share: 'Archive', domain: '', username: 'alice', hasPassword: true, subpath: 'Nebulis-Archive' },
      },
      destinationState: 'offline',
    });
    await openSection(page);

    // A network destination has no path to type, so the picker is the only way to
    // change it: the button has to be there, and it opens on the network tab.
    await page.getByRole('button', { name: 'Change share', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Server', { exact: true })).toHaveValue('nas.local');
    await expect(dialog.getByLabel('Share', { exact: true })).toHaveValue('Archive');
    await expect(dialog.getByLabel('Folder inside the share', { exact: true })).toHaveValue('Nebulis-Archive');
    // The password field says one is stored rather than showing it or forgetting it.
    await expect(dialog.getByText(/a password is saved/i)).toBeVisible();
  });
});
