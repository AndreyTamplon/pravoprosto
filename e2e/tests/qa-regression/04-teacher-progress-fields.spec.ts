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
    const { teacherCourseId, accessLinkToken } = fixtures;

    const studentCtx = await browser.newContext({ storageState: '.auth/student2.json' });
    const studentPage = await studentCtx.newPage();
    await studentPage.goto(`/claim/course-link#token=${accessLinkToken}`);
    await expect(studentPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await studentCtx.close();

    const teacherCtx = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await teacherCtx.newPage();

    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/v1/teacher/courses/') &&
              resp.url().includes('/students') &&
              resp.status() === 200 &&
              resp.headers()['content-type']?.includes('application/json'),
    );

    await page.goto(`/teacher/courses/${teacherCourseId}/students`);
    await expect(page.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({ timeout: 10000 });

    const response = await responsePromise.catch(() => null);
    expect(response).not.toBeNull();
    const data = await response!.json().catch(() => null);
    expect(data).not.toBeNull();
    const items = Array.isArray(data?.students) ? data.students : [];
    const boris = items.find((item: Record<string, unknown>) => item.display_name === 'Борис');
    expect(boris).toBeTruthy();
    expect(boris?.progress_percent).toBeDefined();
    expect(boris?.xp_total).toBeDefined();
    expect(boris?.correctness_percent).toBeDefined();
    expect(boris?.progress_pct).toBeUndefined();
    expect(boris?.xp_earned).toBeUndefined();
    expect(boris?.accuracy_pct).toBeUndefined();

    const borisRow = page.locator('tbody tr').filter({ hasText: 'Борис' }).first();
    await expect(borisRow).toBeVisible();
    await expect(borisRow).toContainText('0%');
    await expect(borisRow).not.toContainText('undefined');
    await expect(borisRow).not.toContainText('NaN');

    await teacherCtx.close();
  });

  test('student detail summary uses mapped numeric fields without undefined or NaN', async ({ browser }) => {
    const { teacherCourseId, accessLinkToken } = fixtures;

    const studentCtx = await browser.newContext({ storageState: '.auth/student2.json' });
    const studentPage = await studentCtx.newPage();
    await studentPage.goto(`/claim/course-link#token=${accessLinkToken}`);
    await expect(studentPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await studentCtx.close();

    const teacherCtx = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await teacherCtx.newPage();

    await page.goto(`/teacher/courses/${teacherCourseId}/students`);
    await expect(page.getByRole('heading', { name: 'Прогресс учеников' })).toBeVisible({ timeout: 10000 });

    const borisRow = page.locator('tbody tr').filter({ hasText: 'Борис' }).first();
    await expect(borisRow).toBeVisible({ timeout: 10000 });
    await borisRow.click();

    await page.waitForURL(new RegExp(`/teacher/courses/${teacherCourseId}/students/.+$`));
    await expect(page.getByRole('heading', { name: 'Борис' })).toBeVisible();
    await expect(page.getByText('Прогресс: 0% · XP: 0 · Точность: 0%')).toBeVisible();
    await expect(page.getByText(/undefined|NaN/i)).not.toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();

    await teacherCtx.close();
  });
});
