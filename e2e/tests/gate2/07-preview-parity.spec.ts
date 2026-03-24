import { test, expect } from '@playwright/test';
import { apiRequest } from '../../helpers/browser-api';
import {
  approveTeacherCourse,
  buildBranchingSingleChoiceLesson,
  createTeacherAccessLink,
  createTeacherCourseWithDraft,
  submitTeacherCourseForReview,
} from '../../helpers/course-builders';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';

test.describe('Gate 2 -- Preview parity with runtime', () => {
  test('teacher preview and student runtime follow the same incorrect and correct branches for the same lesson graph', async ({
    browser,
  }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const teacherPage = await teacherContext.newPage();
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `preview_parity_${Date.now()}`;
    const lesson = buildBranchingSingleChoiceLesson({
      lessonId,
      title: 'Preview parity lesson',
      introText: 'Перед покупкой в интернете важно сделать паузу.',
      questionText: 'Какой шаг безопаснее?',
      correctOptionText: 'Сначала проверю отзывы и контакты магазина',
      incorrectOptionText: 'Сразу переведу деньги по ссылке из рекламы',
      remediationText: 'Неправильная ветка: нужно проверить магазин до оплаты.',
      successText: 'Правильная ветка: проверка магазина помогает избежать мошенничества.',
      endText: 'Финал ветки parity',
    });

    const { courseId } = await createTeacherCourseWithDraft(teacherPage, {
      title: `Preview Parity ${Date.now()}`,
      description: 'Курс для проверки parity между preview и runtime',
      modules: [
        {
          id: 'module_preview_parity',
          title: 'Parity модуль',
          lessons: [lesson],
        },
      ],
    });

    await submitTeacherCourseForReview(teacherPage, courseId);
    await approveTeacherCourse(adminPage, courseId);
    const { token } = await createTeacherAccessLink(teacherPage, courseId);

    const editorPath = `/teacher/courses/${courseId}/lessons/${lessonId}`;
    await teacherPage.goto(editorPath);
    await expect(teacherPage.getByRole('button', { name: 'Предпросмотр' })).toBeVisible({ timeout: 10000 });

    await teacherPage.getByRole('button', { name: 'Предпросмотр' }).click();
    await teacherPage.waitForURL(/\/teacher\/preview\/.+/);
    await expect(teacherPage.locator('[data-node-kind="story"]')).toBeVisible({ timeout: 10000 });
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await teacherPage.getByRole('button', { name: 'Сразу переведу деньги по ссылке из рекламы' }).click();
    await teacherPage.getByRole('button', { name: 'Ответить' }).click();
    const previewFeedback = teacherPage.locator('[data-role="feedback"]');
    await expect(previewFeedback).toHaveAttribute('data-verdict', 'incorrect');
    await expect(previewFeedback).toContainText('Неправильно');
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await expect(teacherPage.locator('[data-node-kind="story"]')).toBeVisible();
    await expect(teacherPage.locator('[data-role="prompt"]')).toContainText('Неправильная ветка');
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await expect(teacherPage.locator('[data-node-kind="end"]')).toBeVisible();
    await teacherPage.getByRole('button', { name: 'Завершить предпросмотр' }).click();
    await teacherPage.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await teacherPage.waitForURL(editorPath);

    await teacherPage.getByRole('button', { name: 'Предпросмотр' }).click();
    await teacherPage.waitForURL(/\/teacher\/preview\/.+/);
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await teacherPage.getByRole('button', { name: 'Сначала проверю отзывы и контакты магазина' }).click();
    await teacherPage.getByRole('button', { name: 'Ответить' }).click();
    await expect(previewFeedback).toHaveAttribute('data-verdict', 'correct');
    await expect(previewFeedback).toContainText('Правильно');
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await expect(teacherPage.locator('[data-role="prompt"]')).toContainText('Правильная ветка');
    await teacherPage.getByRole('button', { name: 'Далее' }).click();
    await expect(teacherPage.locator('[data-node-kind="end"]')).toBeVisible();
    await teacherPage.getByRole('button', { name: 'Завершить предпросмотр' }).click();
    await teacherPage.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await teacherPage.waitForURL(editorPath);

    const { context: wrongStudentContext, page: wrongStudentPage } = await createFreshStudentPage(browser, 'preview-runtime-wrong');
    const claimWrong = await apiRequest(wrongStudentPage, 'POST', '/student/course-links/claim', { token }, {
      fallbackPath: '/student/courses',
    });
    expect(claimWrong.status).toBe(200);
    await openLessonAttempt(wrongStudentPage, courseId, lessonId);
    await wrongStudentPage.getByRole('button', { name: 'Далее' }).click();
    await wrongStudentPage.getByRole('button', { name: 'Сразу переведу деньги по ссылке из рекламы' }).click();
    await wrongStudentPage.getByRole('button', { name: 'Проверить' }).click();
    const runtimeWrongFeedback = wrongStudentPage.locator('[data-role="feedback"]');
    await expect(runtimeWrongFeedback).toHaveAttribute('data-verdict', 'incorrect');
    await expect(runtimeWrongFeedback).toContainText('Неправильно');
    await wrongStudentPage.getByRole('button', { name: 'Далее' }).click();
    await expect(wrongStudentPage.locator('[data-role="prompt"]')).toContainText('Неправильная ветка');
    await wrongStudentContext.close();

    const { context: correctStudentContext, page: correctStudentPage } = await createFreshStudentPage(browser, 'preview-runtime-correct');
    const claimCorrect = await apiRequest(correctStudentPage, 'POST', '/student/course-links/claim', { token }, {
      fallbackPath: '/student/courses',
    });
    expect(claimCorrect.status).toBe(200);
    await openLessonAttempt(correctStudentPage, courseId, lessonId);
    await correctStudentPage.getByRole('button', { name: 'Далее' }).click();
    await correctStudentPage.getByRole('button', { name: 'Сначала проверю отзывы и контакты магазина' }).click();
    await correctStudentPage.getByRole('button', { name: 'Проверить' }).click();
    const runtimeCorrectFeedback = correctStudentPage.locator('[data-role="feedback"]');
    await expect(runtimeCorrectFeedback).toHaveAttribute('data-verdict', 'correct');
    await expect(runtimeCorrectFeedback).toContainText('Правильно');
    await correctStudentPage.getByRole('button', { name: 'Далее' }).click();
    await expect(correctStudentPage.locator('[data-role="prompt"]')).toContainText('Правильная ветка');
    await correctStudentContext.close();

    await teacherContext.close();
    await adminContext.close();
  });
});
