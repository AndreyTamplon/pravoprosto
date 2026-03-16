import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Access links', () => {
  test('can view and create access links for a published course', async ({ page }) => {
    await page.goto('/teacher');

    // Navigate to "Покупки онлайн" course
    await page.getByText('Покупки онлайн').click();
    await page.waitForURL(/\/teacher\/courses\/.+/);

    // Click "Поделиться" button to open share modal
    await page.getByRole('button', { name: 'Поделиться' }).click();

    // Should see "Поделиться курсом" modal
    // CourseConstructor.tsx: Modal title="Поделиться курсом"
    await expect(page.getByText('Поделиться курсом')).toBeVisible();

    // Should see explanation text
    // CourseConstructor.tsx: <p>Создайте ссылку для приглашения учеников в курс.</p>
    await expect(
      page.getByText(/Создайте ссылку для приглашения учеников/),
    ).toBeVisible();

    // The seed already created an access link, so it should be visible
    // Check for existing link URL or create a new one
    const existingLinks = page.locator('[class*="linkUrl"]');
    const linkCount = await existingLinks.count();

    if (linkCount > 0) {
      // Existing link should have "Копировать" and "Отозвать" buttons
      await expect(page.getByRole('button', { name: 'Копировать' }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Отозвать' }).first()).toBeVisible();
    }

    // Create a new link
    await page.getByRole('button', { name: /Создать ссылку/ }).click();

    // New link should appear in the list
    await expect(page.getByRole('button', { name: 'Копировать' }).first()).toBeVisible();

    // Should be able to revoke a link
    await expect(page.getByRole('button', { name: 'Отозвать' }).first()).toBeVisible();
  });
});
