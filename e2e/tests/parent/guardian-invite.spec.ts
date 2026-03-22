import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/parent.json' });

test.describe('Parent: Guardian invites', () => {
  test('sees linked child and can create invite', async ({ page }) => {
    await page.goto('/parent');
    await expect(page.getByRole('heading', { name: 'Мои дети' })).toBeVisible();
    await expect(page.getByText('Алиса')).toBeVisible();

    await page.getByRole('button', { name: /Добавить ребёнка/ }).click();
    await expect(page.getByRole('heading', { name: 'Добавить ребёнка' })).toBeVisible();
    await expect(
      page.getByText(/Создайте ссылку-приглашение/),
    ).toBeVisible();
    await page.getByRole('button', { name: /Создать приглашение/ }).click();
    await expect(page.getByText(/Ссылка создана/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Копировать ссылку/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText('Активные приглашения')).toBeVisible();
    await expect(page.getByRole('button', { name: /Отозвать/ }).first()).toBeVisible();
  });
});
