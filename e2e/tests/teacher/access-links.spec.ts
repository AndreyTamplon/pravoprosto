import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Access links', () => {
  test('can view and create access links for a published course', async ({ page }) => {
    const { teacherCourseId } = fixtures;
    await page.goto(`/teacher/courses/${teacherCourseId}`);

    await page.getByRole('button', { name: 'Поделиться' }).click();
    const dialog = page.getByRole('dialog', { name: 'Поделиться курсом' });
    await expect(dialog).toBeVisible();

    await expect(
      dialog.getByText(/Создайте ссылку для приглашения учеников/),
    ).toBeVisible();

    const existingLink = dialog.getByText(/\/claim\/course-link#token=/).first();
    await expect(existingLink).toBeVisible();
    await expect(existingLink).not.toContainText('Ссылка недоступна');
    await expect(dialog.getByRole('button', { name: 'Копировать' }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Отозвать' }).first()).toBeVisible();

    const beforeCreateCount = await dialog.getByText(/\/claim\/course-link#token=/).count();
    const createResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes(`/teacher/courses/${teacherCourseId}/access-links`),
    );
    await dialog.getByRole('button', { name: /Создать ссылку/i }).click();
    expect((await createResponse).ok()).toBeTruthy();

    await expect(dialog.getByText(/\/claim\/course-link#token=/)).toHaveCount(beforeCreateCount + 1);

    await page.reload();
    await page.getByRole('button', { name: 'Поделиться' }).click();
    const reopenedDialog = page.getByRole('dialog', { name: 'Поделиться курсом' });
    await expect(reopenedDialog.getByText(/\/claim\/course-link#token=/)).toHaveCount(beforeCreateCount + 1);
    await expect(reopenedDialog.getByRole('button', { name: 'Копировать' }).first()).toBeVisible();
    await expect(reopenedDialog.getByRole('button', { name: 'Отозвать' }).first()).toBeVisible();
  });
});
