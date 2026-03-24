import { test, expect } from '@playwright/test';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';
import {
  buildBranchingFreeTextLesson,
  createAdminCourseWithDraft,
  publishAdminCourse,
} from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';

test.describe('Gate 2 -- Free-text branching runtime', () => {
  test('correct, partial, and incorrect free-text answers take different branches with matching verdicts and rewards', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `branch_free_text_${Date.now()}`;
    const lesson = buildBranchingFreeTextLesson({
      lessonId,
      title: 'Ветвящийся free-text',
      introText: 'Объясни, почему нельзя использовать один пароль везде.',
      questionText: 'Почему опасно использовать один пароль для всех сайтов?',
      referenceAnswer: 'Один взлом откроет доступ ко всем аккаунтам.',
      criteria: 'Нужно упомянуть, что компрометация одного пароля ставит под угрозу все аккаунты.',
      correctText: 'Верный маршрут: ты объяснил риск для всех аккаунтов.',
      partialText: 'Частично верный маршрут: идея понятна, но ответ можно усилить.',
      incorrectText: 'Неверный маршрут: ответ не объясняет реальный риск повторного использования пароля.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Gate Branch FreeText ${Date.now()}`,
      description: 'Курс для проверки ветвления free-text',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_branch_free_text',
          title: 'Ветвление free-text',
          lessons: [lesson],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const verifyBranch = async (
      codePrefix: string,
      answer: string,
      verdict: 'correct' | 'partial' | 'incorrect',
      branchText: string,
      expectedHearts: string,
      expectedXpText: string,
    ) => {
      const { context, page } = await createFreshStudentPage(browser, codePrefix);
      await expect
        .poll(async () => {
          const response = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, {
            fallbackPath: '/student/courses',
          });
          return response.status;
        }, { timeout: 10000 })
        .toBe(200);

      await openLessonAttempt(page, courseId, lessonId);
      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible({ timeout: 10000 });
      await page.getByPlaceholder('Напиши свой ответ...').fill(answer);
      await page.getByRole('button', { name: 'Проверить' }).click();

      const feedback = page.locator('[data-role="feedback"]');
      await expect(feedback).toBeVisible({ timeout: 15000 });
      await expect(feedback).toHaveAttribute('data-verdict', verdict);
      await expect(feedback).toContainText(expectedXpText);
      await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', expectedHearts);

      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.locator('[data-node-kind="story"]')).toBeVisible();
      await expect(page.locator('[data-role="prompt"]')).toContainText(branchText);
      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.locator('[data-node-kind="end"]')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: 'Завершить миссию' }).click();
      await expect(page.locator('[data-role="lesson-complete"]')).toBeVisible({ timeout: 10000 });
      await context.close();
    };

    await verifyBranch(
      'free-text-correct',
      '[llm:correct] один взлом откроет доступ ко всем аккаунтам',
      'correct',
      'Верный маршрут',
      '5',
      '+10 XP',
    );
    await verifyBranch(
      'free-text-partial',
      '[llm:partial] потому что это опасно',
      'partial',
      'Частично верный маршрут',
      '5',
      '+5 XP',
    );
    await verifyBranch(
      'free-text-incorrect',
      '[llm:incorrect] просто так нельзя',
      'incorrect',
      'Неверный маршрут',
      '4',
      '-1 ❤️',
    );
  });
});
