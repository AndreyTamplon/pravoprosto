import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/student.json' });

test.describe('Student -- Profile page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/student/profile');
  });

  test('display name is visible', async ({ page }) => {
    const displayName = page.locator('[class*="displayName"]').first();
    await expect(displayName).toBeVisible();
    await expect(displayName).not.toHaveText('');
  });

  test('XP, level, and streak stats are shown', async ({ page }) => {
    // 2. Stats grid should show XP, level, and streak
    // Profile.tsx: stat labels are "XP", "Уровень", "Серия", "Этапов"
    // These require game state to be loaded (async)
    // CSS text-transform:uppercase renders them as uppercase but DOM text is original case
    await expect(page.getByText('XP').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/уровень/i).first()).toBeVisible();
    await expect(page.getByText(/серия/i).first()).toBeVisible();
    await expect(page.getByText(/этапов/i).first()).toBeVisible();
  });

  test('level badge is displayed next to name', async ({ page }) => {
    // Profile.tsx: <div className={styles.level}>Уровень {game.level}</div>
    await expect(page.getByText(/Уровень \d+/).first()).toBeVisible({ timeout: 10000 });
  });

  test('can start editing display name', async ({ page }) => {
    const originalName = (await page.locator('[class*="displayName"]').first().textContent())?.trim() ?? '';
    expect(originalName).not.toBe('');

    // 3. Click "Изменить имя" to enter edit mode
    await page.getByRole('button', { name: 'Изменить имя' }).click();

    // An input should appear with the current name
    const editInput = page.locator('input[class*="editInput"]');
    await expect(editInput).toBeVisible();
    await expect(editInput).toHaveValue(originalName);
  });

  test('can edit and save display name', async ({ page }) => {
    const originalName = (await page.locator('[class*="displayName"]').first().textContent())?.trim() ?? 'Алиса';

    // 3 & 4. Edit the name and save
    await page.getByRole('button', { name: 'Изменить имя' }).click();

    const editInput = page.locator('input[class*="editInput"]');
    await editInput.clear();
    await editInput.fill('Алиса Тестовая');

    // Click OK to save
    await page.getByRole('button', { name: 'OK' }).click();

    // After save, the new name should be displayed
    await expect(page.getByText('Алиса Тестовая')).toBeVisible();

    // Restore original name
    await page.getByRole('button', { name: 'Изменить имя' }).click();
    const restoreInput = page.locator('input[class*="editInput"]');
    await restoreInput.clear();
    await restoreInput.fill(originalName);
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('[class*="displayName"]').first()).toHaveText(originalName);
  });

  test('can cancel name editing', async ({ page }) => {
    const originalName = (await page.locator('[class*="displayName"]').first().textContent())?.trim() ?? '';
    await page.getByRole('button', { name: 'Изменить имя' }).click();

    const editInput = page.locator('input[class*="editInput"]');
    await editInput.clear();
    await editInput.fill('Should Not Save');

    // Click cancel button (✕)
    await page.getByRole('button', { name: '✕' }).click();

    // Original name should still be displayed
    await expect(page.locator('[class*="displayName"]').first()).toHaveText(originalName);
    await expect(page.getByText('Should Not Save')).not.toBeVisible();
  });

  test('profile shows avatar placeholder when no avatar set', async ({
    page,
  }) => {
    // The avatar area should show the placeholder emoji or the avatar div
    // Profile.tsx: '👤' text inside the avatar div, or an <img> if avatar_url is set
    const avatarSection = page.locator('[class*="avatar"]');
    await expect(avatarSection.first()).toBeVisible();
  });
});
