import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';
import { completePhishingLesson, createFreshStudentPage } from '../../helpers/student-lessons';

/**
 * Diana's feedback (chat 2026-05-19):
 *   «проблема в том что с карты миссий не зайти в уже пройденную миссию ещё раз —
 *    кнопка начать сначала есть только когда только что завершил миссию»
 *
 * Expected (after fix): a completed lesson on CourseTree must be re-enterable
 * either via a dedicated «Пройти заново» button or by clicking the node itself,
 * landing the student on the first step of a fresh retry session.
 *
 * Current behavior (RED): CourseTree.tsx:45 treats `completed` lessons as
 * non-interactive (`isActive = free || granted`), so neither the node nor any
 * button targets the lesson — the student is stuck.
 */

test.describe('Student — Retry completed lesson from CourseTree (Diana feedback)', () => {
  test('completed lesson on course tree exposes a retry entry point and restarts at first step', async ({ browser }) => {
    const { platformCourseId } = fixtures;
    const { context, page } = await createFreshStudentPage(browser, 'coursetree-retry');

    await completePhishingLesson(page, platformCourseId);
    await page.getByRole('button', { name: 'К миссии' }).click();
    await page.waitForURL(`**/student/courses/${platformCourseId}`);

    // The completed lesson card / button must be present in the tree
    const lessonRegion = page.getByText('Фишинг и мошенники').locator('..');
    await expect(lessonRegion).toBeVisible();

    // There must be a control allowing the student to re-enter the completed lesson.
    // Use the dedicated data-role to disambiguate from the «Пройти заново» button on the
    // LessonPlayer complete-screen (data-role="lesson-retry").
    const retryButton = page.locator('[data-role="lesson-retry-tree"]');
    await expect(retryButton).toBeVisible({ timeout: 5000 });

    await retryButton.click();
    await page.waitForURL(`**/student/courses/${platformCourseId}/lessons/lesson_phishing`);

    // After retry, we should land on the FIRST step (the phishing story),
    // not the resume-mid-lesson state.
    await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });

    await context.close();
  });
});
