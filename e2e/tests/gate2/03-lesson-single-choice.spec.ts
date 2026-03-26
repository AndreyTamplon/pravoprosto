import { test, expect } from '@playwright/test';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';
import {
  buildBranchingSingleChoiceLesson,
  buildMultiVerdictSingleChoiceLesson,
  createAdminCourseWithDraft,
  publishAdminCourse,
} from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';

test.describe('Gate 2 -- Single-choice branching runtime', () => {
  test('student sees incorrect feedback, loses a heart, follows remediation branch, then can retry and finish via success branch', async ({
    browser,
  }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `branch_choice_${Date.now()}`;
    const lesson = buildBranchingSingleChoiceLesson({
      lessonId,
      title: 'Ветвящийся single choice',
      introText: 'Ты нашёл подозрительный интернет-магазин с суперскидкой.',
      questionText: 'Что сделаешь сначала?',
      correctOptionText: 'Проверю отзывы и сравню цену',
      incorrectOptionText: 'Сразу оплачу, пока скидка не пропала',
      remediationText: 'Сначала остановись и проверь магазин: это отдельная ветка после ошибки.',
      successText: 'Верно: проверка магазина ведёт по правильной ветке.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Gate Branch Choice ${Date.now()}`,
      description: 'Курс для проверки ветвления single-choice',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_branch_choice',
          title: 'Ветвление single-choice',
          lessons: [lesson],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const context = await browser.newContext({ storageState: '.auth/student2.json' });
    const page = await context.newPage();
    await page.goto('/student/courses');

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
    await expect(page.locator('[data-role="prompt"]')).toContainText('подозрительный интернет-магазин');

    const heartsBefore = await page.locator('[data-role="hearts"]').getAttribute('data-remaining');
    expect(heartsBefore).toBe('5');

    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="single_choice"]')).toBeVisible();
    await expect(page.locator('[data-role="prompt"]')).toContainText('Что сделаешь сначала?');

    await page.getByRole('button', { name: 'Сразу оплачу, пока скидка не пропала' }).click();
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();

    const feedback = page.locator('[data-role="feedback"]');
    await expect(feedback).toBeVisible({ timeout: 10000 });
    await expect(feedback).toHaveAttribute('data-verdict', 'incorrect');
    await expect(feedback).toContainText('Неправильно');
    await expect(feedback).toContainText('Сначала проверь');
    await expect(page.getByText('-1 ❤️')).toBeVisible();
    await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', '4');

    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="story"]')).toBeVisible();
    await expect(page.locator('[data-role="prompt"]')).toContainText('отдельная ветка после ошибки');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="end"]')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Завершить миссию' }).click();
    await expect(page.locator('[data-role="lesson-complete"]')).toBeVisible({ timeout: 10000 });

    await openLessonAttempt(page, courseId, lessonId);
    await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', '4');
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByRole('button', { name: 'Проверю отзывы и сравню цену' }).click();
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    const correctFeedback = page.locator('[data-role="feedback"]');
    await expect(correctFeedback).toHaveAttribute('data-verdict', 'correct');
    await expect(correctFeedback).toContainText('Правильно');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="story"]')).toBeVisible();
    await expect(page.locator('[data-role="prompt"]')).toContainText('правильной ветке');
    await expect(page.getByText('отдельная ветка после ошибки')).not.toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="end"]')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Завершить миссию' }).click();
    await expect(page.locator('[data-role="lesson-complete"]')).toBeVisible({ timeout: 10000 });
    await context.close();
  });

  test('instant-complete answer updates HUD XP exactly once', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `instant_complete_choice_${Date.now()}`;
    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Gate Instant Complete XP ${Date.now()}`,
      description: 'Курс для проверки HUD XP на instant-complete answer',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_instant_complete_choice',
          title: 'Instant complete',
          lessons: [
            {
              id: lessonId,
              title: 'Одношаговый вопрос',
              graph: {
                startNodeId: `${lessonId}_question`,
                nodes: [
                  {
                    id: `${lessonId}_question`,
                    kind: 'single_choice',
                    prompt: 'Какой ответ ведёт к завершению без лишних шагов?',
                    options: [
                      {
                        id: `${lessonId}_correct`,
                        text: 'Правильный ответ',
                        result: 'correct',
                        feedback: 'Верно: урок завершается сразу после ответа.',
                        nextNodeId: `${lessonId}_end`,
                      },
                      {
                        id: `${lessonId}_incorrect`,
                        text: 'Неправильный ответ',
                        result: 'incorrect',
                        feedback: 'Неверно: но урок тоже сразу завершится.',
                        nextNodeId: `${lessonId}_end`,
                      },
                    ],
                  },
                  {
                    id: `${lessonId}_end`,
                    kind: 'end',
                    text: 'Финал instant-complete урока',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context, page } = await createFreshStudentPage(browser, 'instant-complete-xp');

    await expect
      .poll(async () => {
        const response = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, {
          fallbackPath: '/student/courses',
        });
        return response.status;
      }, { timeout: 10000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);
    await expect(page.locator('[data-node-kind="single_choice"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="xp"]')).toHaveAttribute('data-value', '0');

    await page.getByRole('button', { name: 'Правильный ответ', exact: true }).click();
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();

    const feedback = page.locator('[data-role="feedback"]');
    await expect(feedback).toBeVisible({ timeout: 10000 });
    await expect(feedback).toHaveAttribute('data-verdict', 'correct');
    await expect(feedback).toContainText('+10 XP');
    await expect(page.locator('[data-role="xp"]')).toHaveAttribute('data-value', '10');

    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-role="lesson-complete"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-role="lesson-complete"]')).toContainText('+10');

    await context.close();
  });

  test('multiple correct options and partial option all survive the full student flow', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `multi_verdict_choice_${Date.now()}`;
    const lesson = buildMultiVerdictSingleChoiceLesson({
      lessonId,
      title: 'Multi verdict choice',
      questionText: 'Что стоит сделать перед оплатой?',
      correctA: 'Проверить отзывы',
      correctB: 'Сравнить цену с другими магазинами',
      partial: 'Посмотреть только красивый дизайн сайта',
      incorrect: 'Сразу оплатить заказ',
      successText: 'Полностью правильная ветка.',
      partialText: 'Почти правильная ветка.',
      incorrectText: 'Неправильная ветка.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Gate Multi Verdict ${Date.now()}`,
      description: 'Курс для проверки multiple correct и partial verdict',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_multi_verdict_choice',
          title: 'Multi verdict',
          lessons: [lesson],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const context = await browser.newContext({ storageState: '.auth/student.json' });
    const page = await context.newPage();
    await page.goto('/student/courses');
    await expect
      .poll(async () => {
        const response = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, {
          fallbackPath: '/student/courses',
        });
        return response.status;
      }, { timeout: 10000 })
      .toBe(200);

    const verifyOutcome = async (
      answerText: string,
      verdict: 'correct' | 'partial' | 'incorrect',
      expectedBranch: string,
      expectedXpText: string,
      expectedHearts: string,
    ) => {
      await openLessonAttempt(page, courseId, lessonId);
      await expect(page.locator('[data-node-kind="single_choice"]')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: answerText, exact: true }).click();
      await page.getByRole('button', { name: 'Проверить', exact: true }).click();

      const feedback = page.locator('[data-role="feedback"]');
      await expect(feedback).toBeVisible({ timeout: 10000 });
      await expect(feedback).toHaveAttribute('data-verdict', verdict);
      await expect(feedback).toContainText(expectedXpText);
      await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', expectedHearts);

      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.locator('[data-role="prompt"]')).toContainText(expectedBranch);
      await page.getByRole('button', { name: 'Далее' }).click();
      await expect(page.locator('[data-node-kind="end"]')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: 'Завершить миссию' }).click();
      await expect(page.locator('[data-role="lesson-complete"]')).toBeVisible({ timeout: 10000 });
    };

    await verifyOutcome('Проверить отзывы', 'correct', 'Полностью правильная ветка.', '+10 XP', '5');
    await verifyOutcome('Сравнить цену с другими магазинами', 'correct', 'Полностью правильная ветка.', '+10 XP', '5');
    await verifyOutcome('Посмотреть только красивый дизайн сайта', 'partial', 'Почти правильная ветка.', '+5 XP', '5');
    await verifyOutcome('Сразу оплатить заказ', 'incorrect', 'Неправильная ветка.', '-1 ❤️', '4');
    await context.close();
  });
});
