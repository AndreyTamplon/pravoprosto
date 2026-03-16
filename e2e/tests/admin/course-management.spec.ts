import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: Course management', () => {
  test('course list shows seeded platform course with full table structure', async ({ page }) => {
    await page.goto('/admin/courses');

    await expect(page.getByRole('heading', { name: 'Курсы' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Создать курс/ })).toBeVisible();

    // Filter buttons
    for (const f of ['Все', 'Платформа', 'Учителя']) {
      await expect(page.getByRole('button', { name: f })).toBeVisible();
    }

    // Table headers (accessible names ignore CSS text-transform)
    for (const h of ['Название', 'Тип', 'Статус', 'Уроков', 'Учеников', 'Создан']) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    }

    // Platform course "Безопасность в интернете" must be visible
    await expect(page.getByRole('cell', { name: 'Безопасность в интернете' })).toBeVisible();
    // Type badge "Платформа" in the row
    await expect(page.getByRole('cell', { name: 'Платформа' })).toBeVisible();
    // Status badge "Опубликован"
    await expect(page.getByRole('cell', { name: 'Опубликован' })).toBeVisible();
  });

  test('filter buttons switch between platform and teacher views', async ({ page }) => {
    await page.goto('/admin/courses');
    await expect(page.getByRole('heading', { name: 'Курсы' })).toBeVisible({ timeout: 15000 });

    // "Все" is active by default — platform course visible
    await expect(page.getByRole('cell', { name: 'Безопасность в интернете' })).toBeVisible();

    // Filter to "Платформа" — platform course still visible
    await page.getByRole('button', { name: 'Платформа' }).click();
    await expect(page.getByRole('cell', { name: 'Безопасность в интернете' })).toBeVisible();

    // Filter to "Учителя" — may have teacher courses or may be empty
    await page.getByRole('button', { name: 'Учителя' }).click();
    // Either teacher courses appear or "Нет курсов" empty state
    await expect(
      page.getByText('Покупки онлайн')
        .or(page.getByText('Нет курсов'))
    ).toBeVisible();

    // Back to "Все"
    await page.getByRole('button', { name: 'Все' }).click();
    await expect(page.getByRole('cell', { name: 'Безопасность в интернете' })).toBeVisible();
  });
});
