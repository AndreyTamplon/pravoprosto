import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { psqlExec } from '../../helpers/api-seeder';
import { apiRequest } from '../../helpers/browser-api';

test.use({ storageState: '.auth/student.json' });

test.describe('Nightly -- Profile avatar preservation', () => {
  test('omitting avatar_asset_id keeps the avatar, while explicit null clears it', async ({ page }) => {
    await page.goto('/student/profile');
    await expect(page.getByText('Изменить имя')).toBeVisible({ timeout: 10000 });

    const session = await apiRequest<{ user?: { account_id?: string } }>(page, 'GET', '/session', undefined, {
      fallbackPath: '/student/profile',
    });
    expect(session.status).toBe(200);
    const accountId = session.body?.user?.account_id ?? '';
    expect(accountId).toBeTruthy();

    const assetId = randomUUID();
    const storageKey = `e2e/avatar/${assetId}.png`;
    psqlExec(`
      insert into assets(id, owner_account_id, storage_key, mime_type, size_bytes)
      values ('${assetId}', '${accountId}', '${storageKey}', 'image/png', 123);
      update student_profiles set avatar_asset_id = '${assetId}' where account_id = '${accountId}';
    `);

    await page.reload();
    const avatar = page.getByAltText('Аватар пользователя');
    await expect(avatar).toBeVisible({ timeout: 10000 });
    await expect(avatar).toHaveAttribute('src', new RegExp(`/assets/${assetId}$`));

    await page.getByRole('button', { name: 'Изменить имя' }).click();
    const editInput = page.locator('input').first();
    await editInput.fill('Алиса с аватаром');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Алиса с аватаром')).toBeVisible({ timeout: 10000 });
    await expect(page.getByAltText('Аватар пользователя')).toHaveAttribute('src', new RegExp(`/assets/${assetId}$`));

    const clearResponse = await apiRequest<{ avatar_url?: string | null; display_name?: string }>(
      page,
      'PUT',
      '/student/profile',
      { display_name: 'Алиса с аватаром', avatar_asset_id: null },
      { fallbackPath: '/student/profile' },
    );
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body?.avatar_url ?? null).toBeNull();

    const restoreResponse = await apiRequest<{ display_name?: string }>(
      page,
      'PUT',
      '/student/profile',
      { display_name: 'Алиса', avatar_asset_id: null },
      { fallbackPath: '/student/profile' },
    );
    expect(restoreResponse.status).toBe(200);
    expect(restoreResponse.body?.display_name).toBe('Алиса');

    await page.reload();
    await expect(page.getByAltText('Аватар пользователя')).toHaveCount(0);
  });
});
