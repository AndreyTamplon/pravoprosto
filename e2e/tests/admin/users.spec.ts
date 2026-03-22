import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: User management', () => {
  test('user list contains all seeded users with correct names', async ({ page }) => {
    await page.goto('/admin/users');

    await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();

    // Role filter tabs with counts — 5 seeded users total
    // Tabs render as "Все (5)", "Ученики (2)", "Родители (1)", "Учителя (1)", "Админы (1)"
    await expect(page.getByRole('button', { name: /Все\s*\(\d+\)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ученики\s*\(\d+\)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Родители\s*\(\d+\)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Учителя\s*\(\d+\)/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Админы\s*\(\d+\)/ })).toBeVisible();

    // Table headers
    for (const h of ['Имя', 'Роль', 'Статус', 'Email', 'Регистрация', 'Последняя активность']) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    }

    // Verify seeded user names appear in the table
    // Use { exact: true } for "Admin" because there is also a role cell "admin" (case-insensitive match)
    await expect(page.getByRole('cell', { name: 'Admin', exact: true })).toBeVisible();
    // Teacher: "Мария Ивановна"
    await expect(page.getByRole('cell', { name: 'Мария Ивановна' })).toBeVisible();
    // Student: "Алиса"
    await expect(page.getByRole('cell', { name: 'Алиса' })).toBeVisible();
    // Parent: "Елена"
    await expect(page.getByRole('cell', { name: 'Елена' })).toBeVisible();
    // Student2: "Борис"
    await expect(page.getByRole('cell', { name: 'Борис' })).toBeVisible();
  });

  test('filter by role shows correct subset and user detail modal works', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();

    // Filter to Учителя — should show only Мария Ивановна
    await page.getByRole('button', { name: /Учителя/ }).click();
    await expect(page.getByRole('cell', { name: 'Мария Ивановна' })).toBeVisible();
    // Other non-teacher users should not appear
    await expect(page.getByRole('cell', { name: 'Алиса' })).not.toBeVisible();

    // Filter to Ученики — should show Алиса and Борис
    await page.getByRole('button', { name: /Ученики/ }).click();
    await expect(page.getByRole('cell', { name: 'Алиса' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Борис' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Мария Ивановна' })).not.toBeVisible();

    // Back to all, then open detail modal by clicking on a user row
    await page.getByRole('button', { name: /Все/ }).click();
    await page.getByRole('cell', { name: 'Мария Ивановна' }).click();

    // Modal should open with title "Пользователь"
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Пользователь')).toBeVisible();

    // Detail fields
    await expect(modal.getByText('Мария Ивановна')).toBeVisible();

    // Block/unblock action button
    await expect(
      modal.getByRole('button', { name: /Заблокировать|Разблокировать/ }),
    ).toHaveCount(1);
  });
});
