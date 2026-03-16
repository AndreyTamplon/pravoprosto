import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: Profile', () => {
  test('can view and edit admin profile', async ({ page }) => {
    await page.goto('/admin/profile');

    // Should see "Профиль" heading
    // AdminProfile.tsx: <h1>Профиль</h1>
    await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible();

    // Should see the display name input
    // AdminProfile.tsx: <Input label="Отображаемое имя" placeholder="Ваше имя">
    // Input component renders <label> without htmlFor, use placeholder
    const nameInput = page.getByPlaceholder('Ваше имя');
    await expect(nameInput).toBeVisible();

    // The admin profile was seeded with display_name "Admin"
    await expect(nameInput).toHaveValue('Admin');

    // Edit name
    await nameInput.clear();
    await nameInput.fill('Admin Updated');

    // Save
    await page.getByRole('button', { name: /Сохранить/ }).click();

    // Should see confirmation
    await expect(page.getByText('Сохранено!')).toBeVisible();

    // Reload to verify persistence
    await page.reload();
    await expect(page.getByPlaceholder('Ваше имя')).toHaveValue('Admin Updated');

    // Restore original name
    const restoredInput = page.getByPlaceholder('Ваше имя');
    await restoredInput.clear();
    await restoredInput.fill('Admin');
    await page.getByRole('button', { name: /Сохранить/ }).click();
    await expect(page.getByText('Сохранено!')).toBeVisible();
  });
});
