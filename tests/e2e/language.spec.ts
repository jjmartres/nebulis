import { test, expect } from '@playwright/test';
import { mockAllRoutes } from './fixtures/mocks';

test.describe('Language setting', () => {
  test.beforeEach(async ({ page }) => {
    await mockAllRoutes(page);
    await page.goto('/settings');
  });

  test('shows a language dropdown defaulting to English', async ({ page }) => {
    const select = page.getByRole('combobox', { name: /display language/i });
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('en');
    await expect(page.getByText('Language', { exact: true })).toBeVisible();
  });

  test('switching to German updates the UI immediately, no reload', async ({ page }) => {
    const select = page.getByRole('combobox', { name: /display language/i });
    await select.selectOption('de');

    await expect(page.getByText('Sprache', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');

    // Persists across a reload (localStorage), and no server round trip was needed.
    await page.reload();
    await expect(page.getByText('Sprache', { exact: true })).toBeVisible();
  });
});
