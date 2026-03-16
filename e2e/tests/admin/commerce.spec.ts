import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: Commerce', () => {
  test('Offers tab shows seeded offer with correct title, price, and status', async ({ page }) => {
    await page.goto('/admin/commerce');

    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Four tabs must exist
    for (const tab of ['Офферы', 'Заявки', 'Заказы', 'Доступы']) {
      await expect(page.getByRole('button', { name: tab })).toBeVisible();
    }

    // Offers tab is active by default — verify toolbar
    await expect(page.getByRole('button', { name: 'Создать оффер' })).toBeVisible();
    await expect(page.getByText(/1\s*офферов/)).toBeVisible();

    // Table headers
    const headers = ['Название', 'Тип', 'Курс / Урок', 'Цена', 'Статус', 'Создан', 'Действия'];
    for (const h of headers) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    }

    // Seeded offer: "Урок: Персональные данные", 490 RUB, active
    await expect(page.getByRole('cell', { name: 'Урок: Персональные данные' })).toBeVisible();
    await expect(page.getByText('490')).toBeVisible();
    await expect(page.getByText('Активный')).toBeVisible();
    // Target type badge should say "Урок"
    await expect(page.getByText('Урок').first()).toBeVisible();
  });

  test('switching tabs loads Requests, Orders, and Entitlements content', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Switch to Заявки — empty state expected (no purchase requests seeded)
    await page.getByRole('button', { name: 'Заявки' }).click();
    await expect(page.getByText('Нет заявок')).toBeVisible();
    await expect(page.getByText('Заявки на покупку появятся здесь')).toBeVisible();

    // Switch to Заказы — empty state expected
    await page.getByRole('button', { name: 'Заказы' }).click();
    await expect(page.getByText('Нет заказов')).toBeVisible();
    await expect(page.getByText('Заказы появятся здесь')).toBeVisible();

    // Switch to Доступы — management UI
    await page.getByRole('button', { name: 'Доступы' }).click();
    await expect(page.getByText('Управление доступами')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Выдать доступ' })).toBeVisible();
    await expect(page.getByText('Отозвать доступ')).toBeVisible();
  });
});
