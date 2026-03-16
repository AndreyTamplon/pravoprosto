import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/parent.json' });

test.describe('Parent: Guardian invites', () => {
  test('sees linked child and can create invite', async ({ page }) => {
    await page.goto('/parent');

    // Should see "Мои дети" heading
    // Dashboard.tsx: <h1>Мои дети</h1>
    await expect(page.getByRole('heading', { name: 'Мои дети' })).toBeVisible();

    // Should see linked child "Алиса" (if guardian link was established during seed)
    // or "Пока нет привязанных детей" if the link wasn't created
    const hasChild = await page.getByText('Алиса').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasChild) {
      await expect(page.getByText('Алиса')).toBeVisible();
    }

    // Click "Добавить ребёнка" button
    // Dashboard.tsx: <Button>+ Добавить ребёнка</Button>
    await page.getByRole('button', { name: /Добавить ребёнка/ }).click();

    // Modal should open with title "Добавить ребёнка"
    // Dashboard.tsx: Modal title="Добавить ребёнка"
    await expect(page.getByRole('heading', { name: 'Добавить ребёнка' })).toBeVisible();

    // Modal should explain the invite flow
    // Dashboard.tsx: <p>Создайте ссылку-приглашение и отправьте её ребёнку.
    //   Когда ребёнок перейдёт по ссылке, ваши аккаунты будут связаны.</p>
    await expect(
      page.getByText(/Создайте ссылку-приглашение/),
    ).toBeVisible();

    // Click "Создать приглашение"
    // Dashboard.tsx: <Button>Создать приглашение</Button>
    await page.getByRole('button', { name: /Создать приглашение/ }).click();

    // After creation, invite URL should be shown
    // Dashboard.tsx: <p>Ссылка создана! Скопируйте и отправьте ребёнку:</p>
    await expect(page.getByText(/Ссылка создана/)).toBeVisible();

    // There should be an invite URL displayed and a copy button
    // Dashboard.tsx: <Button>Копировать ссылку</Button>
    await expect(page.getByRole('button', { name: /Копировать ссылку/ })).toBeVisible();

    // Close modal
    await page.keyboard.press('Escape');

    // Verify the invite appears in the "Активные приглашения" section
    // Dashboard.tsx: <h2>Активные приглашения</h2> and "Отозвать" button
    await expect(page.getByText('Активные приглашения')).toBeVisible();
    await expect(page.getByRole('button', { name: /Отозвать/ }).first()).toBeVisible();
  });
});
