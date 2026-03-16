import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Profile', () => {
  test('can view and edit teacher profile', async ({ page }) => {
    await page.goto('/teacher/profile');

    // Should see profile page title
    // TeacherProfile.tsx: <h1>Досье героя</h1>
    await expect(page.getByRole('heading', { name: 'Досье героя' })).toBeVisible();

    // Should see the display name input with "Мария Ивановна"
    // Input component renders <label> without htmlFor, so use placeholder-based selector
    const nameInput = page.getByPlaceholder('Ваше имя');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Мария Ивановна');

    // Should see organization field with "Школа №42"
    // TeacherProfile.tsx: <Input label="Организация" placeholder="Название организации (необязательно)">
    const orgInput = page.getByPlaceholder(/Название организации/);
    await expect(orgInput).toBeVisible();
    await expect(orgInput).toHaveValue('Школа №42');

    // Edit the name
    await nameInput.clear();
    await nameInput.fill('Мария Ивановна Сидорова');

    // Save
    await page.getByRole('button', { name: /Сохранить/ }).click();

    // Should see confirmation
    await expect(page.getByText('Сохранено!')).toBeVisible();

    // Reload to verify persistence
    await page.reload();
    await expect(page.getByPlaceholder('Ваше имя')).toHaveValue('Мария Ивановна Сидорова');

    // Restore original name
    const restoredInput = page.getByPlaceholder('Ваше имя');
    await restoredInput.clear();
    await restoredInput.fill('Мария Ивановна');
    await page.getByRole('button', { name: /Сохранить/ }).click();
    await expect(page.getByText('Сохранено!')).toBeVisible();
  });
});
