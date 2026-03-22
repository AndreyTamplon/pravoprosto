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

    await expect(page.getByLabel('Текст истории').first()).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Текст истории').first().fill('История о безопасном выборе.');
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

    await expect(page.getByText('Миссия завершена!')).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);
    await page.reload();

    await expect(page.getByPlaceholder('Название этапа...')).toHaveValue('Этап с предпросмотром v2');
    await expect(page.getByLabel('Текст истории')).toHaveValue('История о безопасном выборе.');
    await expect(page.getByLabel('Эталонный ответ')).toHaveValue(
      'Потому что ссылка может вести на мошеннический сайт.',
    );

    await teacherContext.close();
  });

  test('admin lesson editor saves valid single-choice graph, preview reaches 100%, and return path works from popup', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const page = await adminContext.newPage();
    const courseTitle = `QA Admin Lesson ${Date.now()}`;

    await page.goto('/admin/courses');
    await page.getByRole('button', { name: /Создать курс/i }).click();
    const createDialog = page.getByRole('dialog', { name: 'Создать курс' });
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel('Название').fill(courseTitle);
    await createDialog.getByLabel('Описание').fill('Курс для проверки admin lesson editor');
    await createDialog.getByRole('button', { name: 'Создать', exact: true }).click();

    await page.waitForURL(/\/admin\/courses\/[^/]+$/);
    await page.getByRole('button', { name: /\+ Модуль/i }).click();
    const moduleDialog = page.getByRole('dialog', { name: 'Новый модуль' });
    await moduleDialog.getByLabel('Название модуля').fill('Модуль админки');
    await moduleDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: /\+ Урок/i }).click();
    const lessonDialog = page.getByRole('dialog', { name: 'Новый урок' });
    await lessonDialog.getByLabel('Название урока').fill('Первый урок');
    await lessonDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: 'Редактировать' }).click();
    await page.waitForURL(/\/admin\/courses\/.+\/lessons\/.+/);

    await page.getByLabel('Название урока').fill('Первый урок v2');
    await page.getByRole('button', { name: /История/ }).click();
    await page.getByRole('button', { name: /Выбор ответа/ }).click();
    await page.getByRole('button', { name: /Конец/ }).click();

    const storyText = page.getByLabel('Текст').first();
    await storyText.fill('Это история для проверки admin preview.');

    await page.getByLabel('Вопрос').fill('Можно ли совать пальцы в розетку?');
    const optionInputs = page.getByPlaceholder('Вариант ответа');
    await optionInputs.nth(0).fill('Нет');
    await optionInputs.nth(1).fill('Да');
    await page.locator('button[title="Отметить правильный вариант"]').first().click();
    await page.getByLabel('Обратная связь (правильно)').fill('Верно, так делать нельзя.');
    await page.getByLabel('Обратная связь (неправильно)').fill('Нет, это опасно.');

    const saveRequest = page.waitForRequest((request) =>
      request.method() === 'PUT' && request.url().includes('/draft'),
    );
    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page.getByRole('button', { name: 'Сохранить' }).click();
    const saveBody = (await saveRequest).postDataJSON() as Record<string, unknown>;
    expect((await saveResponse).ok()).toBeTruthy();

    const content = (saveBody.content ?? saveBody.content_json) as Record<string, unknown>;
    const modules = (content.modules as Array<Record<string, unknown>>) ?? [];
    const lesson = ((modules[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
    const singleChoiceNode = nodes.find(node => node.kind === 'single_choice');
    expect(singleChoiceNode).toBeTruthy();
    const options = ((singleChoiceNode?.options as Array<Record<string, unknown>>) ?? []);
    expect(options).toHaveLength(2);
    expect(options[0].id).toBeTruthy();
    expect(options[0].feedback).toBeTruthy();
    expect(options[0].result).toBeTruthy();
    expect(options[0].nextNodeId).toBeTruthy();

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Превью' }).click();
    const previewPage = await popupPromise;
    await previewPage.waitForURL(/\/admin\/preview\/.+/);
    await previewPage.reload();
    await expect(previewPage.getByText('Это история для проверки admin preview.')).toBeVisible({ timeout: 10000 });
    await previewPage.getByRole('button', { name: 'Далее' }).click();
    await expect(previewPage.getByText('Можно ли совать пальцы в розетку?')).toBeVisible();
    await previewPage.getByRole('button', { name: 'Нет' }).click();
    await previewPage.getByRole('button', { name: 'Ответить' }).click();
    await expect(previewPage.getByText('Правильно!')).toBeVisible({ timeout: 10000 });
    await previewPage.getByRole('button', { name: 'Далее' }).click();
    await expect(previewPage.getByText('Миссия завершена!')).toBeVisible({ timeout: 10000 });
    await expect(previewPage.getByText('100%')).toBeVisible();
    await previewPage.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await previewPage.waitForURL(/\/admin\/courses\/.+\/lessons\/.+/);
    await expect(previewPage.getByLabel('Название урока')).toHaveValue('Первый урок v2');
    await previewPage.close();

    await adminContext.close();
  });

  test('admin lesson editor shows specific Russian validation errors instead of raw backend messages', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const page = await adminContext.newPage();
    const courseTitle = `QA Admin Validation ${Date.now()}`;

    await page.goto('/admin/courses');
    await page.getByRole('button', { name: /Создать курс/i }).click();
    const createDialog = page.getByRole('dialog', { name: 'Создать курс' });
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel('Название').fill(courseTitle);
    await createDialog.getByLabel('Описание').fill('Курс для проверки сообщений об ошибках');
    await createDialog.getByRole('button', { name: 'Создать', exact: true }).click();

    await page.waitForURL(/\/admin\/courses\/[^/]+$/);
    await page.getByRole('button', { name: /\+ Модуль/i }).click();
    const moduleDialog = page.getByRole('dialog', { name: 'Новый модуль' });
    await moduleDialog.getByLabel('Название модуля').fill('Модуль ошибок');
    await moduleDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: /\+ Урок/i }).click();
    const lessonDialog = page.getByRole('dialog', { name: 'Новый урок' });
    await lessonDialog.getByLabel('Название урока').fill('Урок ошибок');
    await lessonDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: 'Редактировать' }).click();
    await page.waitForURL(/\/admin\/courses\/.+\/lessons\/.+/);

    await page.getByRole('button', { name: /История/ }).click();
    await page.getByRole('button', { name: /Выбор ответа/ }).click();
    await page.getByRole('button', { name: /Конец/ }).click();

    await page.getByLabel('Текст').first().fill('Проверка сообщений об ошибках.');
    await page.getByLabel('Вопрос').fill('Можно ли открывать дверь незнакомцам?');

    const optionInputs = page.getByPlaceholder('Вариант ответа');
    await optionInputs.nth(0).fill('Нет');
    await optionInputs.nth(1).fill('Да');

    await page.getByLabel('Обратная связь (правильно)').fill('');
    await page.getByLabel('Обратная связь (неправильно)').fill('');

    const saveResponse = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/draft'),
    );
    await page.getByRole('button', { name: 'Сохранить' }).click();
    expect((await saveResponse).status()).toBe(422);

    await expect(page.getByText('Что нужно исправить:')).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText('У каждого варианта ответа должны быть заполнены результат, обратная связь и переход к следующему блоку.'),
    ).toBeVisible();
    await expect(page.getByText(/Draft contains validation errors|Invalid JSON body/i)).not.toBeVisible();
    await expect(
      page.getByText('У каждого варианта ответа должны быть заполнены результат, обратная связь и переход к следующему блоку.'),
    ).toHaveCount(1);

    await adminContext.close();
  });
});
