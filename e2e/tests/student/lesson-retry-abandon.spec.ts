import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import {
  completePhishingLesson,
  createFreshStudentPage,
  openLessonAttempt,
} from '../../helpers/student-lessons';

test.describe('Student — Lesson retry & abandon', () => {
  test('A1: «Пройти заново» на complete-экране перезапускает урок с первого шага', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'retry-from-ui');
    await completePhishingLesson(page, platformCourseId);

    // Complete screen visible
    await expect(page.getByText('Миссия выполнена!')).toBeVisible();

    // Click «Пройти заново»
    await page.locator('[data-role="lesson-retry"]').click();

    // Should land on the first step of the phishing lesson (first story about a suspicious message)
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    // HUD progress should be back to a low value (first step)
    const progressAria = await page
      .locator('[role="progressbar"]')
      .first()
      .getAttribute('aria-valuenow')
      .catch(() => null);
    if (progressAria !== null) {
      expect(Number(progressAria)).toBeLessThan(50);
    }

    await context.close();
  });

  test('A2: clicking close → confirm Выйти → re-entering lesson starts at first step', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'abandon-restart');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');

    // First story step
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    // Advance to step 2 (the question)
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    // Click HUD close → confirm modal opens
    await page.locator('[data-role="hud-close"]').click();
    await expect(page.getByRole('dialog', { name: 'Выйти из этапа?' })).toBeVisible();

    // Confirm exit
    await page.locator('[data-role="confirm-exit"]').click();
    await page.waitForURL(`**/student/courses/${platformCourseId}`);

    // Re-enter the same lesson
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    // Should land on first story (not the question)
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toHaveCount(0);

    await context.close();
  });

  test('A3: reload mid-lesson resumes on the same step (D-1 invariant)', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'reload-resumes');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');

    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    // Reload — should resume on the question, NOT restart at the first step
    await page.reload();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible({ timeout: 10000 });

    await context.close();
  });

  test('A10(a): «Остаться» keeps you in the lesson and does not abandon', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'confirm-stay');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');

    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    // Open confirm modal
    await page.locator('[data-role="hud-close"]').click();
    await expect(page.getByRole('dialog', { name: 'Выйти из этапа?' })).toBeVisible();

    // Cancel via «Остаться»
    await page.locator('[data-role="confirm-stay"]').click();
    await expect(page.getByRole('dialog', { name: 'Выйти из этапа?' })).toHaveCount(0);

    // Still on the question screen (no abandon, no navigation)
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();
    expect(page.url()).toContain('/lessons/lesson_phishing');

    await context.close();
  });

  test('A10(c): ESC closes confirm modal without abandoning', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'confirm-esc');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');

    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    await page.locator('[data-role="hud-close"]').click();
    await expect(page.getByRole('dialog', { name: 'Выйти из этапа?' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Выйти из этапа?' })).toHaveCount(0);

    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();
    expect(page.url()).toContain('/lessons/lesson_phishing');

    await context.close();
  });
});
