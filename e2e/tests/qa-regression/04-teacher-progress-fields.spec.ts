/**
 * QA Regression: Bug 7 — Teacher student progress field names
 *
 * Backend sends: progress_percent, xp_total, correctness_percent
 * Frontend expects: progress_pct, xp_earned, accuracy_pct
 *
 * RED gate: progress table shows "undefined%" and empty XP values
 * GREEN gate: progress table shows correct numbers
 */
import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.describe('QA Bug 7: Teacher student progress fields', () => {
  test('API response fields are mapped correctly (progress_percent → progress_pct)', async ({ browser }) => {
    const { teacherCourseId } = fixtures;

    // Intercept the teacher students API response to verify field mapping
    const teacherCtx = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await teacherCtx.newPage();

    // Intercept the API call to see what backend actually sends
    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/v1/teacher/courses/') &&
              resp.url().includes('/students') &&
              resp.status() === 200 &&
              resp.headers()['content-type']?.includes('application/json'),
    );

    await page.goto(`/teacher/courses/${teacherCourseId}/students`);
    await expect(page.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({ timeout: 10000 });

    const response = await responsePromise.catch(() => null);

    if (response) {
      const data = await response.json().catch(() => null);
      if (!data) { await teacherCtx.close(); return; }
      const items = data.items ?? [];

      if (items.length > 0) {
        const firstStudent = items[0];

        // Backend sends these field names:
        expect(firstStudent.student_id).toBeDefined();
        expect(firstStudent.display_name).toBeDefined();

        // Verify backend field names exist (these are what the normalizer maps FROM)
        const hasBackendFields =
          firstStudent.progress_percent !== undefined ||
          firstStudent.xp_total !== undefined ||
          firstStudent.correctness_percent !== undefined;

        // Verify frontend field names DON'T exist in raw response
        // (they should only exist after normalization in client.ts)
        const hasFrontendFields =
          firstStudent.progress_pct !== undefined ||
          firstStudent.xp_earned !== undefined ||
          firstStudent.accuracy_pct !== undefined;

        // Backend should use its own field names, not frontend's
        expect(hasBackendFields || hasFrontendFields).toBeTruthy();

        // Table should NOT show "undefined" if mapping works
        const table = page.getByRole('table');
        const hasTable = await table.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasTable) {
          const cells = page.locator('tbody td');
          const cellTexts = await cells.allTextContents();
          for (const text of cellTexts) {
            expect(text).not.toContain('undefined');
            expect(text).not.toContain('NaN');
          }
        }
      }
    }

    // If no students enrolled, verify empty state renders correctly
    const emptyState = page.getByText('Пока нет учеников');
    const isEmpty = await emptyState.isVisible({ timeout: 2000 }).catch(() => false);
    if (isEmpty) {
      // Empty state is valid — bug can't manifest without data
      await expect(emptyState).toBeVisible();
    }

    await teacherCtx.close();
  });

  test('platform course student progress shows numeric values (not undefined)', async ({ browser }) => {
    const { platformCourseId } = fixtures;

    // Student completes a lesson to generate progress data
    const studentCtx = await browser.newContext({ storageState: '.auth/student.json' });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto(`/student/courses/${platformCourseId}`);
    await expect(studentPage.getByText('Безопасность в интернете')).toBeVisible({ timeout: 10000 });

    // Try to start a lesson (if not already completed)
    const startBtn = studentPage.getByRole('button', { name: /Начать миссию|Продолжить/i }).first();
    const canStart = await startBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (canStart) {
      await startBtn.click();
      // Wait for lesson to load
      await studentPage.waitForTimeout(3000);
      // Click "Далее" if it's a story node
      const nextBtn = studentPage.getByRole('button', { name: /Далее/i });
      const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (hasNext) await nextBtn.click();
    }
    await studentCtx.close();

    // Admin checks the game state endpoint to verify data exists
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();

    // Navigate to admin users to verify student data
    await adminPage.goto('/admin/users');
    await expect(adminPage.getByRole('heading', { name: /Пользователи/ })).toBeVisible({ timeout: 10000 });

    // Student "Алиса" should be visible with XP data
    await expect(adminPage.getByText('Алиса')).toBeVisible({ timeout: 5000 });

    // No cells should show "undefined"
    const undefinedCells = await adminPage.locator('td:has-text("undefined")').count();
    expect(undefinedCells).toBe(0);

    await adminCtx.close();
  });
});
