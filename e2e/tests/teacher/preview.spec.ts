import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Preview player', () => {
  test('lesson constructor has preview and save buttons with back navigation', async ({ page }) => {
    const { teacherCourseId } = fixtures;

    // Go directly to course constructor
    await page.goto(`/teacher/courses/${teacherCourseId}`);
    await expect(page.getByText('Проверяем магазин')).toBeVisible({ timeout: 10000 });

    // Open lesson constructor
    await page.getByRole('button', { name: /Редактировать/ }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);

    // The preview button must be present on the lesson constructor
    await expect(page.getByRole('button', { name: 'Предпросмотр' })).toBeVisible();

    // Save button must also be present
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeVisible();

    // Back to course button should work
    const backBtn = page.getByRole('button', { name: /К курсу/ });
    await expect(backBtn).toBeVisible();

    // Node type badges should be visible if the lesson has content nodes
    // The seeded lesson has story + single_choice + terminal nodes
    const nodeCards = page.locator('[class*="nodeCard"]');
    const nodeCount = await nodeCards.count();
    if (nodeCount > 0) {
      // At least one node type badge should be visible
      await expect(
        page.getByText('Блок истории').first()
      ).toBeVisible();
    }

    // Navigate back to course
    await backBtn.click();
    await page.waitForURL(/\/teacher\/courses\/[^/]+$/);
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
