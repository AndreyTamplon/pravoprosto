import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Asserts that the feedback element on screen shows the expected verdict.
 *
 * The UI is expected to render feedback with a `data-verdict` attribute
 * (e.g. data-verdict="correct").
 */
export async function assertFeedback(
  page: Page,
  verdict: 'correct' | 'partial' | 'incorrect',
): Promise<void> {
  const feedback = page.locator('[data-role="feedback"]');
  await expect(feedback).toBeVisible({ timeout: 10_000 });
  await expect(feedback).toHaveAttribute('data-verdict', verdict);
}

/**
 * Asserts that the lesson completion screen is visible.
 */
export async function assertLessonComplete(page: Page): Promise<void> {
  await expect(
    page
      .locator('text=Миссия выполнена!')
      .or(page.locator('text=Урок завершён')),
  ).toBeVisible({ timeout: 5_000 });
}

/**
 * Asserts that the hearts (lives) indicator shows zero remaining.
 *
 * The UI is expected to render a hearts element with `data-role="hearts"`.
 */
export async function assertHeartsEmpty(page: Page): Promise<void> {
  const hearts = page.locator('[data-role="hearts"]');
  await expect(hearts).toBeVisible();
  await expect(hearts).toHaveAttribute('data-remaining', '0');
}
