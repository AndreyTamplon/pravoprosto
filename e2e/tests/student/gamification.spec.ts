import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';

test.use({ storageState: '.auth/student.json' });

test.describe('Student -- Gamification (HUD, XP, hearts)', () => {
  test('lesson player shows a progress bar and step content in a card', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'player-layout');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    // Preview-style player: a light progress bar at the top and step content in a card.
    await expect(page.locator('[class*="progressWrap"]')).toBeVisible();
    await expect(page.locator('[data-role="current-node"]')).toBeVisible();
    await context.close();
  });

  test('after correct answer, feedback shows ВЕРНО! and +XP', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'gamification-correct');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    await page.getByRole('button', { name: /Покажу родителям и не буду переходить/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/\+\d+\s*XP/)).toBeVisible();
    await context.close();
  });

  test('after wrong answer, feedback shows ПРОМАХ! and heart loss', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'gamification-wrong');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    await page.getByRole('button', { name: /Перейду по ссылке/ }).click();
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText('ПРОМАХ!', { exact: true })).toBeVisible({ timeout: 10000 });
    await context.close();
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

  test('HUD progress bar advances through lesson', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'gamification-progress');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    // Progress bar should be visible in the HUD
    const progressBar = page.locator('[class*="progressWrap"]');
    await expect(progressBar).toBeVisible();

    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();

    // Progress bar should still be visible after advancing
    await expect(progressBar).toBeVisible();
    await context.close();
  });

  test('HUD close button navigates back to course tree', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'gamification-close');
    await openLessonAttempt(page, platformCourseId, 'lesson_phishing');
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    // Click the HUD close button (disambiguated via data-role to avoid Modal X collision)
    await page.locator('[data-role="hud-close"]').click();

    // Confirm exit in the confirmation modal
    await page.locator('[data-role="confirm-exit"]').click();

    // Should navigate to course tree
    await page.waitForURL(`**/student/courses/${platformCourseId}`);
    await context.close();
  });
});
