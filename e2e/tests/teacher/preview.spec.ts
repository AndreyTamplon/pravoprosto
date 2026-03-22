import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Preview player', () => {
  test('preview restores the same session after reload, reaches 100% at the end, and returns to the lesson editor', async ({ page }) => {
    const { teacherCourseId } = fixtures;

    await page.goto(`/teacher/courses/${teacherCourseId}`);
    await expect(page.getByText('Проверяем магазин')).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /Редактировать/ }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
    await expect(page.getByRole('button', { name: 'Предпросмотр' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeVisible();

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    await page.waitForURL(/\/teacher\/preview\/.+/);
    const previewSessionId = page.url().match(/\/teacher\/preview\/([^/?#]+)/)?.[1];
    expect(previewSessionId).toBeTruthy();
    await expect(page.getByText('Режим предпросмотра - данные не сохраняются')).toBeVisible();

    const previewReloadResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET'
      && response.url().includes(`/api/v1/preview-sessions/${previewSessionId}`),
    );
    await page.reload();
    const previewReloadBody = await (await previewReloadResponse).json();
    expect(previewReloadBody.preview).toBe(true);
    expect(previewReloadBody.preview_session_id).toBe(previewSessionId);
    expect(previewReloadBody.step.lesson_id).toBeTruthy();
    expect(previewReloadBody.step.node_kind).toBe('story');
    expect(previewReloadBody.step.steps_total).toBeGreaterThan(0);
    expect((previewReloadBody.step.payload?.text as string | undefined)?.trim()).toBeTruthy();

    await expect(page.getByText(/Ты нашёл в интернете магазин/i)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Что ты сделаешь?')).toBeVisible();
    await page.getByRole('button', { name: 'Проверю отзывы и сравню цены' }).click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Правильно!')).toBeVisible();
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText(/если цена слишком хороша/i)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('100%')).toBeVisible();
    await page.getByRole('button', { name: 'Завершить предпросмотр' }).click();
    await expect(page.getByText('Предпросмотр этапа завершён')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('100%')).toBeVisible();

    await page.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
    await expect(page.getByRole('button', { name: 'Предпросмотр' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeVisible();

    await page.getByRole('button', { name: /К курсу/ }).click();
    await page.waitForURL(/\/teacher\/courses\/[^/]+$/);
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
