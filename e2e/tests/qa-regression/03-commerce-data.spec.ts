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
import { createFreshStudentPage } from '../../helpers/student-lessons';

const STUDENT_NAME = 'Алиса';
const OFFER_TITLE = 'Урок: Персональные данные';

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

async function ensureAlicePurchaseRequest(
  browser: import('@playwright/test').Browser,
  platformCourseId: string,
  offerId: string,
) {
  const studentCtx = await browser.newContext({ storageState: '.auth/student.json' });
  const studentPage = await studentCtx.newPage();
  await studentPage.goto(`/student/courses/${platformCourseId}`);
  await expect(studentPage.getByText('Что нельзя рассказывать в интернете')).toBeVisible({ timeout: 10000 });

  const purchaseButton = studentPage.getByRole('button', { name: 'Оставить заявку' });
  const requestSentButton = studentPage.getByRole('button', { name: 'Заявка отправлена' });

  if (await purchaseButton.isVisible().catch(() => false)) {
    const purchaseResponse = studentPage.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes(`/student/offers/${offerId}/purchase-requests`),
    );
    await purchaseButton.click();
    expect((await purchaseResponse).ok()).toBeTruthy();
    await studentPage.goto(`/student/courses/${platformCourseId}`);
  }

  const awaitingBadge = studentPage.getByText('Ожидает подтверждения');
  await expect(requestSentButton.or(awaitingBadge)).toBeVisible();
  await studentCtx.close();
}

async function fetchRequestId(
  adminPage: import('@playwright/test').Page,
  offerId: string,
  studentName: string,
): Promise<string> {
  return adminPage.evaluate(async ({ currentOfferId, currentStudentName }) => {
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
      return (student.display_name ?? item.student_name) === currentStudentName
        && (offer.offer_id ?? item.offer_id) === currentOfferId
        && item.status === 'open';
    });
    return (match?.purchase_request_id as string | undefined) ?? '';
  }, { currentOfferId: offerId, currentStudentName: studentName });
}

async function ensureOrderForStudent(
  adminPage: import('@playwright/test').Page,
  offerId: string,
  studentName: string,
): Promise<string> {
  const fetchExistingOrderId = async () => adminPage.evaluate(async ({ currentOfferId, currentStudentName }) => {
    const response = await fetch('/api/v1/admin/commerce/orders', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return '';
    const body = await response.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items : [];
    const match = items.find((item: Record<string, unknown>) => {
      const student = (item.student ?? {}) as Record<string, unknown>;
      const offer = (item.offer ?? {}) as Record<string, unknown>;
      return (student.display_name ?? item.student_name) === currentStudentName
        && (offer.offer_id ?? item.offer_id) === currentOfferId;
    });
    return (match?.order_id as string | undefined) ?? '';
  }, { currentOfferId: offerId, currentStudentName: studentName });

  const existingOrderId = await fetchExistingOrderId();
  if (existingOrderId) {
    return existingOrderId;
  }

  const requestId = await pollForValue(
    () => fetchRequestId(adminPage, offerId, studentName),
    value => value !== '',
    15000,
  );
  expect(requestId).not.toBe('');

  await adminPage.getByRole('button', { name: 'Заявки' }).click();
  const requestRow = adminPage.locator('tbody tr')
    .filter({ hasText: studentName })
    .filter({ hasText: OFFER_TITLE })
    .first();
  await expect(requestRow).toBeVisible({ timeout: 10000 });

  const createOrderResponse = adminPage.waitForResponse((response) =>
    response.request().method() === 'POST'
    && response.url().includes('/commerce/orders/manual'),
  );
  await requestRow.getByRole('button', { name: 'Создать заказ' }).click();
  await expect(adminPage.getByText('Создать заказ из заявки')).toBeVisible();
  await adminPage.getByRole('button', { name: 'Подтвердить' }).click();
  const createOrderResult = await createOrderResponse;
  expect(createOrderResult.ok()).toBeTruthy();
  const createOrderBody = await createOrderResult.json().catch(() => null);
  const createdOrderId = (createOrderBody?.order_id as string | undefined) ?? '';
  expect(createdOrderId).not.toBe('');
  return createdOrderId;
}

test.describe('QA Bug 4: Commerce data renders correctly', () => {
  test('purchase requests tab shows student name and offer title (not empty)', async ({ browser }) => {
    const { platformCourseId, offerId } = fixtures;
    await ensureAlicePurchaseRequest(browser, platformCourseId, offerId);

    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });
    await adminPage.getByRole('button', { name: 'Заявки' }).click();
    const requestRow = adminPage.locator('tbody tr')
      .filter({ hasText: STUDENT_NAME })
      .filter({ hasText: OFFER_TITLE })
      .filter({ hasText: 'Открыта' })
      .first();
    await expect(requestRow).toBeVisible({ timeout: 10000 });
    await expect(requestRow).not.toContainText('undefined');
    await expect(requestRow).not.toContainText('NaN');

    await adminCtx.close();
  });

  test('orders tab shows student name and offer details correctly', async ({ browser }) => {
    const { platformCourseId, offerId } = fixtures;
    await ensureAlicePurchaseRequest(browser, platformCourseId, offerId);

    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });
    await ensureOrderForStudent(adminPage, offerId, STUDENT_NAME);

    await adminPage.getByRole('button', { name: 'Заказы' }).click();
    const orderRow = adminPage.locator('tbody tr')
      .filter({ hasText: STUDENT_NAME })
      .filter({ hasText: OFFER_TITLE })
      .first();
    await expect(orderRow).toBeVisible({ timeout: 10000 });
    await expect(orderRow).not.toContainText('undefined');
    await expect(orderRow).toContainText('490');
    await expect(orderRow).toContainText(/Ожидает оплаты|Выполнен/);

    await adminCtx.close();
  });
});

