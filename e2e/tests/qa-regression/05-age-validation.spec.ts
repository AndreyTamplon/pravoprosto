import { test, expect } from '@playwright/test';

test.describe('QA: Admin course create/save/publish flow', () => {
  test('admin saves integer age fields and publishes a new platform course', async ({ browser }) => {
    const adminCtx = await browser.newContext({ storageState: '.auth/admin.json' });
    const page = await adminCtx.newPage();
    const courseTitle = `QA Publish ${Date.now()}`;

    await page.goto('/admin/courses');
    await expect(page.getByRole('heading', { name: 'Курсы' })).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /Создать курс/i }).click();
    const createDialog = page.getByRole('dialog', { name: 'Создать курс' });
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel('Название').fill(courseTitle);
    await createDialog.getByLabel('Описание').fill('Курс для проверки create/save/publish из админки');
    await createDialog.getByRole('button', { name: 'Создать', exact: true }).click();

    await page.waitForURL(/\/admin\/courses\/[^/]+$/);
    await expect(page.getByLabel('Название курса')).toHaveValue(courseTitle);
    await expect(page.getByRole('button', { name: 'Сохранить' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Опубликовать' })).toBeVisible();

    await page.getByLabel('Возраст от').fill('8');
    await page.getByLabel('Возраст до').fill('12');

    await page.getByRole('button', { name: /\+ Модуль/i }).click();
    const moduleDialog = page.getByRole('dialog', { name: 'Новый модуль' });
    await expect(moduleDialog).toBeVisible();
    await moduleDialog.getByLabel('Название модуля').fill('Модуль QA');
    await moduleDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: /\+ Урок/i }).click();
    const lessonDialog = page.getByRole('dialog', { name: 'Новый урок' });
    await expect(lessonDialog).toBeVisible();
    await lessonDialog.getByLabel('Название урока').fill('Урок QA');
    await lessonDialog.getByRole('button', { name: 'Добавить' }).click();

    const saveRequest = page.waitForRequest((request) =>
      request.method() === 'PUT' && request.url().includes('/draft'),
    );
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page.getByRole('button', { name: 'Сохранить' }).click();
    const saveBody = (await saveRequest).postDataJSON() as Record<string, unknown>;
    expect(saveBody.age_min).toBe(8);
    expect(saveBody.age_max).toBe(12);
    expect((await saveResponse).ok()).toBeTruthy();
    await expect(page.getByText('Сохранено!')).toBeVisible();
    await expect(page.getByText(/Internal Server Error|500/i)).not.toBeVisible();

    const publishResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes('/publish'),
    );
    await page.getByRole('button', { name: 'Опубликовать' }).click();
    expect((await publishResponse).ok()).toBeTruthy();

    await page.goto('/admin/courses');
    await expect(page.getByRole('cell', { name: courseTitle })).toBeVisible({ timeout: 10000 });
    const row = page.getByRole('row', { name: new RegExp(courseTitle) });
    await expect(row.getByText('Опубликован')).toBeVisible();
    await expect(row.getByRole('cell').nth(3)).toHaveText('1');

    await adminCtx.close();
  });
});
