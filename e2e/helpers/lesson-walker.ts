import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Describes an answer for a specific node in the lesson graph.
 */
export interface Answer {
  /** For single_choice: text of the option to click. */
  optionText?: string;
  /** For free_text: the text to type into the textarea. */
  freeText?: string;
}

/**
 * Walks through a lesson by detecting the current node type from the UI
 * and interacting accordingly.
 *
 * @param page    - Playwright Page instance, assumed to be on a lesson page.
 * @param answers - Optional map of prompt text -> Answer. If not provided,
 *                  defaults to clicking the first option or typing a generic answer.
 */
export async function walkLesson(
  page: Page,
  answers?: Map<string, Answer>,
): Promise<void> {
  const maxSteps = 50; // safety limit

  for (let step = 0; step < maxSteps; step++) {
    // Check if lesson is complete
    const completionText = page.locator('text=Миссия выполнена!').or(
      page.locator('text=Урок завершён'),
    );

    if (await completionText.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return; // lesson done
    }

    // Check for end node text (the final summary before "Миссия выполнена")
    const endNode = page.locator('[data-node-kind="end"]');
    if (await endNode.isVisible({ timeout: 500 }).catch(() => false)) {
      return; // at the end
    }

    // Detect node type and act
    const storyNode = page.locator('[data-node-kind="story"]');
    const singleChoiceNode = page.locator('[data-node-kind="single_choice"]');
    const freeTextNode = page.locator('[data-node-kind="free_text"]');

    if (await storyNode.isVisible({ timeout: 1_000 }).catch(() => false)) {
      // Story node: click "Далее"
      await page.getByRole('button', { name: /Далее/i }).click();
      await page.waitForTimeout(300);
      continue;
    }

    if (
      await singleChoiceNode.isVisible({ timeout: 1_000 }).catch(() => false)
    ) {
      // Single choice: find prompt, pick answer, verify, continue
      const prompt = await singleChoiceNode
        .locator('[data-role="prompt"]')
        .textContent();

      const answer = answers?.get(prompt ?? '');

      if (answer?.optionText) {
        await page.getByText(answer.optionText, { exact: false }).click();
      } else {
        // Default: click the first option
        const options = singleChoiceNode.locator('[data-role="option"]');
        await options.first().click();
      }

      // Click "Проверить"
      await page.getByRole('button', { name: /Проверить/i }).click();

      // Wait for feedback to appear
      await page
        .locator('[data-role="feedback"]')
        .waitFor({ state: 'visible', timeout: 10_000 });

      // Click "Далее"
      await page.getByRole('button', { name: /Далее/i }).click();
      await page.waitForTimeout(300);
      continue;
    }

    if (await freeTextNode.isVisible({ timeout: 1_000 }).catch(() => false)) {
      // Free text: find prompt, type answer, verify, continue
      const prompt = await freeTextNode
        .locator('[data-role="prompt"]')
        .textContent();

      const answer = answers?.get(prompt ?? '');
      const text =
        answer?.freeText ?? 'Это мой ответ на вопрос. Нельзя так делать.';

      const textarea = freeTextNode.locator('textarea').or(
        freeTextNode.locator('input[type="text"]'),
      );
      await textarea.fill(text);

      // Click "Проверить"
      await page.getByRole('button', { name: /Проверить/i }).click();

      // Wait for feedback (LLM call may take a moment)
      await page
        .locator('[data-role="feedback"]')
        .waitFor({ state: 'visible', timeout: 15_000 });

      // Click "Далее"
      await page.getByRole('button', { name: /Далее/i }).click();
      await page.waitForTimeout(300);
      continue;
    }

    // Fallback: if nothing matched, try clicking a generic "Далее" button
    const nextButton = page.getByRole('button', { name: /Далее/i });
    if (await nextButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await nextButton.click();
      await page.waitForTimeout(300);
      continue;
    }

    // If truly stuck, break
    break;
  }
}

/**
 * Walks a lesson providing only correct answers.
 * Requires the answers map with correct option texts.
 */
export async function walkLessonCorrectly(
  page: Page,
  correctAnswers: Map<string, Answer>,
): Promise<void> {
  await walkLesson(page, correctAnswers);
  await expect(
    page.locator('text=Миссия выполнена!').or(page.locator('text=Урок завершён')),
  ).toBeVisible({ timeout: 5_000 });
}
