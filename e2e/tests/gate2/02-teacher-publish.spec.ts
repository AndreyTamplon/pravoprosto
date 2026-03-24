import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.describe('Gate 2 -- Teacher publish and multi-role flow', () => {
  test('teacher can create a course and fill the constructor', async ({ browser }) => {
    const teacherContext = await browser.newContext({
      storageState: '.auth/teacher.json',
    });
    const teacherPage = await teacherContext.newPage();
    const courseTitle = `E2E Тестовый курс ${Date.now()}`;
    const moduleTitle = `Модуль ${Date.now()}`;

    await teacherPage.goto('/teacher');
    await expect(teacherPage.getByRole('heading', { name: 'Мои курсы' })).toBeVisible();

    // Create a new course
    await teacherPage.getByRole('button', { name: /Создать курс/i }).click();
    await teacherPage.getByPlaceholder('Например: Основы права').fill(courseTitle);
    await teacherPage.getByPlaceholder('Кратко опишите курс...').fill('Курс для E2E теста');
    await teacherPage.getByRole('button', { name: 'Создать', exact: true }).click();

    // Should navigate to course constructor
    await teacherPage.waitForURL('**/teacher/courses/**');
    await expect(teacherPage.getByText('Модули и этапы')).toBeVisible();

    // Add module and lesson
    await teacherPage.getByRole('button', { name: /Модуль/i }).click();
    const moduleTitleInput = teacherPage.locator('input[placeholder="Название модуля..."]').first();
    await expect(moduleTitleInput).toBeVisible();
    await moduleTitleInput.fill(moduleTitle);
    await moduleTitleInput.press('Tab');

    const addLessonButton = teacherPage.getByRole('button', { name: /Добавить этап/i }).last();
    await expect(addLessonButton).toBeVisible();
    await addLessonButton.click();
    await expect(teacherPage.getByText(/Этап 1/)).toBeVisible();

    // Save
    const saveResponse = teacherPage.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/teacher/courses/') && response.url().includes('/draft'),
    );
    await teacherPage.getByRole('button', { name: 'Сохранить' }).click();
    expect((await saveResponse).ok()).toBeTruthy();

    // Verify course appears on dashboard
    await teacherPage.goto('/teacher');
    await expect(teacherPage.getByText(courseTitle, { exact: true })).toBeVisible();

    await teacherContext.close();
  });

  test('student claims teacher access link and sees course in catalog', async ({ browser }) => {
    // Use the SEEDED teacher course which is already approved and published
    const { teacherCourseId, accessLinkToken } = fixtures;

    // Skip if no valid access link token was seeded (token should be alphanumeric/dashes)
    const isValidToken = accessLinkToken && /^[a-zA-Z0-9_\-]{10,}$/.test(accessLinkToken);
    test.skip(!isValidToken, 'No valid access link token in seed data');

    const studentContext = await browser.newContext({
      storageState: '.auth/student2.json',
    });
    const studentPage = await studentContext.newPage();

    // Student2 claims the seeded teacher course access link
    // Backend generates URLs with #token= (hash fragment)
    await studentPage.goto(`/claim/course-link#token=${accessLinkToken}`);

    // Should see success or already-claimed state
    await expect(
      studentPage.getByRole('heading', { name: 'Готово!' }),
    ).toBeVisible({ timeout: 15000 });

    // Navigate to catalog and verify teacher course is visible
    await studentPage.goto('/student/courses');
    await expect(studentPage.getByText('Покупки онлайн')).toBeVisible({ timeout: 5000 });

    await studentContext.close();
  });
});
