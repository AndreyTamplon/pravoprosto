import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import type { Page } from '@playwright/test';

test.use({ storageState: '.auth/student.json' });

/**
 * Helper: complete lesson_phishing so that lesson_passwords becomes unlocked.
 * lesson_passwords is locked by prerequisite (lesson_phishing must be completed first).
 */
async function completePhishingLessonIfNeeded(page: Page) {
  const { platformCourseId } = fixtures;

  // Start the phishing lesson
  await page.goto(
    `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
  );

  // Wait for any lesson content to appear
  await page.waitForTimeout(1000);
  await expect(
    page.getByRole('button', { name: 'Далее' })
      .or(page.getByRole('button', { name: 'Проверить' }))
      .or(page.getByText('Миссия выполнена!'))
      .or(page.getByText(/Что-то пошло не так/))
  ).toBeVisible({ timeout: 10000 });

  // If already complete or error, skip
  if (await page.getByText('Миссия выполнена!').isVisible().catch(() => false)) {
    return;
  }
  if (await page.getByText(/Что-то пошло не так/).isVisible().catch(() => false)) {
    return;
  }

  // Walk through the phishing lesson: s1 -> q1 correct -> s2 -> q2 correct -> complete
  // s1: story
  if (await page.getByText(/Тебе пришло сообщение/).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(500);
  }

  // q1: correct answer
  if (await page.getByRole('button', { name: /Покажу родителям/ }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Покажу родителям/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(500);
  }

  // s2: story
  if (await page.getByText(/Мошенники часто используют/).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(500);
  }

  // q2: correct answer
  if (await page.getByRole('button', { name: /Просят срочно/ }).isVisible().catch(() => false)) {
    await page.getByRole('button', { name: /Просят срочно/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.waitForTimeout(500);
  }

  // Completion screen
  await expect(page.getByText('Миссия выполнена!')).toBeVisible({ timeout: 10000 });
}

test.describe('Gate 2 -- Lesson with free_text + LLM evaluation (lesson_passwords)', () => {
  test('student completes passwords lesson with free text answer', async ({
    page,
  }) => {
    const { platformCourseId } = fixtures;

    // First, complete the phishing lesson to unlock passwords
    await completePhishingLessonIfNeeded(page);

    // Now navigate to the passwords lesson
    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_passwords`,
    );

    // 3. Story ps1: "Пароль -- это ключ к твоим данным."
    await expect(page.getByText(/Пароль.*ключ к твоим данным/)).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // 4. Question pq1: "Какой пароль самый надёжный?"
    await expect(
      page.getByText('Какой пароль самый надёжный?'),
    ).toBeVisible();

    // Select correct answer "Kx9#mL2$vQ"
    await page.getByRole('button', { name: /Kx9#mL2/ }).click();

    // Click "Проверить"
    await page.getByRole('button', { name: 'Проверить' }).click();

    // Should see "ВЕРНО!" feedback
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Случайная комбинация/),
    ).toBeVisible();

    // Continue to next question
    await page.getByRole('button', { name: 'Далее' }).click();

    // 5. Free text pq2: "Объясни своими словами, почему нельзя..."
    await expect(
      page.getByText(/почему нельзя использовать один пароль/),
    ).toBeVisible();

    // Verify textarea is present
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await expect(textarea).toBeVisible();

    // 6. Type answer with [llm:correct] control code
    await textarea.fill(
      '[llm:correct] потому что один взлом откроет все аккаунты',
    );

    // Click "Проверить"
    await page.getByRole('button', { name: 'Проверить' }).click();

    // 7. Should show the "checking" state briefly
    //    The checking screen shows "Проверяем ответ..."
    //    It may flash quickly so we use a soft check
    const checkingText = page.getByText('Проверяем ответ...');
    // Wait for either the checking text or the result
    await expect(
      page.getByText('ВЕРНО!').or(checkingText),
    ).toBeVisible({ timeout: 15000 });

    // 8. See "ВЕРНО!" feedback (after LLM finishes)
    await expect(page.getByText('ВЕРНО!')).toBeVisible({ timeout: 15000 });

    // 9. Click "Далее" to complete
    await page.getByRole('button', { name: 'Далее' }).click();

    // Should see lesson completion screen
    await expect(page.getByText('Миссия выполнена!')).toBeVisible();

    // Verify XP earned
    await expect(page.getByText(/\+\d+/)).toBeVisible();
    await expect(page.getByText('XP')).toBeVisible();
  });

  test('free text with partial verdict shows "ПОЧТИ!"', async ({ page }) => {
    const { platformCourseId } = fixtures;

    // Complete phishing lesson first to unlock passwords
    await completePhishingLessonIfNeeded(page);

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_passwords`,
    );

    // Story ps1 -> Далее
    await expect(page.getByText(/Пароль.*ключ/)).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Question pq1 -> correct answer -> Далее
    await page.getByRole('button', { name: /Kx9#mL2/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Free text pq2 with partial verdict
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await textarea.fill('[llm:partial] примерно потому что это опасно');
    await page.getByRole('button', { name: 'Проверить' }).click();

    // Should see "ПОЧТИ!" feedback
    await expect(page.getByText('ПОЧТИ!')).toBeVisible({ timeout: 15000 });
  });

  test('free text with incorrect verdict shows "ПРОМАХ!"', async ({
    page,
  }) => {
    const { platformCourseId } = fixtures;

    // Complete phishing lesson first to unlock passwords
    await completePhishingLessonIfNeeded(page);

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_passwords`,
    );

    // Story ps1 -> Далее
    await expect(page.getByText(/Пароль.*ключ/)).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Question pq1 -> correct answer -> Далее
    await page.getByRole('button', { name: /Kx9#mL2/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // Free text pq2 with incorrect verdict
    const textarea = page.getByPlaceholder('Напиши свой ответ...');
    await textarea.fill('[llm:incorrect] не знаю');
    await page.getByRole('button', { name: 'Проверить' }).click();

    // Should see "ПРОМАХ!" feedback
    await expect(page.getByText('ПРОМАХ!')).toBeVisible({ timeout: 15000 });
  });
});
