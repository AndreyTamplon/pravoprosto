import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/parent.json' });

test.describe('Parent: Profile', () => {
  test('can view and edit parent profile', async ({ page }) => {
    await page.goto('/parent/profile');

    // Should see profile page title
    // ParentProfile.tsx: <h1>Досье героя</h1>
    await expect(page.getByRole('heading', { name: 'Досье героя' })).toBeVisible();

    // Should see the display name input with "Елена"
    // Input component renders <label> without htmlFor, so use placeholder
    const nameInput = page.getByPlaceholder('Ваше имя');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Елена');

    // Edit name
    await nameInput.clear();
    await nameInput.fill('Елена Петровна');

    // Save
    await page.getByRole('button', { name: /Сохранить/ }).click();

    // Should see confirmation
    await expect(page.getByText('Сохранено!')).toBeVisible();

    // Reload to verify persistence
    await page.reload();

    // Verify name was saved
    const reloadedInput = page.getByPlaceholder('Ваше имя');
    await expect(reloadedInput).toHaveValue('Елена Петровна');

    // Restore original name
    await reloadedInput.clear();
    await reloadedInput.fill('Елена');
    await page.getByRole('button', { name: /Сохранить/ }).click();
    await expect(page.getByText('Сохранено!')).toBeVisible();
  });
});
