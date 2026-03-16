import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Student progress', () => {
  test('navigates to student progress and shows empty state with back navigation', async ({ page }) => {
    const { teacherCourseId } = fixtures;

    // Navigate directly to students page
    await page.goto(`/teacher/courses/${teacherCourseId}/students`);

    // Heading
    await expect(page.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({ timeout: 10000 });

    // No students have claimed the teacher course, so empty state should show
    await expect(page.getByText('Пока нет учеников')).toBeVisible();
    await expect(page.getByText('Поделитесь ссылкой на курс, чтобы привлечь учеников')).toBeVisible();
    await expect(page.getByRole('button', { name: /К настройкам курса/ })).toBeVisible();

    // No table should be present in empty state
    await expect(page.getByRole('table')).not.toBeVisible();

    // Back button should navigate to course constructor
    await page.getByRole('button', { name: /К курсу/ }).click();
    await page.waitForURL(new RegExp(`/teacher/courses/${teacherCourseId}$`));
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
