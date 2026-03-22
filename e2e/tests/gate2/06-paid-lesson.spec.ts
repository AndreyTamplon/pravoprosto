import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

const OFFER_TITLE = 'Урок: Персональные данные';
const STUDENT_NAME = 'Борис';

async function pollForValue<T>(
  load: () => Promise<T>,
  isReady: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const startedAt = Date.now();
  let lastValue = await load();
  while (!isReady(lastValue)) {
    if (Date.now() - startedAt >= timeout) {
      return lastValue;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    lastValue = await load();
  }
  return lastValue;
}

test.describe('Gate 2 -- Paid lesson flow', () => {
  test('student requests purchase, admin confirms, lesson unlocks', async ({
    browser,
  }) => {
    const { platformCourseId, offerId } = fixtures;

    // -----------------------------------------------------------------------
    // Phase 1: Student sees locked lesson and submits purchase request
    // -----------------------------------------------------------------------
    const studentContext = await browser.newContext({
      storageState: '.auth/student2.json',
    });
    const studentPage = await studentContext.newPage();

    await studentPage.goto(`/student/courses/${platformCourseId}`);
    const studentAccountId = await studentPage.evaluate(async () => {
      const response = await fetch('/api/v1/session', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return '';
      const body = await response.json().catch(() => null);
      return (body?.user?.account_id as string | undefined) ?? '';
    });
    await expect(
      studentPage.getByText('Безопасность в интернете'),
    ).toBeVisible();

    // Verify the paid lesson "Что нельзя рассказывать в интернете" is visible
    await expect(
      studentPage.getByText('Что нельзя рассказывать в интернете'),
    ).toBeVisible();

    const priceBadge = studentPage.getByText(/490/);
    const awaitingConfirmationBadge = studentPage.getByText('Ожидает подтверждения');
    const purchaseButton = studentPage.getByRole('button', {
      name: 'Оставить заявку',
    });
    const sentButton = studentPage.getByRole('button', { name: 'Заявка отправлена' });

    await expect(priceBadge).toBeVisible();
    await expect(purchaseButton).toBeVisible();
    await expect(awaitingConfirmationBadge).not.toBeVisible();
    await expect(sentButton).not.toBeVisible();

    const purchaseResponse = studentPage.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes(`/student/offers/${offerId}/purchase-requests`),
    );
    await purchaseButton.click();
    expect((await purchaseResponse).ok()).toBeTruthy();

    await studentPage.goto(`/student/courses/${platformCourseId}`);
    await expect(
      studentPage.getByText('Что нельзя рассказывать в интернете'),
    ).toBeVisible();
    await expect(sentButton).toBeVisible();
    await expect(sentButton).toBeDisabled();
    await expect(purchaseButton).not.toBeVisible();
    await expect(awaitingConfirmationBadge).not.toBeVisible();

    // -----------------------------------------------------------------------
    // Phase 2: Admin processes the purchase request
    // -----------------------------------------------------------------------
    const adminContext = await browser.newContext({
      storageState: '.auth/admin.json',
    });
    const adminPage = await adminContext.newPage();

    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible();

    // Switch to "Заявки" tab
    await adminPage.getByRole('button', { name: 'Заявки' }).click();
    const fetchMatchingRequestId = async () => adminPage.evaluate(async ({ currentStudentId, currentOfferId }) => {
      const response = await fetch('/api/v1/admin/commerce/purchase-requests', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return '';
      const body = await response.json().catch(() => null);
      const items = Array.isArray(body?.items) ? body.items : [];
      const match = items.find((item: Record<string, unknown>) => {
        const student = (item.student ?? {}) as Record<string, unknown>;
        const offer = (item.offer ?? {}) as Record<string, unknown>;
        return (student.account_id ?? item.student_id) === currentStudentId
          && (offer.offer_id ?? item.offer_id) === currentOfferId
          && item.status === 'open';
      });
      return (match?.purchase_request_id as string | undefined) ?? '';
    }, { currentStudentId: studentAccountId, currentOfferId: offerId });
    const requestId = await pollForValue(fetchMatchingRequestId, value => value !== '', 15000);
    expect(requestId).not.toBe('');

    const requestRow = adminPage.locator('tbody tr')
      .filter({ has: adminPage.getByText(STUDENT_NAME, { exact: true }) })
      .filter({ has: adminPage.getByText(OFFER_TITLE) })
      .first();
    await expect(requestRow).toBeVisible({ timeout: 10000 });

    const createOrderButton = requestRow.getByRole('button', { name: 'Создать заказ' });
    await expect(createOrderButton).toBeVisible();

    const createOrderResponse = adminPage.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes('/commerce/orders/manual'),
    );
    await createOrderButton.click();
    await expect(adminPage.getByText('Создать заказ из заявки')).toBeVisible();
    await adminPage.getByRole('button', { name: 'Подтвердить' }).click();
    const createOrderResult = await createOrderResponse;
    expect(createOrderResult.ok()).toBeTruthy();
    const createOrderBody = await createOrderResult.json().catch(() => null);
    const createdOrderId = (createOrderBody?.order_id as string | undefined) ?? '';
    expect(createdOrderId).not.toBe('');

    const fetchMatchingOrder = async () => adminPage.evaluate(async ({ currentOrderId }) => {
      const response = await fetch('/api/v1/admin/commerce/orders', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      const items = Array.isArray(body?.items) ? body.items : [];
      const match = items.find((item: Record<string, unknown>) => item.order_id === currentOrderId);
      return match ?? null;
    }, { currentOrderId: createdOrderId });
    const createdOrder = await pollForValue(fetchMatchingOrder, value => value !== null, 15000);
    expect(createdOrder).not.toBeNull();

    const openOrdersTab = async () => {
      const ordersResponse = adminPage.waitForResponse((response) =>
        response.request().method() === 'GET' && response.url().includes('/admin/commerce/orders'),
      );
      await adminPage.getByRole('button', { name: 'Заказы' }).click();
      expect((await ordersResponse).ok()).toBeTruthy();
    };

    // Switch to "Заказы" tab and find the created order
    await adminPage.reload();
    await openOrdersTab();

    const orderRow = adminPage.locator('tbody tr')
      .filter({ has: adminPage.getByText(STUDENT_NAME, { exact: true }) })
      .filter({ has: adminPage.getByText(OFFER_TITLE) })
      .first();
    await expect(orderRow).toBeVisible({ timeout: 10000 });
    await expect(orderRow.getByText('Ожидает оплаты')).toBeVisible({ timeout: 10000 });
    await orderRow.click();
    await expect(adminPage.getByRole('button', { name: 'Подтвердить оплату' })).toBeVisible();
    await adminPage.getByPlaceholder(/ID транзакции/i).fill('e2e-payment-001');

    const confirmRequest = adminPage.waitForRequest((request) =>
      request.method() === 'POST' && request.url().includes(`/commerce/orders/${createdOrderId}/payments/manual-confirm`),
    );
    const confirmPaymentResponse = adminPage.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes(`/commerce/orders/${createdOrderId}/payments/manual-confirm`),
    );
    await adminPage.getByRole('button', { name: /Подтвердить оплату/ }).click();

    const confirmBody = (await confirmRequest).postDataJSON() as Record<string, unknown>;
    expect(confirmBody.external_reference).toBe('e2e-payment-001');
    expect(confirmBody.amount_minor).toBe(49000);
    expect(confirmBody.amount_confirmed_minor).toBeUndefined();
    expect(confirmBody.currency).toBe('RUB');
    expect(confirmBody.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(confirmBody.override).toBeUndefined();

    const confirmPaymentResult = await confirmPaymentResponse;
    expect(confirmPaymentResult.ok()).toBeTruthy();

    const fulfilledOrder = await pollForValue(fetchMatchingOrder, value => (value as Record<string, unknown> | null)?.status === 'fulfilled', 15000);
    expect((fulfilledOrder as Record<string, unknown> | null)?.status).toBe('fulfilled');
    await expect(orderRow.getByText('Выполнен')).toBeVisible({ timeout: 10000 });

    // -----------------------------------------------------------------------
    // Phase 3: Student sees the lesson is now accessible
    // -----------------------------------------------------------------------

    // Refresh the course tree
    await studentPage.goto(`/student/courses/${platformCourseId}`);

    // The previously locked lesson should now be accessible
    // It should no longer show the price badge or "Оставить заявку"
    await expect(
      studentPage.getByText('Что нельзя рассказывать в интернете'),
    ).toBeVisible();

    await expect(
      studentPage.getByRole('button', { name: 'Оставить заявку' }),
    ).not.toBeVisible();
    await expect(studentPage.getByText('Ожидает подтверждения')).not.toBeVisible();
    await expect(studentPage.getByRole('button', { name: /Начать миссию|Продолжить/i }).first()).toBeVisible();

    // Cleanup
    await studentContext.close();
    await adminContext.close();
  });
});
