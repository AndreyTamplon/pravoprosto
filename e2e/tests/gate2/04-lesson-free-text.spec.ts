import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import { openPasswordsFreeTextStep } from '../../helpers/student-lessons';

test.use({ storageState: '.auth/student.json' });

test.describe('Gate 2 -- Lesson with free_text + LLM evaluation (lesson_passwords)', () => {
  test('student completes passwords lesson with free text answer', async ({
    page,
  }) => {
    const { platformCourseId } = fixtures;

    await openPasswordsFreeTextStep(page, platformCourseId);
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await expect(textarea).toBeVisible();

    await textarea.fill(
      '[llm:correct] потому что один взлом откроет все аккаунты',
    );
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Миссия выполнена!')).toBeVisible();
    await expect(page.getByText(/\+\d+/)).toBeVisible();
    await expect(page.getByText('XP')).toBeVisible();
  });

  test('free text with partial verdict shows "ПОЧТИ!"', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await openPasswordsFreeTextStep(page, platformCourseId);
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await textarea.fill('[llm:partial] примерно потому что это опасно');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ПОЧТИ!')).toBeVisible({ timeout: 15000 });
  });

  test('free text with incorrect verdict shows "ПРОМАХ!"', async ({
    page,
  }) => {
    const { platformCourseId } = fixtures;

    await openPasswordsFreeTextStep(page, platformCourseId);
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await textarea.fill('[llm:incorrect] не знаю');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ПРОМАХ!')).toBeVisible({ timeout: 15000 });
  });
});
