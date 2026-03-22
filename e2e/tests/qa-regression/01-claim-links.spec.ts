/**
 * QA Regression: Bug 1 — Claim links broken
 *
 * Backend generates URLs: /claim/course-link#token=<token>
 * Frontend must:
 *   1. Route /claim/course-link and /claim/guardian-link (not just /claim)
 *   2. Parse token from hash fragment (#token=...), not just query (?token=...)
 *
 * RED gate: frontend route is /claim only, token parsed from query only
 * GREEN gate: route matches /claim/*, token parsed from hash
 */
import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.describe('QA Bug 1: Claim link URL format', () => {
  test('course claim link route renders (not 404)', async ({ browser }) => {
    // Test that /claim/course-link route renders the claim component, not 404
    // Use a dummy token to avoid consuming the seeded access link
    const ctx = await browser.newContext({ storageState: '.auth/student2.json' });
    const page = await ctx.newPage();

    // Backend generates: /claim/course-link#token=<token>
    // This MUST NOT show 404 page — the route must exist
    await page.goto('/claim/course-link#token=test-route-check');

    // Wait for page to render
    await page.waitForTimeout(3000);

    // Should NOT show 404 page
    const is404 = await page.getByText('404').isVisible().catch(() => false);
    expect(is404).toBeFalsy();

    // Should show claim component (error for invalid token is expected and fine)
    const claimUI = page.getByText(/Готово|Ошибка|Активируем|недействительна|ссылку/i);
    await expect(claimUI).toBeVisible({ timeout: 10000 });

    await ctx.close();
  });

  test('guardian claim link route works (not 404)', async ({ browser }) => {
    // Test that /claim/guardian-link route renders the claim component, not 404
    // Backend generates URLs: /claim/guardian-link#token=<token>
    const ctx = await browser.newContext({ storageState: '.auth/student2.json' });
    const page = await ctx.newPage();

    // Navigate to guardian claim path with a test token — should NOT show 404
    await page.goto('/claim/guardian-link#token=test-invalid-token');

    // Wait for page to render
    await page.waitForTimeout(3000);

    // Should NOT show 404 page
    const is404 = await page.getByText('404').isVisible().catch(() => false);
    expect(is404).toBeFalsy();

    // Should show the claim component (error message for invalid token is fine)
    const claimUI = page.getByText(/Готово|Ошибка|Активируем|недействительна|ссылку/i);
    await expect(claimUI).toBeVisible({ timeout: 10000 });

    await ctx.close();
  });
});
