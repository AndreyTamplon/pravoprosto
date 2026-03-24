import { test, expect } from '@playwright/test';
import { createFreshStudentPage, openLessonAttempt } from '../../helpers/student-lessons';
import { buildHeartsDrainLesson, createAdminCourseWithDraft, publishAdminCourse } from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';

test.describe('Nightly -- Hearts depletion', () => {
  test('student reaches zero hearts after repeated incorrect answers and sees the recovery screen', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();
    const lessonId = `hearts_drain_${Date.now()}`;

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Hearts Drain ${Date.now()}`,
      description: 'Курс для проверки depletion сердечек',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_hearts_drain',
          title: 'Hearts drain module',
          lessons: [
            buildHeartsDrainLesson({
              lessonId,
              title: 'Hearts drain lesson',
              questions: 5,
            }),
          ],
        },
      ],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context: studentContext, page } = await createFreshStudentPage(browser, 'hearts-drain');
    await expect
      .poll(async () => {
        const response = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, {
          fallbackPath: '/student/courses',
        });
        return response.status;
      }, { timeout: 10000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);

    for (let question = 1; question <= 5; question += 1) {
      await expect(page.locator('[data-node-kind="single_choice"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-role="prompt"]')).toContainText(`#${question}`);
      await page.getByRole('button', { name: 'Неправильный ответ' }).click();
      await page.getByRole('button', { name: 'Проверить' }).click();

      if (question < 5) {
        await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'incorrect');
        await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', String(5 - question));
        await page.getByRole('button', { name: 'Далее' }).click();
      }
    }

    await expect(page.locator('[data-role="hearts"]')).toHaveAttribute('data-remaining', '0');
    await expect(page.locator('[data-role="hearts-empty"]')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Жизни закончились')).toBeVisible();

    await studentContext.close();
  });
});
