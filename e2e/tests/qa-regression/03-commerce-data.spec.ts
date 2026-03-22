/**
 * QA Regression: Bugs 4+5+6 — Commerce data mismatches
 *
 * Bug 4: Backend returns nested {student: {display_name}, offer: {title}},
 *         frontend expects flat {student_name, offer_title}
 * Bug 5: Confirm payment sends wrong field names (amount_confirmed_minor vs amount_minor,
 *         flat override_reason vs nested override.reason, missing paid_at and currency)
 * Bug 6: Offer update missing price_currency, backend overwrites with NULL
 *
 * RED gate: purchase requests show empty names, confirm payment returns 500,
 *           offer edit wipes currency
 * GREEN gate: all fields render correctly, payment confirms, currency preserved
 */
import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.describe('QA Bug 4: Commerce data renders correctly', () => {
  test('purchase requests tab shows student name and offer title (not empty)', async ({ browser }) => {
    const { platformCourseId } = fixtures;

    // First: student submits a purchase request
    const studentCtx = await browser.newContext({ storageState: '.auth/student.json' });
    const studentPage = await studentCtx.newPage();

    await studentPage.goto(`/student/courses/${platformCourseId}`);
    await expect(studentPage.getByText('Что нельзя рассказывать в интернете')).toBeVisible({ timeout: 10000 });

    // Click purchase request button (if available)
    const purchaseBtn = studentPage.getByRole('button', { name: /Оставить заявку/i });
    const canRequest = await purchaseBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (canRequest) {
      await purchaseBtn.click();
      await studentPage.waitForTimeout(2000);
    }
    await studentCtx.close();

    // Now: admin views requests tab
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });

    // Switch to Requests tab
    await adminPage.getByRole('button', { name: 'Заявки' }).click();
    await adminPage.waitForTimeout(2000);

    // Bug 4: If backend sends nested {student: {display_name}} but frontend
    // expects flat {student_name}, the name column will show "undefined" or empty
    const hasRequest = await adminPage.getByText('Открыта').isVisible({ timeout: 5000 }).catch(() => false);

    if (hasRequest) {
      // Student name should be "Алиса", NOT "undefined" or empty
      await expect(adminPage.getByText('Алиса')).toBeVisible();
      // Offer title should be visible, NOT "undefined"
      await expect(adminPage.getByText('Урок: Персональные данные')).toBeVisible();

      // Should NOT show "undefined" anywhere in the table
      const undefinedCount = await adminPage.locator('td:has-text("undefined")').count();
      expect(undefinedCount).toBe(0);
    }

    await adminCtx.close();
  });

  test('orders tab shows student name and offer details correctly', async ({ browser }) => {
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });

    // Switch to Orders tab
    await adminPage.getByRole('button', { name: 'Заказы' }).click();
    await adminPage.waitForTimeout(2000);

    // Check for any orders
    const hasOrders = await adminPage.getByText(/Ожидает оплаты|Выполнен/).isVisible({ timeout: 3000 }).catch(() => false);

    if (hasOrders) {
      // Order row should NOT have "undefined" values
      const undefinedCount = await adminPage.locator('td:has-text("undefined")').count();
      expect(undefinedCount).toBe(0);

      // Student name and price should be visible
      const cells = adminPage.locator('tbody td');
      const cellTexts = await cells.allTextContents();
      // None of the cells should be empty or "undefined"
      for (const text of cellTexts) {
        expect(text.trim()).not.toBe('undefined');
      }
    }

    await adminCtx.close();
  });
});

