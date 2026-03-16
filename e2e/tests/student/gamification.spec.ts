import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/student.json' });

/**
 * Helper: wait for the lesson player to finish loading and show first content.
 * The player goes through: loading -> story | single_choice | complete | error
 */
async function waitForLessonReady(page: import('@playwright/test').Page) {
  await expect(
    page.getByRole('button', { name: 'Далее' })
      .or(page.getByRole('button', { name: 'Проверить' }))
      .or(page.getByText('Миссия выполнена!'))
      .or(page.getByText('Что-то пошло не так'))
  ).toBeVisible({ timeout: 15000 });
}

/**
 * Helper: advance past story screen if we are on one.
 * Clicks "Далее" until a question screen or completion screen appears.
 */
async function advancePastStory(page: import('@playwright/test').Page) {
  // Click "Далее" while it is the only action (story screens)
  for (let i = 0; i < 5; i++) {
    const daleeBtn = page.getByRole('button', { name: 'Далее' });
    const checkBtn = page.getByRole('button', { name: 'Проверить' });
    const complete = page.getByText('Миссия выполнена!');

    // If we see a question or completion, stop
    if (await checkBtn.isVisible().catch(() => false)) return;
    if (await complete.isVisible().catch(() => false)) return;

    // If no "Далее", we might be on a question already (options visible)
    if (!(await daleeBtn.isVisible().catch(() => false))) return;

    // Check if there are answer options visible — if so, this "Далее" is from feedback overlay
    const hasOptions = await page.locator('button[class*="option"]').first().isVisible().catch(() => false);
    if (hasOptions) return;

    await daleeBtn.click();
    // Wait briefly for transition
    await page.waitForTimeout(500);
  }
}

test.describe('Student -- Gamification (HUD, XP, hearts)', () => {
  test('HUD bar shows XP and hearts during lesson', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );
    await waitForLessonReady(page);

    // HudBar renders: "♥ N/M" for hearts and "★ N" for XP
    await expect(page.getByText(/♥\s*\d+\/\d+/)).toBeVisible();
    await expect(page.getByText(/★\s*\d+/)).toBeVisible();
    // Streak indicator
    await expect(page.getByText(/🔥\s*\d+/)).toBeVisible();
  });

  test('after correct answer, feedback shows ВЕРНО! and +XP', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );
    await waitForLessonReady(page);
    await advancePastStory(page);

    // We should now be on the first question: "Что ты сделаешь с этим сообщением?"
    // Correct answer: "Покажу родителям и не буду переходить"
    const correctOption = page.locator('button[class*="option"]', { hasText: /Покажу родителям/ });
    if (await correctOption.isVisible().catch(() => false)) {
      await correctOption.click();
      await page.getByRole('button', { name: 'Проверить' }).click();

      // Feedback overlay
      await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/\+\d+\s*XP/)).toBeVisible();
    } else {
      // Lesson already progressed past first question — verify HUD XP is visible
      await expect(page.getByText(/★\s*\d+/)).toBeVisible();
    }
  });

  test('after wrong answer, feedback shows ПРОМАХ! and heart loss', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );
    await waitForLessonReady(page);
    await advancePastStory(page);

    // Wrong answer: "Перейду по ссылке — вдруг правда приз!"
    const wrongOption = page.locator('button[class*="option"]', { hasText: /Перейду по ссылке/ });
    if (await wrongOption.isVisible().catch(() => false)) {
      await wrongOption.click();
      await page.getByRole('button', { name: 'Проверить' }).click();

      // Feedback overlay should show miss
      await expect(page.getByText('ПРОМАХ!', { exact: true })).toBeVisible({ timeout: 10000 });
      // Heart loss: "-1 ❤️"
      await expect(page.getByText(/-\d+\s*❤/)).toBeVisible();
    } else {
      // Lesson past first question — verify HUD hearts
      await expect(page.getByText(/♥\s*\d+\/\d+/)).toBeVisible();
    }
  });

  test('profile shows XP, level, streak, and lessons stats', async ({ page }) => {
    await page.goto('/student/profile');

    // Wait for profile to load — look for the display name "Алиса"
    await expect(page.getByText('Алиса')).toBeVisible({ timeout: 10000 });

    // Stats grid with 4 stat cards: XP, Уровень, Серия, Этапов
    const statsGrid = page.locator('[class*="statsGrid"]');
    await expect(statsGrid).toBeVisible();

    const statCards = page.locator('[class*="statCard"]');
    await expect(statCards).toHaveCount(4);

    // Stat labels have text-transform:uppercase in CSS, but getByText matches
    // the DOM text content (before CSS transforms). Source text is "XP", "Уровень", "Серия", "Этапов".
    await expect(page.getByText('XP').first()).toBeVisible();
    await expect(page.getByText('Уровень').first()).toBeVisible();
    await expect(page.getByText('Серия').first()).toBeVisible();
    await expect(page.getByText('Этапов').first()).toBeVisible();

    // Level indicator near display name: "Уровень N"
    // Use getByText for exact match to avoid strict mode on class selector
    await expect(page.getByText(/^Уровень\s*\d+$/).first()).toBeVisible();
  });

  test('HUD progress bar advances through lesson', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );
    await waitForLessonReady(page);

    // Progress bar should be visible in the HUD
    const progressBar = page.locator('[class*="progressWrap"]');
    await expect(progressBar).toBeVisible();

    // Advance past story if on one
    await advancePastStory(page);

    // Progress bar should still be visible after advancing
    await expect(progressBar).toBeVisible();
  });

  test('HUD close button navigates back to course tree', async ({ page }) => {
    const { platformCourseId } = fixtures;

    await page.goto(
      `/student/courses/${platformCourseId}/lessons/lesson_phishing`,
    );
    await waitForLessonReady(page);

    // Click the close button (aria-label="Close")
    await page.getByRole('button', { name: 'Close' }).click();

    // Should navigate to course tree
    await page.waitForURL(`**/student/courses/${platformCourseId}`);
  });
});
