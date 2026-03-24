import { test, expect } from '@playwright/test';
import {
  buildSimpleStoryLesson,
  createTeacherCourseWithDraft,
  createAdminCourseWithDraft,
} from '../../helpers/course-builders';

test.describe('Gate 2 -- Stale draft conflict', () => {
  test('teacher preview is blocked when another tab already saved a newer draft version', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const setupPage = await teacherContext.newPage();
    const lessonId = `teacher_conflict_${Date.now()}`;

    const { courseId } = await createTeacherCourseWithDraft(setupPage, {
      title: `Teacher Conflict ${Date.now()}`,
      description: 'Курс для проверки stale draft в teacher editor',
      modules: [
        {
          id: 'module_teacher_conflict',
          title: 'Модуль конфликта',
          lessons: [
            buildSimpleStoryLesson({
              lessonId,
              title: 'Конфликтный урок',
              storyText: 'Базовый текст для конфликта версий',
            }),
          ],
        },
      ],
    });

    const page1 = await teacherContext.newPage();
    const page2 = await teacherContext.newPage();
    const editorPath = `/teacher/courses/${courseId}/lessons/${lessonId}`;

    await page1.goto(editorPath);
    await page2.goto(editorPath);
    await expect(page1.getByPlaceholder('Название этапа...')).toBeVisible({ timeout: 10000 });
    await expect(page2.getByPlaceholder('Название этапа...')).toBeVisible({ timeout: 10000 });

    await page1.getByPlaceholder('Название этапа...').fill('Урок версия 1');
    const saveResponse1 = page1.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page1.getByRole('button', { name: 'Сохранить' }).click();
    expect((await saveResponse1).ok()).toBeTruthy();

    let previewRequestSent = false;
    page2.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/preview')) {
        previewRequestSent = true;
      }
    });

    await page2.getByPlaceholder('Название этапа...').fill('Урок версия 2');
    await page2.getByRole('button', { name: 'Предпросмотр' }).click();
    await expect(page2.getByText('Черновик был изменён в другой вкладке. Обновите страницу и повторите попытку.')).toBeVisible({
      timeout: 10000,
    });
    await expect.poll(() => previewRequestSent, { timeout: 1000 }).toBe(false);
    expect(page2.url()).toContain(editorPath);

    await teacherContext.close();
  });

  test('admin publish is blocked when another tab already saved a newer draft version', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const setupPage = await adminContext.newPage();
    const lessonId = `admin_conflict_${Date.now()}`;

    const { courseId } = await createAdminCourseWithDraft(setupPage, {
      title: `Admin Conflict ${Date.now()}`,
      description: 'Курс для проверки stale draft в admin editor',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_admin_conflict',
          title: 'Модуль конфликта',
          lessons: [
            buildSimpleStoryLesson({
              lessonId,
              title: 'Конфликтный урок',
              storyText: 'Базовый текст для admin publish conflict',
            }),
          ],
        },
      ],
    });

    const page1 = await adminContext.newPage();
    const page2 = await adminContext.newPage();
    const editorPath = `/admin/courses/${courseId}`;

    await page1.goto(editorPath);
    await page2.goto(editorPath);
    await expect(page1.getByLabel('Название курса')).toBeVisible({ timeout: 10000 });
    await expect(page2.getByLabel('Название курса')).toBeVisible({ timeout: 10000 });

    await page1.getByLabel('Название курса').fill('Admin version 1');
    const saveResponse1 = page1.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page1.getByRole('button', { name: 'Сохранить' }).click();
    expect((await saveResponse1).ok()).toBeTruthy();

    let publishRequestSent = false;
    page2.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/publish')) {
        publishRequestSent = true;
      }
    });

    await page2.getByLabel('Описание').fill('Admin version 2');
    await page2.getByRole('button', { name: 'Опубликовать' }).click();
    await expect(page2.getByText('Черновик был изменён в другой вкладке. Обновите страницу и повторите попытку.')).toBeVisible({
      timeout: 10000,
    });
    await expect.poll(() => publishRequestSent, { timeout: 1000 }).toBe(false);
    expect(page2.url()).toContain(editorPath);

    await adminContext.close();
  });
});
