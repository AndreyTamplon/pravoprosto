import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/parent.json' });

test.describe('Parent: Child progress', () => {
  test('can view child progress page with stats and courses', async ({ page }) => {
    await page.goto('/parent');

    // Should see "Мои дети" heading
    // Dashboard.tsx: <h1>Мои дети</h1>
    await expect(page.getByRole('heading', { name: 'Мои дети' })).toBeVisible();

    // Click on Алиса child card
    await page.getByText('Алиса').click();

    // Should navigate to child progress page
    await page.waitForURL(/\/parent\/children\/.+/);

    // Should see child name
    // ChildProgress.tsx: <h1 className={s.childName}>{data.display_name}</h1>
    await expect(page.getByText('Алиса')).toBeVisible();

    // Should see XP stat card
    await expect(page.getByText('Очки опыта (XP)')).toBeVisible();

    // Should see streak stat card
    await expect(page.getByText('Дней подряд')).toBeVisible();

    // Should see accuracy stat card
    await expect(page.getByText('Точность ответов')).toBeVisible();

    // Should see missions completed stat card
    await expect(page.getByText('Миссий завершено')).toBeVisible();

    // Should see "Миссии" section heading
    // ChildProgress.tsx: <h2>Миссии</h2>
    await expect(page.getByText('Миссии')).toBeVisible();

    // If the student has course progress, there should be progress bars
    // (from gate2 tests running first, student completed some lessons)
    const progressBars = page.locator('[class*="courseCard"]');
    if (await progressBars.count() > 0) {
      // Should see status badges like "В процессе" or "Завершено"
      const statusText = page.getByText(/В процессе|Завершено/);
      await expect(statusText.first()).toBeVisible();
    }

    // Click back button to return to dashboard
    // ChildProgress.tsx: <Button variant="ghost">← Назад</Button>
    await page.getByRole('button', { name: /Назад/ }).click();

    // Should be back on parent dashboard
    await page.waitForURL('**/parent');
    await expect(page.getByText('Мои дети')).toBeVisible();
  });
});