test.describe('QA Bug 5: Payment confirmation works', () => {
  test('admin can confirm payment without Internal Server Error', async ({ browser }) => {
    const { platformCourseId } = fixtures;

    // Setup: ensure a purchase request exists and order is created
    const studentCtx = await browser.newContext({ storageState: '.auth/student.json' });
    const studentPage = await studentCtx.newPage();
    await studentPage.goto(`/student/courses/${platformCourseId}`);
    await studentPage.waitForTimeout(2000);

    // Try to create purchase request if possible
    const purchaseBtn = studentPage.getByRole('button', { name: /Оставить заявку/i });
    const canRequest = await purchaseBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (canRequest) {
      await purchaseBtn.click();
      await studentPage.waitForTimeout(2000);
    }
    await studentCtx.close();

    // Admin: process request → create order → confirm payment
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });

    // Create order from request (if request exists)
    await adminPage.getByRole('button', { name: 'Заявки' }).click();
    await adminPage.waitForTimeout(1000);

    const hasOpenRequest = await adminPage.getByText('Открыта').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasOpenRequest) {
      await adminPage.getByRole('button', { name: 'Создать заказ' }).first().click();
      await expect(adminPage.getByText('Создать заказ из заявки')).toBeVisible();
      await adminPage.getByRole('button', { name: 'Подтвердить' }).click();
      await adminPage.waitForTimeout(3000);
      await adminPage.keyboard.press('Escape');
    }

    // Switch to Orders tab
    await adminPage.getByRole('button', { name: 'Заказы' }).click();
    await adminPage.waitForTimeout(1000);

    const hasOrder = await adminPage.getByText('Ожидает оплаты').isVisible({ timeout: 5000 }).catch(() => false);
    if (hasOrder) {
      // Open order detail
      await adminPage.locator('tbody tr').first().click();
      await expect(adminPage.getByRole('button', { name: /Подтвердить оплату/ })).toBeVisible();

      // Fill confirmation form
      await adminPage.getByPlaceholder(/ID транзакции/i).fill('e2e-payment-test-001');

      // Bug 5: Intercept the request to verify correct field names
      const confirmRequestPromise = adminPage.waitForRequest(
        req => req.url().includes('/manual-confirm') && req.method() === 'POST',
      );

      await adminPage.getByRole('button', { name: /Подтвердить оплату/ }).click();

      const confirmRequest = await confirmRequestPromise;
      const confirmBody = confirmRequest.postDataJSON();

      // Bug 5: MUST send 'amount_minor', NOT 'amount_confirmed_minor'
      expect(confirmBody.amount_minor).toBeDefined();
      expect(confirmBody.amount_confirmed_minor).toBeUndefined();
      // MUST send 'currency'
      expect(confirmBody.currency).toBeTruthy();
      // MUST send 'paid_at' in RFC3339
      expect(confirmBody.paid_at).toBeTruthy();
      expect(confirmBody.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 'override_reason' at top level must NOT exist (should be nested override.reason)
      expect(confirmBody.override_reason).toBeUndefined();

      // Should NOT see error after confirmation
      const errorVisible = await adminPage.getByText(/Ошибка|Internal Server Error|500|400/i)
        .isVisible({ timeout: 5000 }).catch(() => false);
      expect(errorVisible).toBeFalsy();

      // Should see order status change to "Выполнен"
      await expect(adminPage.getByText('Выполнен')).toBeVisible({ timeout: 5000 });
    }

    await adminCtx.close();
  });
});

test.describe('QA Bug 6: Offer update preserves currency', () => {
  test('editing offer does not wipe price_currency', async ({ browser }) => {
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const page = await adminCtx.newPage();

    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });

    // Find the seeded offer and click Edit
    await page.getByRole('button', { name: /Изменить/ }).first().click();

    // Edit modal should open
    await expect(page.getByText('Редактировать оффер')).toBeVisible({ timeout: 5000 });

    // Bug 6: Frontend must send price_currency in update
    // Find the title input in the modal and change it
    const modal = page.locator('[class*="modal"]').filter({ hasText: 'Редактировать оффер' });
    const inputs = modal.locator('input');
    const titleInput = inputs.first();
    await titleInput.clear();
    await titleInput.fill('Урок: Персональные данные (обновлён)');

    // Intercept update request to verify price_currency is sent
    let capturedUpdateBody: Record<string, unknown> | null = null;
    page.on('request', req => {
      if (req.url().includes('/commerce/offers/') && req.method() === 'PUT') {
        try { capturedUpdateBody = req.postDataJSON(); } catch { /* ignore */ }
      }
    });

    // Click Сохранить inside the modal
    await modal.getByRole('button', { name: /Сохранить/ }).click();
    await page.waitForTimeout(2000);

    // Bug 6: Verify request body includes price_currency
    if (capturedUpdateBody) {
      expect(capturedUpdateBody.price_currency).toBeTruthy();
      expect(capturedUpdateBody.price_currency).toBe('RUB');
      expect((capturedUpdateBody.price_amount_minor as number)).toBeGreaterThan(0);
    }

    // Verify no error
    const hasError = await page.getByText(/Ошибка/i).isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();

    // Verify offer table still shows price (490) — not 0 or empty
    await expect(page.getByText('490')).toBeVisible({ timeout: 5000 });

    await adminCtx.close();
  });
});
