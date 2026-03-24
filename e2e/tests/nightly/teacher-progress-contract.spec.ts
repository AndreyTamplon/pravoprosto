import { test, expect, type Page } from '@playwright/test';
import {
  buildBranchingSingleChoiceLesson,
  createTeacherAccessLink,
  createTeacherCourseWithDraft,
  approveTeacherCourse,
  submitTeacherCourseForReview,
} from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';
import { createFreshStudentPage } from '../../helpers/student-lessons';

async function completeSingleChoiceLesson(params: {
  page: Page;
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  expectedPrompt: string;
  optionText: string;
  expectedVerdict: 'correct' | 'incorrect';
  expectedBranchText: string;
}) {
  const {
    page,
    courseId,
    lessonId,
    lessonTitle,
    expectedPrompt,
    optionText,
    expectedVerdict,
    expectedBranchText,
  } = params;

  await page.goto(`/student/courses/${courseId}`);
  const lessonTitleNode = page.getByText(lessonTitle, { exact: true });
  await expect(lessonTitleNode).toBeVisible({ timeout: 10000 });
  const startButton = lessonTitleNode.locator(
    'xpath=ancestor::div[1]/following-sibling::div//button[contains(., "Начать миссию") or contains(., "Продолжить")]',
  );
  await expect(startButton).toBeVisible({ timeout: 10000 });
  await startButton.click();
  await page.waitForURL(new RegExp(`/student/courses/${courseId}/lessons/${lessonId}$`));
  await expect(page.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.locator('[data-node-kind="single_choice"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-role="prompt"]')).toHaveText(expectedPrompt);
  const questionNode = page.locator('[data-node-kind="single_choice"]');
  await questionNode.getByRole('button', { name: optionText, exact: true }).click();
  await questionNode.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', expectedVerdict);

  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.getByText(expectedBranchText)).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(page.locator('[data-node-kind="end"]')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Завершить миссию' }).click();
  await expect(page.getByText('Миссия выполнена!')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'К миссии' }).click();
  await page.waitForURL(new RegExp(`/student/courses/${courseId}$`));
}

