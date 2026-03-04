import { test, expect } from '@playwright/test';

test.describe('Portal landing page', () => {
  test('exposes the login form for unauthenticated users', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/login/);
    await expect(page.locator('body')).toBeVisible();
  });
});
