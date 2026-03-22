import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Student progress', () => {
  test('teacher sees the linked student row and can open student detail without invalid dates', async ({ browser, page }) => {
    const { teacherCourseId, accessLinkToken } = fixtures;

    const studentContext = await browser.newContext({ storageState: '.auth/student2.json' });
    const studentPage = await studentContext.newPage();
    await studentPage.goto(`/claim/course-link#token=${accessLinkToken}`);
    await expect(studentPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await studentContext.close();

    // Navigate directly to students page
    await page.goto(`/teacher/courses/${teacherCourseId}/students`);

    // Heading
    await expect(page.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('table')).toBeVisible();

    const borisRow = page.locator('tbody tr').filter({ hasText: 'Борис' }).first();
    await expect(borisRow).toBeVisible({ timeout: 10000 });
    await expect(borisRow).toContainText('0%');
    await expect(borisRow).not.toContainText('Invalid Date');
    await expect(page.getByText('Invalid Date')).not.toBeVisible();

    await borisRow.click();
    await page.waitForURL(new RegExp(`/teacher/courses/${teacherCourseId}/students/.+$`));
    await expect(page.getByRole('heading', { name: 'Борис' })).toBeVisible();
    await expect(page.getByText('Прогресс: 0%')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('button', { name: /Назад к списку/ }).click();
    await page.waitForURL(new RegExp(`/teacher/courses/${teacherCourseId}/students$`));

    // Back button should navigate to course constructor
    await page.getByRole('button', { name: /К курсу/ }).click();
    await page.waitForURL(new RegExp(`/teacher/courses/${teacherCourseId}$`));
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
