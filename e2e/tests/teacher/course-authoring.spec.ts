import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Course authoring dashboard', () => {
  test('dashboard shows "Покупки онлайн" course card with published badge and student count', async ({ page }) => {
    await page.goto('/teacher');

    await expect(page.getByRole('heading', { name: 'Мои курсы' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Создать курс/ })).toBeVisible();

    // Course card: title
    await expect(page.getByText('Покупки онлайн')).toBeVisible();

    // Course card: "Опубликован" badge (published workflow_status AND has_published_revision)
    // TeacherDashboard renders two badges when both conditions are true
    const publishedBadges = page.getByText('Опубликован');
    await expect(publishedBadges.first()).toBeVisible();

    // Course card: student count (e.g. "0 учеников") — use .first() since multiple cards may exist
    await expect(page.getByText(/\d+\s*учеников/).first()).toBeVisible();

    // Course card should be clickable — navigate to constructor
    await page.getByText('Покупки онлайн').click();
    await page.waitForURL(/\/teacher\/courses\/.+/);
    // Verify we landed on the constructor
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
