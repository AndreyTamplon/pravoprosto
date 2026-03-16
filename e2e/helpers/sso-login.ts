import type { Page } from '@playwright/test';

/**
 * Performs SSO login via mock Yandex ID.
 *
 * Flow:
 *   1. Navigate to /auth (the app's login page).
 *   2. Click "Войти через Яндекс" (or equivalent SSO button).
 *   3. On the mock SSO page, click the link matching `userLabel`.
 *   4. Wait for redirect back to the app.
 *
 * @param page      - Playwright Page instance.
 * @param userLabel - Visible text on the mock SSO user-picker link,
 *                    e.g. "Admin" or "Teacher (Мария Ивановна)".
 */
export async function loginAs(page: Page, userLabel: string): Promise<void> {
  // Step 1: Go to the app's auth page
  await page.goto('/auth');

  // Step 2: Click the Yandex SSO button.
  // The button text is "Войти через Яндекс" (may also be "Войти с Яндекс ID").
  const ssoButton = page.getByRole('link', { name: /Яндекс/i }).or(
    page.getByRole('button', { name: /Яндекс/i }),
  );
  await ssoButton.click();

  // Step 3: We are now on the mock SSO page (localhost:8091/authorize).
  // Wait for the user-picker page to load.
  await page.waitForURL(/\/authorize/);

  // Click the link matching the user label.
  // The mock renders links like "🛡️ Admin", "📚 Teacher (Мария Ивановна)", etc.
  await page.getByRole('link', { name: userLabel }).click();

  // Step 4: Wait for redirect back to the app.
  // After SSO callback the app redirects to a page that is NOT /auth.
  await page.waitForURL((url) => {
    const pathname = url.pathname;
    return !pathname.includes('/authorize') && !pathname.includes('/callback');
  });
}
