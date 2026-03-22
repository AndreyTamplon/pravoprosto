import { test, expect } from '@playwright/test';

test.describe('QA Bugs 2+3+preview/save semantics: lesson editor roundtrip', () => {
  test('teacher editor saves backend graph, survives repeated saves, and preview works after reload', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const page = await teacherContext.newPage();

    await page.goto('/teacher');
    await page.getByRole('button', { name: /\+ Создать курс/i }).click();
    await page.getByPlaceholder('Например: Основы права').fill('QA Roundtrip Course');
    await page.getByPlaceholder('Кратко опишите курс...').fill('Курс для проверки editor roundtrip');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.waitForURL(/\/teacher\/courses\/[^/]+$/);

    await page.getByRole('button', { name: /\+ Модуль/i }).click();
    await page.getByPlaceholder('Название модуля...').fill('Модуль предпросмотра');
    await page.getByRole('button', { name: /\+ Добавить этап/i }).click();
    await expect(page.getByText('1. Этап 1')).toBeVisible();

    await page.getByRole('button', { name: 'Редактировать' }).click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);

    await page.getByPlaceholder('Название этапа...').fill('Этап с предпросмотром');

    await page.getByRole('button', { name: /\+ Блок истории/i }).click();
    await page.getByRole('button', { name: /\+ Выбор ответа/i }).click();
    await page.getByRole('button', { name: /\+ Свободный ответ/i }).click();
    await page.getByRole('button', { name: /\+ Завершение/i }).click();

    await page.getByLabel('Текст истории').fill('История о безопасном выборе.');
    await page.getByLabel('Текст вопроса').first().fill('Какой вариант безопаснее?');

    const optionInputs = page.getByPlaceholder('Вариант ответа...');
    await optionInputs.nth(0).fill('Проверить информацию у взрослого');
    await optionInputs.nth(1).fill('Сразу перейти по подозрительной ссылке');

    await page.getByLabel('Обратная связь (правильно)').fill('Да, сначала нужно проверить источник.');
    await page.getByLabel('Обратная связь (неправильно)').fill('Нет, по подозрительным ссылкам переходить нельзя.');

    await page.getByLabel('Текст вопроса').nth(1).fill('Почему нельзя доверять подозрительной ссылке?');
    await page.getByLabel('Эталонный ответ').fill('Потому что ссылка может вести на мошеннический сайт.');
    await page.getByLabel('Критерии оценивания').fill('Нужно упомянуть риск мошенничества или вредоносного сайта.');
    await page.getByRole('textbox', { name: 'Обратная связь', exact: true }).fill(
      'Хорошо, ты понимаешь риск перехода по подозрительным ссылкам.',
    );

    const firstSaveRequest = page.waitForRequest((request) =>
      request.method() === 'PUT' && request.url().includes('/draft'),
    );
    const firstSaveResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page.getByRole('button', { name: 'Сохранить' }).click();
    const firstSave = await firstSaveRequest;
    expect((await firstSaveResponse).ok()).toBeTruthy();

    const firstBody = firstSave.postDataJSON() as Record<string, unknown>;
    const content = (firstBody.content ?? firstBody.content_json) as Record<string, unknown>;
    const modules = (content.modules as Array<Record<string, unknown>>) ?? [];
    const lesson = ((modules[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];

    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes[0].kind).toBeDefined();
    expect(nodes[0].type).toBeUndefined();
    expect(graph.edges).toBeUndefined();

    const freeTextNode = nodes.find((node) => node.kind === 'free_text');
    expect(freeTextNode).toBeTruthy();
    expect((freeTextNode?.rubric as Record<string, unknown>).referenceAnswer).toBe(
      'Потому что ссылка может вести на мошеннический сайт.',
    );
    expect((freeTextNode?.rubric as Record<string, unknown>).reference_answer).toBeUndefined();

    await page.getByPlaceholder('Название этапа...').fill('Этап с предпросмотром v2');

    const secondSaveRequest = page.waitForRequest((request) =>
      request.method() === 'PUT' && request.url().includes('/draft'),
    );
    const secondSaveResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await secondSaveRequest;
    expect((await secondSaveResponse).ok()).toBeTruthy();
    await expect(page.getByText(/Draft version conflict|конфликт/i)).not.toBeVisible();

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    await page.waitForURL(/\/teacher\/preview\/.+/);

    await page.reload();
    await expect(page.getByText('История', { exact: true })).toBeVisible();
    await expect(page.getByText('История о безопасном выборе.')).toBeVisible();

    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.getByText('Какой вариант безопаснее?')).toBeVisible();

    await page.getByRole('button', { name: 'Проверить информацию у взрослого' }).click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText('Правильно!')).toBeVisible();
    await page.getByRole('button', { name: /Далее|Продолжить/ }).click();

    await expect(page.getByText('Почему нельзя доверять подозрительной ссылке?')).toBeVisible();
    await page.getByPlaceholder('Введите ваш ответ...').fill('[llm:correct] Потому что это может быть мошеннический сайт.');
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.getByText(/Правильно|Частично|Неправильно/)).toBeVisible();
    await page.getByRole('button', { name: /Далее|Завершить|Продолжить/ }).click();

    await expect(
      page.getByText(/Миссия завершена|Предпросмотр этапа завершён|Конец этапа/i),
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Вернуться в редактор' }).click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
    await page.reload();

    await expect(page.getByPlaceholder('Название этапа...')).toHaveValue('Этап с предпросмотром v2');
    await expect(page.getByLabel('Текст истории')).toHaveValue('История о безопасном выборе.');
    await expect(page.getByLabel('Эталонный ответ')).toHaveValue(
      'Потому что ссылка может вести на мошеннический сайт.',
    );

    await teacherContext.close();
  });
});
