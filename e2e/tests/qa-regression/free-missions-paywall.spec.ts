import { test, expect } from '@playwright/test';
import { apiRequest, getSessionAccountId } from '../../helpers/browser-api';
import { fixtures } from '../../helpers/fixtures';

/**
 * Manual-QA evidence run for the free-missions-paywall feature.
 *
 * Run ALONE (single spec, --workers=1): activating a platform offer gates ALL platform courses
 * globally, so this must not run concurrently with the rest of the suite.
 *
 *   cd e2e && npx playwright test tests/qa-regression/free-missions-paywall.spec.ts --workers=1
 *
 * The seeded "Безопасность в интернете" course has module 1 [phishing, passwords] and
 * module 2 [personal_data]. With free_lesson_count=2, the first module is free and
 * personal_data (first lesson of module 2) sits behind the paywall.
 *
 * T-Bank is not configured in the e2e stack, so the actual redirect/webhook is covered by the
 * Go integration tests; here the global unlock is demonstrated via an admin complimentary grant.
 */

const SHOT = '/Users/aatamplon/PycharmProjects/hse/pravoprost/plan/free-missions-paywall/evidence';

test('free-missions paywall: free tier, paywall CTA, admin config, global unlock', async ({ browser }) => {
  const { platformCourseId } = fixtures;

  // ---- Admin: configure free tier + platform offer ----
  const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
  const adminPage = await adminCtx.newPage();
  await adminPage.goto('/admin/commerce');
  await expect(adminPage.getByRole('heading', { name: 'Коммерция' })).toBeVisible({ timeout: 15000 });

  const freeRes = await apiRequest(adminPage, 'PUT', `/admin/commerce/courses/${platformCourseId}/free-access`, { free_lesson_count: 2 });
  expect(freeRes.status, 'set free_lesson_count=2').toBe(200);

  const createRes = await apiRequest<{ offer_id: string }>(adminPage, 'POST', '/admin/commerce/offers', {
    target_type: 'platform', title: 'Полный доступ', description: 'Доступ ко всем урокам',
    price_amount_minor: 9900, price_currency: 'RUB',
  });
  expect(createRes.status, 'create platform offer').toBe(201);
  const platformOfferId = createRes.body!.offer_id;

  const actRes = await apiRequest(adminPage, 'PUT', `/admin/commerce/offers/${platformOfferId}`, {
    title: 'Полный доступ', description: 'Доступ ко всем урокам',
    price_amount_minor: 9900, price_currency: 'RUB', status: 'active',
  });
  expect(actRes.status, 'activate platform offer').toBe(200);

  // Admin UI evidence: «Бесплатный доступ» tab + platform offer in Тарифы.
  await adminPage.reload();
  await adminPage.getByRole('button', { name: 'Бесплатный доступ' }).click();
  await expect(adminPage.getByText(/Сколько первых уроков курса доступны бесплатно/)).toBeVisible();
  await adminPage.screenshot({ path: `${SHOT}/admin-free-access-tab.png`, fullPage: true });

  await adminPage.getByRole('button', { name: 'Тарифы' }).click();
  // "Полный доступ" appears both as the offer title and the type badge — assert at least one,
  // plus the 99 ₽ price which is unique to this offer.
  await expect(adminPage.getByText('Полный доступ').first()).toBeVisible();
  await expect(adminPage.getByText('99 ₽').first()).toBeVisible();
  await adminPage.screenshot({ path: `${SHOT}/admin-platform-offer.png`, fullPage: true });

  // ---- Student: catalog banner + paywall on the course tree ----
  const studentCtx = await browser.newContext({ storageState: '.auth/student.json' });
  const studentPage = await studentCtx.newPage();
  const studentId = await getSessionAccountId(studentPage, '/student/courses');
  expect(studentId, 'student account id').not.toBe('');

  await studentPage.goto('/student/courses');
  await expect(studentPage.getByText(/Первые 2 бесплатно/)).toBeVisible({ timeout: 15000 });
  await studentPage.screenshot({ path: `${SHOT}/student-catalog-banner.png`, fullPage: true });

  await studentPage.goto(`/student/courses/${platformCourseId}`);
  await expect(studentPage.getByText('Безопасность в интернете')).toBeVisible({ timeout: 15000 });
  // Paid lesson (personal_data) shows the platform paywall CTA + parent hint + price.
  await expect(studentPage.getByRole('button', { name: 'Открыть полный доступ' })).toBeVisible();
  await expect(studentPage.getByText('или попроси родителя оплатить')).toBeVisible();
  await expect(studentPage.getByText(/99/)).toBeVisible();
  await studentPage.screenshot({ path: `${SHOT}/student-tree-paywall.png`, fullPage: true });

  // ---- Global unlock via admin complimentary grant ----
  const grantRes = await apiRequest(adminPage, 'POST', '/admin/commerce/entitlements/grants', {
    student_id: studentId, target_type: 'platform',
  });
  expect([200, 201], 'platform complimentary grant').toContain(grantRes.status);

  await studentPage.reload();
  await expect(studentPage.getByText('Безопасность в интернете')).toBeVisible({ timeout: 15000 });
  // Paywall CTA gone — the previously locked lesson is now accessible.
  await expect(studentPage.getByRole('button', { name: 'Открыть полный доступ' })).toHaveCount(0);
  await studentPage.screenshot({ path: `${SHOT}/student-tree-unlocked.png`, fullPage: true });

  await adminCtx.close();
  await studentCtx.close();
});
