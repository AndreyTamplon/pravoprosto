/**
 * QA Regression: Bugs 2+3 — Lesson editor routing and graph format
 *
 * Bug 2: Lesson editor routes miss moduleId param, so editor can't find lesson in draft
 * Bug 3: Frontend saves graph as {type, data, edges} but backend expects {kind, nextNodeId, options, transitions}
 *
 * RED gate: editor opens blank (moduleId undefined), save produces invalid graph, publish fails
 * GREEN gate: editor loads existing nodes, save produces valid graph, publish succeeds
 */
import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.describe('QA Bug 2+3: Lesson editor loads content and saves valid graph', () => {
  test('teacher lesson editor loads seeded lesson content (moduleId works)', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await ctx.newPage();
    const { teacherCourseId } = fixtures;

    // Navigate to course constructor
    await page.goto(`/teacher/courses/${teacherCourseId}`);
    await expect(page.getByText('Проверяем магазин')).toBeVisible({ timeout: 10000 });

    // Click "Редактировать" to open lesson editor
    await page.getByRole('button', { name: /Редактировать/ }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);

    // Bug 2: If moduleId is undefined, editor shows ZERO nodes.
    // Seeded lesson has 3 nodes: story, single_choice, end.
    // Verify at least one badge OR textarea is visible (content loaded).
    await expect(
      page.getByText('Блок истории').first()
        .or(page.locator('textarea').first()),
    ).toBeVisible({ timeout: 10000 });

    await ctx.close();
  });

  test('save sends graph in backend format (kind/nextNodeId, not type/data)', async ({ browser }) => {
    const teacherCtx = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await teacherCtx.newPage();

    // Create a NEW course (don't modify seeded data)
    await page.goto('/teacher');
    await page.getByRole('button', { name: /Создать курс/i }).click();
    await page.getByPlaceholder('Например: Основы права').fill('QA Graph Format Test');
    await page.getByPlaceholder('Кратко опишите курс...').fill('Тест формата графа');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.waitForURL('**/teacher/courses/**');

    // Add module and lesson
    await page.getByRole('button', { name: /Модуль/i }).click();
    await expect(page.locator('input[placeholder="Название модуля..."]').first()).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: /Добавить этап/i }).click();
    await expect(page.getByText(/Этап 1/)).toBeVisible({ timeout: 3000 });

    // Save course structure first
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await page.waitForTimeout(2000); // Wait for save to complete

    // Navigate to lesson editor
    const editBtn = page.getByRole('button', { name: /Редактировать/ }).first();
    await expect(editBtn).toBeVisible({ timeout: 3000 });
    await editBtn.click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);

    // Add nodes: story + choice + terminal
    await page.getByRole('button', { name: /Блок истории/ }).click();
    await expect(page.getByText('Блок истории').first()).toBeVisible({ timeout: 2000 });
    await page.getByRole('button', { name: /Выбор ответа/ }).click();
    await expect(page.getByText('Выбор ответа').first()).toBeVisible({ timeout: 2000 });
    await page.getByRole('button', { name: /Завершение/ }).click();
    await expect(page.getByText(/Завершение|Конец/).first()).toBeVisible({ timeout: 2000 });

    // Intercept the save request to verify graph format
    let capturedBody: Record<string, unknown> | null = null;
    page.on('request', req => {
      if (req.url().includes('/draft') && req.method() === 'PUT') {
        try { capturedBody = req.postDataJSON(); } catch { /* ignore */ }
      }
    });

    // Save
    const saveBtn = page.getByRole('button', { name: /Сохранить/ });
    await saveBtn.click();

    // Verify save succeeded via UI
    const saved = page.getByText(/Сохранено/i);
    const error = page.getByText(/Ошибка|Internal Server Error|500/i);
    await Promise.race([
      saved.waitFor({ timeout: 10000 }).catch(() => {}),
      error.waitFor({ timeout: 10000 }).catch(() => {}),
    ]);
    expect(await saved.isVisible().catch(() => false)).toBeTruthy();
    expect(await error.isVisible().catch(() => false)).toBeFalsy();

    // Bug 3: Verify the captured request body uses backend graph format
    if (capturedBody) {
      const content = (capturedBody.content ?? capturedBody.content_json) as Record<string, unknown> | undefined;
      const modules = (content?.modules as Array<Record<string, unknown>>) ?? [];
      if (modules.length > 0) {
        const lesson = (modules[0]?.lessons as Array<Record<string, unknown>>)?.[0];
        if (lesson?.graph) {
          const graph = lesson.graph as Record<string, unknown>;
          const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
          if (nodes.length > 0) {
            // Backend expects 'kind' NOT 'type'
            expect(nodes[0].kind).toBeDefined();
            expect(nodes[0].type).toBeUndefined();
            // Should NOT have separate edges array
            expect(graph.edges).toBeUndefined();
          }
        }
      }
    }

    await teacherCtx.close();
  });
});
