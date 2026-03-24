import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/parent.json' });

test.describe('Gate 2 -- Parent-child progress flow', () => {
  test('parent sees linked child and their progress', async ({ page }) => {
    // 1. Go to parent dashboard
    await page.goto('/parent');

    // 2. Verify dashboard renders with "Мои дети" heading
    // Dashboard.tsx: <h1>Мои дети</h1>
    await expect(page.getByRole('heading', { name: 'Мои дети' })).toBeVisible();

    // 3. Verify "Алиса" (student) is listed as a linked child
    await expect(page.getByText('Алиса')).toBeVisible();

    // Verify the child card shows some stats (XP)
    // Dashboard.tsx: "{child.xp_total} XP"
    await expect(page.getByText(/XP/)).toBeVisible();

    // 4. Click on Алиса to see progress page
    await page.getByText('Алиса').click();

    // Should navigate to child progress page
    await page.waitForURL('**/parent/children/**');

    // 5. Verify progress page shows child's name
    // ChildProgress.tsx: <h1>{data.display_name}</h1>
    await expect(page.getByText('Алиса')).toBeVisible();

    // Verify stats are shown
    // ChildProgress.tsx stat labels: "Очки опыта (XP)", "Дней подряд", "Точность ответов", "Миссий завершено"
    await expect(page.getByText('Очки опыта (XP)')).toBeVisible();
    await expect(page.getByText('Дней подряд')).toBeVisible();
    await expect(page.getByText('Точность ответов')).toBeVisible();
    await expect(page.getByText('Миссий завершено')).toBeVisible();

    // Verify courses section is shown
    // ChildProgress.tsx: <h2>Миссии</h2>
    await expect(page.getByRole('heading', { name: 'Миссии' })).toBeVisible();

    // Verify back button works
    // ChildProgress.tsx: <Button variant="ghost">← Назад</Button>
    await page.getByRole('button', { name: /Назад/i }).click();
    await page.waitForURL('**/parent');
    await expect(page.getByText('Мои дети')).toBeVisible();
  });

  test('parent can create guardian invite link', async ({ page }) => {
    await page.goto('/parent');
    await expect(page.getByRole('heading', { name: 'Мои дети' })).toBeVisible();

    // Click "Добавить ребёнка" button
    // Dashboard.tsx: <Button>+ Добавить ребёнка</Button>
    await page
      .getByRole('button', { name: /Добавить ребёнка/i })
      .first()
      .click();

    // Modal should open with "Добавить ребёнка" title
    // Dashboard.tsx modal: <p>Создайте ссылку-приглашение и отправьте её ребёнку.
    //   Когда ребёнок перейдёт по ссылке, ваши аккаунты будут связаны.</p>
    await expect(
      page.getByText(/Создайте ссылку-приглашение/),
    ).toBeVisible();

    // Create invite
    // Dashboard.tsx: <Button>Создать приглашение</Button>
    await page.getByRole('button', { name: /Создать приглашение/i }).click();

    // Should see the created invite link
    // Dashboard.tsx: <p>Ссылка создана! Скопируйте и отправьте ребёнку:</p>
    await expect(page.getByText('Ссылка создана!')).toBeVisible();
    // Dashboard.tsx: <Button>Копировать ссылку</Button>
    await expect(
      page.getByRole('button', { name: /Копировать ссылку/i }),
    ).toBeVisible();
  });
});
