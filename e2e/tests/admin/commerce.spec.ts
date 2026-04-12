import { test, expect } from '@playwright/test';
import { apiRequest } from '../../helpers/browser-api';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: Commerce', () => {
  test('Тарифы tab shows seeded offer with correct title, price, and status', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Four tabs must exist with Russian labels
    for (const tab of ['Тарифы', 'Заявки', 'Заказы', 'Доступы']) {
      await expect(page.getByRole('button', { name: tab })).toBeVisible();
    }

    // Onboarding block visible by default
    await expect(page.getByText('Как работает монетизация')).toBeVisible();
    await expect(page.getByText('Тариф', { exact: false })).toBeVisible();

    // Тарифы tab is active by default
    await expect(page.getByRole('button', { name: 'Создать тариф' })).toBeVisible();

    // Table headers
    const headers = ['Название', 'Тип', 'Курс / Урок', 'Цена', 'Статус', 'Создан', 'Действия'];
    for (const h of headers) {
      await expect(page.getByRole('columnheader', { name: h })).toBeVisible();
    }

    // Seeded offer: "Урок: Персональные данные", 490 RUB, active
    await expect(page.getByRole('cell', { name: 'Урок: Персональные данные' })).toBeVisible();
    await expect(page.getByText('490')).toBeVisible();
    await expect(page.getByText('Активный')).toBeVisible();
  });

  test('switching tabs loads Заявки, Заказы, and Доступы content', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Switch to Заявки — empty state
    await page.getByRole('button', { name: 'Заявки' }).click();
    await expect(page.getByText('Нет заявок')).toBeVisible();

    // Switch to Заказы — empty state
    await page.getByRole('button', { name: 'Заказы' }).click();
    await expect(page.getByText('Нет заказов')).toBeVisible();

    // Switch to Доступы — list view with filters
    await page.getByRole('button', { name: 'Доступы' }).click();
    await expect(page.getByText(/\d+ доступов/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Выдать доступ' })).toBeVisible();

    // Filter controls present
    await expect(page.getByText('Статус', { exact: false })).toBeVisible();
    await expect(page.getByPlaceholder('Фильтр по ученику')).toBeVisible();
  });

  test('Доступы tab: grant entitlement modal has StudentPicker and LessonSelect', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Switch to Доступы
    await page.getByRole('button', { name: 'Доступы' }).click();
    await expect(page.getByRole('button', { name: 'Выдать доступ' })).toBeVisible();

    // Open grant modal
    await page.getByRole('button', { name: 'Выдать доступ' }).click();
    await expect(page.getByText('Выдать доступ').first()).toBeVisible();

    // StudentPicker present (search input, not raw UUID)
    await expect(page.getByPlaceholder('Начните вводить имя')).toBeVisible();

    // Target type and course dropdowns present
    await expect(page.locator('select').filter({ hasText: 'Курс' }).first()).toBeVisible();

    // Switch to "Урок" target type — LessonSelect should appear
    await page.locator('select').filter({ hasText: 'Курс' }).first().selectOption('lesson');
    await expect(page.locator('select').filter({ hasText: 'Выберите урок' })).toBeVisible({ timeout: 5000 });

    // Close modal
    await page.getByRole('button', { name: 'Отмена' }).click();
  });

  test('Доступы tab: grant + list + revoke lifecycle via API', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    const { platformCourseId } = fixtures;

    // Find a student account ID via admin users API
    const usersResult = await apiRequest<{ items: { account_id: string; role: string; display_name: string }[] }>(
      page, 'GET', '/admin/users?role=student'
    );
    expect(usersResult.status).toBe(200);
    const student = usersResult.body!.items[0];
    expect(student).toBeTruthy();

    // Grant complimentary entitlement via API
    const grantResult = await apiRequest<{ entitlement_id: string }>(
      page, 'POST', '/admin/commerce/entitlements/grants', {
        student_id: student.account_id,
        target_type: 'course',
        target_course_id: platformCourseId,
      }
    );
    expect(grantResult.status).toBe(200);
    const entitlementId = grantResult.body!.entitlement_id;
    expect(entitlementId).toBeTruthy();

    // Verify entitlement appears in list API
    const listResult = await apiRequest<{ items: { entitlement_id: string; status: string }[] }>(
      page, 'GET', `/admin/commerce/entitlements?student_id=${student.account_id}`
    );
    expect(listResult.status).toBe(200);
    const found = listResult.body!.items.find(e => e.entitlement_id === entitlementId);
    expect(found).toBeTruthy();
    expect(found!.status).toBe('active');

    // Revoke the entitlement
    const revokeResult = await apiRequest(
      page, 'POST', `/admin/commerce/entitlements/${entitlementId}/revoke`
    );
    expect(revokeResult.status).toBe(200);

    // Verify revoked in list
    const listAfterRevoke = await apiRequest<{ items: { entitlement_id: string; status: string }[] }>(
      page, 'GET', `/admin/commerce/entitlements?student_id=${student.account_id}&status=revoked`
    );
    expect(listAfterRevoke.status).toBe(200);
    const revokedEntry = listAfterRevoke.body!.items.find(e => e.entitlement_id === entitlementId);
    expect(revokedEntry).toBeTruthy();
    expect(revokedEntry!.status).toBe('revoked');
  });

  test('User search API: ?q= parameter filters by name', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // Search for a known student by partial name
    const usersAll = await apiRequest<{ items: { display_name: string }[] }>(
      page, 'GET', '/admin/users?role=student'
    );
    expect(usersAll.status).toBe(200);
    const firstStudent = usersAll.body!.items[0];
    expect(firstStudent).toBeTruthy();

    // Search by first 3 characters of student name
    const searchTerm = firstStudent.display_name.substring(0, 3);
    const searchResult = await apiRequest<{ items: { display_name: string }[] }>(
      page, 'GET', `/admin/users?role=student&q=${encodeURIComponent(searchTerm)}`
    );
    expect(searchResult.status).toBe(200);
    expect(searchResult.body!.items.length).toBeGreaterThanOrEqual(1);
    expect(
      searchResult.body!.items.some(u =>
        u.display_name.toLowerCase().includes(searchTerm.toLowerCase())
      )
    ).toBeTruthy();
  });

  test('Entitlements list API: filters by status', async ({ page }) => {
    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

    // List all entitlements
    const allResult = await apiRequest<{ items: { status: string }[] }>(
      page, 'GET', '/admin/commerce/entitlements'
    );
    expect(allResult.status).toBe(200);

    // List only active
    const activeResult = await apiRequest<{ items: { status: string }[] }>(
      page, 'GET', '/admin/commerce/entitlements?status=active'
    );
    expect(activeResult.status).toBe(200);
    for (const e of activeResult.body!.items) {
      expect(e.status).toBe('active');
    }

    // List only revoked
    const revokedResult = await apiRequest<{ items: { status: string }[] }>(
      page, 'GET', '/admin/commerce/entitlements?status=revoked'
    );
    expect(revokedResult.status).toBe(200);
    for (const e of revokedResult.body!.items) {
      expect(e.status).toBe('revoked');
    }
  });

  test('onboarding block can be dismissed', async ({ page }) => {
    // Clear localStorage to ensure onboarding is visible
    await page.goto('/admin/commerce');
    await page.evaluate(() => localStorage.removeItem('commerce_help_dismissed'));
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Как работает монетизация')).toBeVisible();

    // Dismiss onboarding
    await page.getByRole('button', { name: 'Скрыть' }).click();
    await expect(page.getByText('Как работает монетизация')).not.toBeVisible();

    // Reload — should stay dismissed
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Как работает монетизация')).not.toBeVisible();
  });
});
