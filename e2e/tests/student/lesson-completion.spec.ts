import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/student.json' });

test.describe('Student -- Lesson completion screen', () => {
  /**
   * Helper: play through lesson_phishing (s1 -> q1 correct -> s2 -> q2 correct -> end).
   * Navigates to the completion screen.
   */
  async function completePhishingLesson(page: import('@playwright/test').Page) {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );

    // Wait for the lesson to load
    await page.waitForTimeout(1000);
    await expect(
      page.getByRole('button', { name: 'Далее' })
        .or(page.getByRole('button', { name: 'Проверить' }))
        .or(page.getByText('Миссия выполнена!'))
    ).toBeVisible({ timeout: 10000 });

    // If already completed, we're done
    if (await page.getByText('Миссия выполнена!').isVisible().catch(() => false)) return;

    // s1: story (if visible)
    if (await page.getByText(/Тебе пришло сообщение/).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.waitForTimeout(500);
    }

    // q1: correct answer (if visible)
    if (await page.getByRole('button', { name: /Покажу родителям/ }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /Покажу родителям/ }).click();
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.waitForTimeout(500);
    }

    // s2: story (if visible)
    if (await page.getByText(/Мошенники часто используют/).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.waitForTimeout(500);
    }

    // q2: correct answer (if visible)
    if (await page.getByRole('button', { name: /Просят срочно/ }).isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /Просят срочно/ }).click();
      await page.getByRole('button', { name: 'Проверить' }).click();
      await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.waitForTimeout(500);
    }

    // Now on completion screen
    await expect(page.getByText('Миссия выполнена!')).toBeVisible({ timeout: 10000 });
  }

  test('"Миссия выполнена!" text is visible after completing a lesson', async ({
    page,
  }) => {
    await completePhishingLesson(page);

    // 1. "Миссия выполнена!" text visible
    await expect(page.getByText('Миссия выполнена!')).toBeVisible();
  });

  test('XP amount is shown on completion', async ({ page }) => {
    await completePhishingLesson(page);

    // 2. XP amount shown (format: +N)
    await expect(page.getByText(/\+\d+/)).toBeVisible();
    await expect(page.getByText('XP')).toBeVisible();
  });

  test('"К миссии" button navigates to course tree', async ({ page }) => {
    const { platformCourseId } = fixtures;
    await completePhishingLesson(page);

    // 3. Click "К миссии" button
    await page.getByRole('button', { name: 'К миссии' }).click();

    // Should navigate to course tree
    await page.waitForURL(`**/student/courses/${platformCourseId}`);
    await expect(
      page.getByText('Безопасность в интернете'),
    ).toBeVisible();
  });

  test('"Штаб героя" button navigates to catalog', async ({ page }) => {
    await completePhishingLesson(page);

    // 4. Click "Штаб героя" button
    await page.getByRole('button', { name: 'Штаб героя' }).click();

    // Should navigate to catalog
    await page.waitForURL('**/student/courses');
    await expect(page.getByText('Штаб героя')).toBeVisible();
  });

  test('completion screen shows elapsed time', async ({ page }) => {
    await completePhishingLesson(page);

    // Time stat is shown (format: Nм)
    await expect(page.getByText(/\d+м/)).toBeVisible();
  });
});
