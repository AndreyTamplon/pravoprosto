import { test, expect, type Page } from '@playwright/test';

async function createTeacherCourseForModeration(page: Page, courseTitle: string) {
  await page.goto('/teacher');
  await page.getByRole('button', { name: /\+ Создать курс/i }).click();
  await page.getByPlaceholder('Например: Основы права').fill(courseTitle);
  await page.getByPlaceholder('Кратко опишите курс...').fill('Курс для проверки модерации и preview');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.waitForURL(/\/teacher\/courses\/[^/]+$/);

  await page.getByRole('button', { name: /\+ Модуль/i }).click();
  await page.getByPlaceholder('Название модуля...').fill('Модуль модерации');
  await page.getByRole('button', { name: /\+ Добавить этап/i }).click();
  await page.getByRole('button', { name: /\+ Добавить этап/i }).click();

  await page.getByRole('button', { name: 'Редактировать' }).nth(0).click();
  await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
  await fillSimpleLesson(page, 'Первый урок', 'Первый урок для проверки preview');
  await page.goBack();
  await page.waitForURL(/\/teacher\/courses\/[^/]+$/);

  await page.getByRole('button', { name: 'Редактировать' }).nth(1).click();
  await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
  await fillSimpleLesson(page, 'Второй урок', 'Содержимое второго урока для admin preview');
  await page.goBack();
  await page.waitForURL(/\/teacher\/courses\/[^/]+$/);

  await page.getByRole('button', { name: 'На проверку' }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'Подтверждение' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.getByText('На проверке', { exact: true })).toBeVisible({ timeout: 10000 });
}

async function fillSimpleLesson(page: Page, lessonTitle: string, storyText: string) {
  await page.getByPlaceholder('Название этапа...').fill(lessonTitle);
  await page.getByRole('button', { name: /\+ Блок истории/i }).click();
  await page.getByRole('button', { name: /\+ Завершение/i }).click();
  await page.getByLabel('Текст истории').fill(storyText);
  const saveResponse = page.waitForResponse((response) =>
    response.request().method() === 'PUT' && response.url().includes('/draft'),
  );
  await page.getByRole('button', { name: 'Сохранить' }).click();
  expect((await saveResponse).ok()).toBeTruthy();
}

test.describe('Admin: Moderation workflow and preview', () => {
  test('admin previews the explicitly selected lesson and approves a teacher course', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const teacherPage = await teacherContext.newPage();
    const courseTitle = `Moderation Preview ${Date.now()}`;

    await createTeacherCourseForModeration(teacherPage, courseTitle);
    await teacherContext.close();

    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    await adminPage.goto('/admin/moderation');
    await expect(adminPage.getByRole('heading', { name: 'Модерация курсов' })).toBeVisible();
    await expect(adminPage.getByText(courseTitle)).toBeVisible({ timeout: 15000 });

    await adminPage.getByText(courseTitle).click();
    const reviewDialog = adminPage.getByRole('dialog', { name: 'Проверка курса' });
    await expect(reviewDialog).toBeVisible();

    const lessonSelect = reviewDialog.getByLabel(/Урок для предпросмотра/i);
    await expect(lessonSelect).toBeVisible();
    const secondLessonOption = lessonSelect.locator('option').filter({ hasText: 'Второй урок' });
    const secondLessonValue = await secondLessonOption.first().getAttribute('value');
    expect(secondLessonValue).toBeTruthy();
    await lessonSelect.selectOption(secondLessonValue!);

    const popupPromise = adminPage.waitForEvent('popup');
    await reviewDialog.getByRole('button', { name: 'Предпросмотр' }).click();
    const previewPage = await popupPromise;
    await previewPage.waitForURL(/\/admin\/preview\/.+/);
    await previewPage.reload();
    await expect(previewPage.getByText('Содержимое второго урока для admin preview')).toBeVisible({
      timeout: 10000,
    });
    await previewPage.close();

    await reviewDialog.getByRole('button', { name: 'Одобрить' }).click();
    await expect(reviewDialog).not.toBeVisible({ timeout: 10000 });
    await expect(adminPage.getByRole('cell', { name: courseTitle, exact: true })).not.toBeVisible({
      timeout: 10000,
    });

    await adminPage.goto('/admin/courses');
    await adminPage.getByRole('button', { name: 'Учителя' }).click();
    await expect(adminPage.getByText(courseTitle)).toBeVisible({ timeout: 10000 });

    await adminContext.close();
  });
});
