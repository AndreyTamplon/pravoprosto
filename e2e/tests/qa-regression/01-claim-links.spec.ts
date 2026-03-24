import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

async function loginViaMockSSO(page: Page, userLabel: string) {
  await page.getByRole('button', { name: /Яндекс/i }).click();
  await page.waitForURL(/\/authorize/);
  await page.getByRole('link', { name: userLabel }).click();
}

async function loginViaCustomSSO(page: Page, code: string) {
  await page.getByRole('button', { name: /Яндекс/i }).click();
  await page.waitForURL(/\/authorize/);
  await page.getByPlaceholder('custom-user-code').fill(code);
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function finishStudentOnboardingIfNeeded(page: Page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const successHeading = page.getByRole('heading', { name: 'Готово!' });
    if (await successHeading.isVisible().catch(() => false)) {
      return;
    }

    if (page.url().includes('/role-select')) {
      await page.getByText('Ученик').click();
      await page.waitForURL((url) => {
        const path = url.pathname;
        return path.includes('/student-onboarding') || path.includes('/claim/');
      });
      continue;
    }

    if (page.url().includes('/student-onboarding')) {
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.getByRole('button', { name: 'Далее' }).click();
      await page.getByRole('button', { name: 'Начать миссию' }).click();
      await page.waitForURL((url) => {
        const path = url.pathname;
        return path.includes('/claim/') || path.includes('/student/courses');
      });
      continue;
    }

    if (page.url().includes('/claim/')) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        if (await successHeading.isVisible().catch(() => false)) {
          return;
        }
        const currentPath = new URL(page.url()).pathname;
        if (currentPath.includes('/role-select') || currentPath.includes('/student-onboarding')) {
          break;
        }
        await page.waitForTimeout(200);
      }
      continue;
    }

    await page.waitForTimeout(500);
  }
}

async function createTeacherCourseLink(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  await page.goto(`/teacher/courses/${fixtures.teacherCourseId}`);
  await page.getByRole('button', { name: 'Поделиться' }).click();

  const dialog = page.getByRole('dialog', { name: 'Поделиться курсом' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Создать ссылку/i }).click();

  const linkText = dialog.getByText(/\/claim\/course-link#token=/).first();
  await expect(linkText).toBeVisible();
  const link = (await linkText.textContent())?.trim() ?? '';
  await expect(link).toContain('/claim/course-link#token=');

  await page.close();
  return link;
}

async function createGuardianInviteLink(context: BrowserContext): Promise<{ link: string; page: Page }> {
  const page = await context.newPage();
  await page.goto('/parent');
  await page.getByRole('button', { name: /\+ Добавить ребёнка/i }).click();

  const dialog = page.getByRole('dialog', { name: 'Добавить ребёнка' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Создать приглашение' }).click();

  const linkText = dialog.getByText(/\/claim\/guardian-link#token=/).first();
  await expect(linkText).toBeVisible();
  const link = (await linkText.textContent())?.trim() ?? '';
  await expect(link).toContain('/claim/guardian-link#token=');

  return { link, page };
}

test.describe('QA Bug 1: Claim links use real auth redirect and hash-token claim', () => {
  test('teacher course claim survives logged-out redirect and unlocks the course', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const claimLink = await createTeacherCourseLink(teacherContext);
    await teacherContext.close();

    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();

    await anonymousPage.goto(claimLink);
    await anonymousPage.waitForURL(/\/auth\?return_to=/);
    await expect(anonymousPage).toHaveURL(/return_to=.*%2Fclaim%2Fcourse-link/);

    await loginViaMockSSO(anonymousPage, 'Student 2 (Борис)');

    await expect(anonymousPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await expect(anonymousPage.getByText('Курс успешно добавлен')).toBeVisible();

    await anonymousPage.getByRole('button', { name: 'Продолжить' }).click();
    await anonymousPage.waitForURL(/\/student\/courses/);
    await expect(
      anonymousPage.getByRole('heading', { name: 'Покупки онлайн', exact: true }).first(),
    ).toBeVisible();

    await anonymousContext.close();
  });

  test('fresh user can finish role selection and onboarding without losing the claim flow', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const claimLink = await createTeacherCourseLink(teacherContext);
    await teacherContext.close();

    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    const freshCode = `claim-fresh-${Date.now()}`;

    await anonymousPage.goto(claimLink);
    await anonymousPage.waitForURL(/\/auth\?return_to=/);
    await expect(anonymousPage).toHaveURL(/return_to=.*%2Fclaim%2Fcourse-link/);

    await loginViaCustomSSO(anonymousPage, freshCode);
    await finishStudentOnboardingIfNeeded(anonymousPage);

    await expect(anonymousPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await expect(anonymousPage.getByText('Курс успешно добавлен')).toBeVisible();

    await anonymousPage.getByRole('button', { name: 'Продолжить' }).click();
    await anonymousPage.waitForURL(/\/student\/courses/);
    await expect(
      anonymousPage.getByRole('heading', { name: 'Покупки онлайн', exact: true }).first(),
    ).toBeVisible();

    await anonymousContext.close();
  });

  test('guardian claim survives logged-out redirect and parent sees the new child', async ({ browser }) => {
    const parentContext = await browser.newContext({ storageState: '.auth/parent.json' });
    const { link, page: parentPage } = await createGuardianInviteLink(parentContext);

    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();

    await anonymousPage.goto(link);
    await anonymousPage.waitForURL(/\/auth\?return_to=/);
    await expect(anonymousPage).toHaveURL(/return_to=.*%2Fclaim%2Fguardian-link/);

    await loginViaMockSSO(anonymousPage, 'Student 2 (Борис)');

    await expect(anonymousPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({ timeout: 15000 });
    await expect(anonymousPage.getByText('Связь с родителем установлена')).toBeVisible();

    await anonymousPage.getByRole('button', { name: 'Продолжить' }).click();
    await anonymousPage.waitForURL(/\/student\/profile/);

    await parentPage.goto('/parent');
    await expect(parentPage.getByText('Борис')).toBeVisible({ timeout: 10000 });

    await anonymousContext.close();
    await parentContext.close();
  });

  test('authenticated non-student sees a clear Russian error instead of broken course claim flow', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const claimLink = await createTeacherCourseLink(teacherContext);
    await teacherContext.close();

    const parentContext = await browser.newContext({ storageState: '.auth/parent.json' });
    const parentPage = await parentContext.newPage();

    await parentPage.goto(claimLink);
    await expect(parentPage).toHaveURL(/\/claim\/course-link/);
    await expect(parentPage.getByRole('heading', { name: 'Ошибка' })).toBeVisible({ timeout: 10000 });
    await expect(parentPage.getByText('Ссылку может активировать только ученик.')).toBeVisible();
    await expect(parentPage.getByRole('button', { name: 'На главную' })).toBeVisible();
    await expect(parentPage).not.toHaveURL(/\/student\/courses/);

    await parentContext.close();
  });
});
