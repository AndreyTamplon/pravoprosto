import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/student.json' });

test.describe('Gate 2 -- Lesson with single_choice questions (lesson_phishing)', () => {
  test('student completes phishing lesson end to end', async ({ page }) => {
    const { platformCourseId } = fixtures;

    // 1. Navigate to course tree
    await page.goto(`/student/courses/${platformCourseId}`);

    // 2. Verify course tree loads with lessons
    await expect(page.getByText('Безопасность в интернете')).toBeVisible();
    await expect(page.getByText('Фишинг и мошенники')).toBeVisible();
    await expect(page.getByText('Надёжные пароли')).toBeVisible();
    await expect(page.getByText('Что нельзя рассказывать в интернете')).toBeVisible();

    // 3. Click on the first lesson "Фишинг и мошенники"
    await page.getByRole('button', { name: /Начать миссию/i }).first().click();

    // Should navigate to the lesson player
    await page.waitForURL(`**/student/courses/${platformCourseId}/lessons/lesson_phishing`);

    // 4. Wait for lesson to load - story screen first
    await expect(page.getByRole('button', { name: 'Далее' })).toBeVisible({ timeout: 10000 });

    // Story s1 -> Далее
    await page.getByRole('button', { name: 'Далее' }).click();

    // 5. Question q1: should see the question
    await expect(
      page.getByRole('button', { name: /Покажу родителям/ }),
    ).toBeVisible();

    // Verify all options are visible
    await expect(
      page.getByRole('button', { name: /Перейду по ссылке/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Покажу родителям/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Перешлю друзьям/ }),
    ).toBeVisible();

    // 6. Select the correct answer
    await page.getByRole('button', { name: /Покажу родителям/ }).click();

    // 7. Click "Проверить"
    await page.getByRole('button', { name: 'Проверить' }).click();

    // 8. See green feedback "ВЕРНО!"
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/посоветоваться со взрослыми/),
    ).toBeVisible();

    // 9. Click "Далее" on feedback
    await page.getByRole('button', { name: 'Далее' }).click();

    // 10. Story s2: moshennicheskoe messages
    await expect(
      page.getByText(/Мошенники часто используют приманки/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    // 11. Question q2: "Какой из признаков указывает на мошенническое сообщение?"
    await expect(
      page.getByText(/Какой из признаков указывает на мошенническое/),
    ).toBeVisible();

    // 12. Select correct answer "Просят срочно перейти по ссылке"
    await page
      .getByRole('button', { name: /Просят срочно/ })
      .click();

    // 13. Click "Проверить"
    await page.getByRole('button', { name: 'Проверить' }).click();

    // 14. Feedback "ВЕРНО!"
    await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Срочность.*один из главных приёмов/),
    ).toBeVisible();

    // Click "Далее" on feedback
    await page.getByRole('button', { name: 'Далее' }).click();

    // 15. Lesson complete: "Миссия выполнена!"
    await expect(page.getByText('Миссия выполнена!')).toBeVisible();

    // Verify XP earned is shown
    await expect(page.getByText(/\+\d+/)).toBeVisible();
    await expect(page.getByText('XP')).toBeVisible();

    // Verify navigation buttons
    await expect(page.getByRole('button', { name: 'К миссии' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Штаб героя' }),
    ).toBeVisible();
  });
});
