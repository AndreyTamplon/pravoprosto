import { test, expect } from '@playwright/test';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';
import {
  buildDecisionBranchingLesson,
  createAdminCourseWithDraft,
  publishAdminCourse,
} from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';

test.describe('Gate 2 -- Decision branching and backtracking', () => {
  test('student can go back to the previous narrative choice, switch branch, and resume correctly after refresh', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `decision_back_${Date.now()}`;
    const lesson = buildDecisionBranchingLesson({
      lessonId,
      title: 'Decision branch',
      introText: 'Перед тобой важный выбор.',
      decisionText: 'Как поступишь дальше?',
      branchAText: 'Ветка A: сначала проверяешь факты.',
      branchBText: 'Ветка B: действуешь слишком поспешно.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Gate Decision Back ${Date.now()}`,
      description: 'Курс для проверки narrative branching и возврата назад',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_decision_back',
          title: 'Decision back',
          lessons: [lesson],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context, page } = await createFreshStudentPage(browser, 'decision-back');

    await expect
      .poll(async () => {
        const response = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, {
          fallbackPath: '/student/courses',
        });
        return response.status;
      }, { timeout: 10000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);
    await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();

    await expect(page.locator('[data-node-kind="decision"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="prompt"]')).toContainText('Как поступишь дальше?');
    await page.getByRole('button', { name: 'Сначала проверить факты', exact: true }).click();
    await page.getByRole('button', { name: 'Выбрать' }).click();

    await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="prompt"]')).toContainText('Ветка A');
    await expect(page.getByRole('button', { name: 'Назад к выбору' })).toBeVisible();

    await page.getByRole('button', { name: 'Назад к выбору' }).click();
    await expect(page.locator('[data-node-kind="decision"]')).toBeVisible({ timeout: 10000 });

    await page.reload();
    await expect(page.locator('[data-node-kind="decision"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="prompt"]')).toContainText('Как поступишь дальше?');

    await page.getByRole('button', { name: 'Сразу принять решение', exact: true }).click();
    await page.getByRole('button', { name: 'Выбрать' }).click();

    await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="prompt"]')).toContainText('Ветка B');
    await expect(page.getByText('Ветка A: сначала проверяешь факты.')).not.toBeVisible();

    await page.reload();
    await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="prompt"]')).toContainText('Ветка B');

    await context.close();
  });
});
