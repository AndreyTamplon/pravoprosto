import { test, expect } from '@playwright/test';

test.describe('Gate 2 -- First login flow (new user)', () => {
  test('new user completes SSO login, role selection, onboarding, and sees catalog', async ({
    page,
  }) => {
    const newUserCode = `e2e-newuser-${Date.now()}`;

    // 1. Go to landing page
    await page.goto('/');

    // 2. Verify the landing page renders
    // Landing.tsx: <h1><span>SmartGo School</span> — обучение, которое действительно увлекает</h1>
    await expect(page.getByText('SmartGo School').first()).toBeVisible({ timeout: 10000 });
    const ctaButton = page.getByRole('button', { name: 'Начать' });
    await expect(ctaButton).toBeVisible();

    // 3. Click "Начать" -- when not authenticated, this calls login() which redirects to mock SSO
    await ctaButton.click();

    // 4. On mock SSO page, click a new-user link (the mock SSO user-picker renders links for each user)
    //    For a brand-new user, use the custom code input if available, or click a known new-user link.
    await page.waitForURL(/\/authorize/);
    const customInput = page.getByPlaceholder('custom-user-code');
    await expect(customInput).toBeVisible({ timeout: 5000 });
    await customInput.fill(newUserCode);
    await page.getByRole('button', { name: /Войти/i }).click();

    // 5. New users must reach role selection first.
    await page.waitForURL((url) => {
      const p = url.pathname;
      return p.includes('/role-select') || p.includes('/student-onboarding') || p.includes('/student/courses');
    });
    await expect(page).toHaveURL(/\/role-select/);
    await expect(page.getByText('Кто вы?')).toBeVisible();
    await expect(page.getByText('Ученик')).toBeVisible();
    await expect(page.getByText('Родитель')).toBeVisible();
    await expect(page.getByText('Учитель')).toBeVisible();

    await page.getByText('Ученик').click();
    await page.waitForURL(/\/student-onboarding/);

    await expect(page.getByText('Привет!')).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    await expect(page.getByText(/Проходи истории/)).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    await expect(page.getByText(/Зарабатывай XP/)).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();

    await expect(page.getByText('Начнём!')).toBeVisible();
    await page.getByRole('button', { name: 'Начать миссию' }).click();

    await page.waitForURL(/\/student\/courses/);
    await expect(page.getByText('Штаб героя')).toBeVisible();
    await expect(page.getByText('Безопасность в интернете')).toBeVisible();
  });
});
