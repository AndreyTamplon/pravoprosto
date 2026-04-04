/**
 * QA Regression: Payment result pages (/success and /fail)
 *
 * T-Bank redirects user to these pages after checkout.
 * They must render properly (not 404) and show appropriate content.
 */
import { test, expect } from '@playwright/test';

test.describe('Payment result pages', () => {
  test('/success page renders with success message', async ({ page }) => {
    await page.goto('/success');

    // Should NOT show 404
    await expect(page.getByText('404')).not.toBeVisible();

    // Should show success content
    await expect(page.getByRole('heading', { name: /Оплата прошла успешно/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Доступ к уроку уже открыт/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Продолжить/i })).toBeVisible();
  });

  test('/fail page renders with failure message', async ({ page }) => {
    await page.goto('/fail');

    // Should NOT show 404
    await expect(page.getByText('404')).not.toBeVisible();

    // Should show failure content
    await expect(page.getByRole('heading', { name: /Оплата не прошла/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Попробуйте ещё раз/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Вернуться/i })).toBeVisible();
  });

  test('/success button navigates to home for anonymous user', async ({ page }) => {
    await page.goto('/success');
    await expect(page.getByRole('button', { name: /Продолжить/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Продолжить/i }).click();
    // Anonymous user should see the landing page
    await expect(page.getByText('Право Просто').first()).toBeVisible({ timeout: 10000 });
  });

  test('/success button navigates to parent dashboard for parent', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: '.auth/parent.json' });
    const page = await ctx.newPage();

    await page.goto('/success');
    await expect(page.getByRole('button', { name: /Продолжить/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Продолжить/i }).click();
    await page.waitForURL('**/parent');

    await ctx.close();
  });

  test('/success button navigates to student catalog for student', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: '.auth/student.json' });
    const page = await ctx.newPage();

    await page.goto('/success');
    await expect(page.getByRole('button', { name: /Продолжить/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /Продолжить/i }).click();
    await page.waitForURL('**/student/courses');

    await ctx.close();
  });
});