test.describe('Nightly: teacher progress contract', () => {
  test('teacher list and detail show exact progress, XP, accuracy, and lesson verdicts for a mixed-result student', async ({
    browser,
  }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const teacherPage = await teacherContext.newPage();
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const courseTitle = `Nightly Progress ${Date.now()}`;
    const course = await createTeacherCourseWithDraft(teacherPage, {
      title: courseTitle,
      description: 'Курс для проверки точного teacher progress contract',
      modules: [
        {
          id: 'module_progress',
          title: 'Тренировка прогресса',
          lessons: [
            buildBranchingSingleChoiceLesson({
              lessonId: 'lesson_progress_safe',
              title: 'Проверка адреса',
              introText: 'Перед тобой ссылка на незнакомый сайт.',
              questionText: 'Что нужно сделать перед переходом?',
              correctOptionText: 'Проверить адрес сайта',
              incorrectOptionText: 'Сразу открыть страницу',
              remediationText: 'Сначала нужно проверить адрес сайта.',
              successText: 'Верно, адрес сайта нужно проверить.',
            }),
            buildBranchingSingleChoiceLesson({
              lessonId: 'lesson_progress_secret',
              title: 'Личные данные',
              introText: 'Тебя попросили отправить пароль в чате.',
              questionText: 'Как поступить безопасно?',
              correctOptionText: 'Никому не отправлять пароль',
              incorrectOptionText: 'Отправить пароль сообщением',
              remediationText: 'Пароль нельзя отправлять даже знакомым.',
              successText: 'Правильно, пароль нельзя никому сообщать.',
            }),
          ],
        },
      ],
    });
    await submitTeacherCourseForReview(teacherPage, course.courseId);
    await approveTeacherCourse(adminPage, course.courseId);
    const accessLink = await createTeacherAccessLink(teacherPage, course.courseId);

    const {
      context: studentContext,
      page: studentPage,
      loginCode: studentDisplayName,
    } = await createFreshStudentPage(browser, 'nightly-progress');
    await studentPage.goto(accessLink.claimUrl);
    await expect(studentPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({
      timeout: 15000,
    });
    await studentPage.getByRole('button', { name: 'Продолжить' }).click();
    await studentPage.waitForURL(/\/student\/courses/);

    await completeSingleChoiceLesson({
      page: studentPage,
      courseId: course.courseId,
      lessonId: 'lesson_progress_safe',
      lessonTitle: 'Проверка адреса',
      expectedPrompt: 'Что нужно сделать перед переходом?',
      optionText: 'Проверить адрес сайта',
      expectedVerdict: 'correct',
      expectedBranchText: 'Верно, адрес сайта нужно проверить.',
    });

    const treeAfterFirstLesson = await apiRequest<{
      progress?: { completed_lessons?: number; total_lessons?: number };
      modules?: Array<{
        lessons?: Array<{
          lesson_id?: string;
          status?: string;
          access?: { access_state?: string };
        }>;
      }>;
    }>(studentPage, 'GET', `/student/courses/${course.courseId}`, undefined, {
      fallbackPath: `/student/courses/${course.courseId}`,
    });
    expect(treeAfterFirstLesson.status).toBe(200);
    expect(treeAfterFirstLesson.body?.progress?.completed_lessons).toBe(1);
    expect(treeAfterFirstLesson.body?.progress?.total_lessons).toBe(2);
    const flatLessons = (treeAfterFirstLesson.body?.modules ?? []).flatMap((module) => module.lessons ?? []);
    const firstLessonTree = flatLessons.find((lesson) => lesson.lesson_id === 'lesson_progress_safe');
    const secondLessonTree = flatLessons.find((lesson) => lesson.lesson_id === 'lesson_progress_secret');
    expect(firstLessonTree?.status).toBe('completed');
    expect(firstLessonTree?.access?.access_state).toBe('completed');
    expect(secondLessonTree?.status).toBe('not_started');
    expect(secondLessonTree?.access?.access_state).toBe('free');

    await completeSingleChoiceLesson({
      page: studentPage,
      courseId: course.courseId,
      lessonId: 'lesson_progress_secret',
      lessonTitle: 'Личные данные',
      expectedPrompt: 'Как поступить безопасно?',
      optionText: 'Отправить пароль сообщением',
      expectedVerdict: 'incorrect',
      expectedBranchText: 'Пароль нельзя отправлять даже знакомым.',
    });

    const studentsResponse = teacherPage.waitForResponse((response) =>
      response.request().method() === 'GET'
      && response.url().includes(`/api/v1/teacher/courses/${course.courseId}/students`)
      && response.status() === 200,
    );
    await teacherPage.goto(`/teacher/courses/${course.courseId}/students`);
    await expect(teacherPage.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({
      timeout: 10000,
    });

    const studentsPayload = await (await studentsResponse).json().catch(() => null);
    const students = Array.isArray(studentsPayload?.students) ? studentsPayload.students : [];
    const studentEntry = students.find(
      (item: Record<string, unknown>) => item.display_name === studentDisplayName,
    );
    expect(studentEntry).toBeTruthy();
    expect(studentEntry?.progress_percent).toBe(100);
    expect(studentEntry?.xp_total).toBe(10);
    expect(studentEntry?.correctness_percent).toBe(50);

    const studentRow = teacherPage.locator('tbody tr').filter({ hasText: studentDisplayName }).first();
    await expect(studentRow).toBeVisible({ timeout: 10000 });
    await expect(studentRow.locator('td').nth(2)).toHaveText('10');
    await expect(studentRow.locator('td').nth(3)).toHaveText('50%');
    await expect(studentRow.locator('td').nth(1).locator('div[style*="width"]').first()).toHaveAttribute(
      'style',
      /width: 100%/,
    );
    await expect(studentRow).not.toContainText('NaN');
    await expect(studentRow).not.toContainText('undefined');

    await studentRow.click();
    await teacherPage.waitForURL(new RegExp(`/teacher/courses/${course.courseId}/students/.+$`));
    await expect(teacherPage.getByRole('heading', { name: studentDisplayName })).toBeVisible();
    await expect(
      teacherPage.getByText('Прогресс: 100% · XP: 10 · Точность: 50%'),
    ).toBeVisible();

    const safeLessonRow = teacherPage.locator('tbody tr').filter({ hasText: 'Проверка адреса' }).first();
    await expect(safeLessonRow).toContainText('Завершён');
    await expect(safeLessonRow).toContainText('Верно');
    await expect(safeLessonRow.locator('td').nth(3)).toHaveText('1');

    const secretLessonRow = teacherPage.locator('tbody tr').filter({ hasText: 'Личные данные' }).first();
    await expect(secretLessonRow).toContainText('Завершён');
    await expect(secretLessonRow).toContainText('Неверно');
    await expect(secretLessonRow.locator('td').nth(3)).toHaveText('1');

    await studentContext.close();
    await teacherContext.close();
    await adminContext.close();
  });
});