test.describe('QA Bug 5: Payment confirmation works', () => {
  test('admin can confirm payment without Internal Server Error', async ({ browser }) => {
    const { platformCourseId, offerId } = fixtures;
    const { context: studentCtx, page: studentPage, loginCode } = await createFreshStudentPage(browser, 'commerce-payment');
    await studentPage.goto(`/student/courses/${platformCourseId}`);
    await expect(studentPage.getByText('Что нельзя рассказывать в интернете')).toBeVisible({ timeout: 10000 });
    const purchaseButton = studentPage.getByRole('button', { name: 'Оставить заявку' });
    await expect(purchaseButton).toBeVisible();
    const purchaseResponse = studentPage.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes(`/student/offers/${offerId}/purchase-requests`),
    );
    await purchaseButton.click();
    expect((await purchaseResponse).ok()).toBeTruthy();
    await studentCtx.close();

    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/commerce');
    await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });
    const orderId = await ensureOrderForStudent(adminPage, offerId, loginCode);
    await adminPage.getByRole('button', { name: 'Заказы' }).click();
    const orderRow = adminPage.locator('tbody tr')
      .filter({ hasText: loginCode })
      .filter({ hasText: OFFER_TITLE })
      .first();
    await expect(orderRow).toBeVisible({ timeout: 10000 });
    await expect(orderRow.getByText('Ожидает оплаты')).toBeVisible({ timeout: 10000 });
    await orderRow.click();
    await expect(adminPage.getByRole('button', { name: /Подтвердить оплату/ })).toBeVisible();
    await adminPage.getByPlaceholder(/ID транзакции/i).fill('e2e-payment-test-001');

    const confirmRequestPromise = adminPage.waitForRequest(
      req => req.url().includes(`/commerce/orders/${orderId}/payments/manual-confirm`) && req.method() === 'POST',
    );
    const confirmResponse = adminPage.waitForResponse(
      response => response.request().method() === 'POST'
        && response.url().includes(`/commerce/orders/${orderId}/payments/manual-confirm`),
    );
    await adminPage.getByRole('button', { name: /Подтвердить оплату/ }).click();

    const confirmRequest = await confirmRequestPromise;
    const confirmBody = confirmRequest.postDataJSON();
    expect(confirmBody.external_reference).toBe('e2e-payment-test-001');
    expect(confirmBody.amount_minor).toBe(49000);
    expect(confirmBody.amount_confirmed_minor).toBeUndefined();
    expect(confirmBody.currency).toBe('RUB');
    expect(confirmBody.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(confirmBody.override_reason).toBeUndefined();
    expect(confirmBody.override).toBeUndefined();

    expect((await confirmResponse).ok()).toBeTruthy();

    await expect(orderRow.getByText('Выполнен')).toBeVisible({ timeout: 10000 });
    await expect(adminPage.getByText(/Ошибка|Internal Server Error|500|400/i)).not.toBeVisible();

    await adminCtx.close();
  });
});

test.describe('QA Bug 6: Offer update preserves currency', () => {
  test('editing offer does not wipe price_currency', async ({ browser }) => {
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const page = await adminCtx.newPage();

    await page.goto('/admin/commerce');
    await expect(page.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /Изменить/ }).first().click();
    await expect(page.getByText('Редактировать оффер')).toBeVisible({ timeout: 5000 });

    const modal = page.locator('[class*="modal"]').filter({ hasText: 'Редактировать оффер' });
    const inputs = modal.locator('input');
    const titleInput = inputs.first();
    await titleInput.clear();
    await titleInput.fill('Урок: Персональные данные (обновлён)');

    const updateRequest = page.waitForRequest((req) =>
      req.url().includes('/commerce/offers/') && req.method() === 'PUT',
    );
    const updateResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/commerce/offers/'),
    );
    await modal.getByRole('button', { name: /Сохранить/ }).click();
    const capturedUpdateBody = (await updateRequest).postDataJSON() as Record<string, unknown>;
    expect(capturedUpdateBody.price_currency).toBe('RUB');
    expect((capturedUpdateBody.price_amount_minor as number)).toBeGreaterThan(0);
    expect((await updateResponse).ok()).toBeTruthy();
    await expect(page.getByText(/Ошибка/i)).not.toBeVisible();
    await expect(page.getByText('490')).toBeVisible({ timeout: 5000 });

    await adminCtx.close();
  });
});
