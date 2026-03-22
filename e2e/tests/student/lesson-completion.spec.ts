import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import { completePhishingLesson, createFreshStudentPage } from '../../helpers/student-lessons';

test.describe('Student -- Lesson completion screen', () => {
  test('"Миссия выполнена!" text is visible after completing a lesson', async ({ browser }) => {
    const { context, page } = await createFreshStudentPage(browser, 'completion-title');
    await completePhishingLesson(page, fixtures.platformCourseId);

    await expect(page.getByText('Миссия выполнена!')).toBeVisible();
    await context.close();
  });

  test('XP amount is shown on completion', async ({ browser }) => {
    const { context, page } = await createFreshStudentPage(browser, 'completion-xp');
    await completePhishingLesson(page, fixtures.platformCourseId);

    await expect(page.getByText(/\+\d+/)).toBeVisible();
    await expect(page.getByText('XP')).toBeVisible();
    await context.close();
  });

  test('"К миссии" button navigates to course tree', async ({ browser }) => {
    const { context, page } = await createFreshStudentPage(browser, 'completion-course');
    const { platformCourseId } = fixtures;
    await completePhishingLesson(page, platformCourseId);

    await page.getByRole('button', { name: 'К миссии' }).click();
    await page.waitForURL(`**/student/courses/${platformCourseId}`);
    await expect(
      page.getByText('Безопасность в интернете'),
    ).toBeVisible();
    await context.close();
  });

  test('"Штаб героя" button navigates to catalog', async ({ browser }) => {
    const { context, page } = await createFreshStudentPage(browser, 'completion-catalog');
    await completePhishingLesson(page, fixtures.platformCourseId);

    await page.getByRole('button', { name: 'Штаб героя' }).click();
    await page.waitForURL('**/student/courses');
    await expect(page.getByText('Штаб героя')).toBeVisible();
    await context.close();
  });

  test('completion screen shows elapsed time', async ({ browser }) => {
    const { context, page } = await createFreshStudentPage(browser, 'completion-time');
    await completePhishingLesson(page, fixtures.platformCourseId);

    await expect(page.getByText(/\d+м/)).toBeVisible();
    await context.close();
  });
});
