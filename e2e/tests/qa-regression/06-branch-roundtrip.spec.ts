import { test, expect } from '@playwright/test';
import {
  buildSimpleStoryLesson,
  createAdminCourseWithDraft,
  createTeacherCourseWithDraft,
} from '../../helpers/course-builders';

function buildDuplicateOptionIdLesson(lessonId: string) {
  const q1Id = `${lessonId}_q1`;
  const q2Id = `${lessonId}_q2`;
  const q2StoryA = `${lessonId}_q2_story_a`;
  const q2StoryB = `${lessonId}_q2_story_b`;
  const q2StoryC = `${lessonId}_q2_story_c`;
  const endId = `${lessonId}_end`;

  return {
    id: lessonId,
    title: 'Урок с повторяющимися option id',
    graph: {
      startNodeId: q1Id,
      nodes: [
        {
          id: q1Id,
          kind: 'single_choice',
          prompt: 'Вопрос 1 с общим option id',
          options: [
            { id: 'shared_a1', text: 'Q1 вариант 1', result: 'correct', feedback: 'Q1 A1', nextNodeId: q2Id },
            { id: 'shared_a2', text: 'Q1 вариант 2', result: 'incorrect', feedback: 'Q1 A2', nextNodeId: q2Id },
            { id: 'shared_a3', text: 'Q1 вариант 3', result: 'incorrect', feedback: 'Q1 A3', nextNodeId: q2Id },
          ],
        },
        {
          id: q2Id,
          kind: 'single_choice',
          prompt: 'Вопрос 2 с общим option id',
          options: [
            { id: 'shared_a1', text: 'Q2 вариант 1', result: 'correct', feedback: 'Q2 A1', nextNodeId: q2StoryC },
            { id: 'shared_a2', text: 'Q2 вариант 2', result: 'incorrect', feedback: 'Q2 A2', nextNodeId: q2StoryA },
            { id: 'shared_a3', text: 'Q2 вариант 3', result: 'incorrect', feedback: 'Q2 A3', nextNodeId: q2StoryB },
          ],
        },
        { id: q2StoryA, kind: 'story', body: { text: 'Q2 ветка 1' }, nextNodeId: endId },
        { id: q2StoryB, kind: 'story', body: { text: 'Q2 ветка 2' }, nextNodeId: endId },
        { id: q2StoryC, kind: 'story', body: { text: 'Q2 ветка 3' }, nextNodeId: endId },
        { id: endId, kind: 'end', text: 'Финал урока' },
      ],
    },
  };
}

test.describe('QA Regression -- Branch roundtrip in lesson editors', () => {
  test('teacher lesson editor preserves single-choice and free-text branches across save, reload, and preview', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const setupPage = await teacherContext.newPage();
    const lessonId = `teacher_branch_roundtrip_${Date.now()}`;

    const { courseId } = await createTeacherCourseWithDraft(setupPage, {
      title: `Teacher Branch Roundtrip ${Date.now()}`,
      description: 'Проверка branch roundtrip в teacher editor',
      modules: [
        {
          id: 'module_teacher_branch_roundtrip',
          title: 'Модуль ветвления',
          lessons: [
            buildSimpleStoryLesson({
              lessonId,
              title: 'Урок ветвления',
              storyText: 'Стартовый текст',
            }),
          ],
        },
      ],
    });

    const page = await teacherContext.newPage();
    await page.goto(`/teacher/courses/${courseId}/lessons/${lessonId}`);
    await expect(page.getByPlaceholder('Название этапа...')).toBeVisible({ timeout: 10000 });

    await page.getByPlaceholder('Название этапа...').fill('Урок ветвления v2');
    await page.getByLabel('Текст истории').first().fill('История перед выбором ветки.');
    await page.getByRole('button', { name: /\+ Выбор ответа/i }).click();
    await page.getByRole('button', { name: /\+ Блок истории/i }).click();
    await page.getByRole('button', { name: /\+ Свободный ответ/i }).click();
    await page.getByRole('button', { name: /\+ Блок истории/i }).click();

    const storyFields = page.getByLabel('Текст истории');
    await storyFields.nth(1).fill('Ветка после неправильного ответа.');
    await storyFields.nth(2).fill('Ветка после правильного free-text ответа.');

    const questionFields = page.getByLabel('Текст вопроса');
    await questionFields.nth(0).fill('Какой шаг безопаснее?');
    await questionFields.nth(1).fill('Почему нужно проверять магазин заранее?');

    const optionInputs = page.getByPlaceholder('Вариант ответа...');
    await optionInputs.nth(0).fill('Проверить отзывы и контакты');
    await optionInputs.nth(1).fill('Сразу перейти к оплате');

    await page.getByLabel('Обратная связь (правильно)').fill('Да, сначала нужно проверить магазин.');
    await page.getByLabel('Обратная связь (неправильно)').fill('Нет, это ведёт в отдельную ветку.');

    await page.getByLabel('Эталонный ответ').fill('Проверка помогает заметить мошенников.');
    await page.getByLabel('Критерии оценивания').fill('Ответ должен упомянуть риск мошенничества или поддельного магазина.');
    await page.getByRole('textbox', { name: 'Обратная связь', exact: true }).fill('Спасибо, теперь видно, что ты понимаешь риск.');

    await page.getByLabel('Переход после этого ответа').nth(0).selectOption({ index: 2 });
    await page.getByLabel('Переход после этого ответа').nth(1).selectOption({ index: 1 });
    await page.getByLabel('Следующий блок').nth(1).selectOption({ index: 3 });
    await page.getByLabel('Следующий блок при правильном ответе').selectOption({ index: 1 });
    await page.getByLabel('Следующий блок при частично верном ответе').selectOption({ index: 2 });
    await page.getByLabel('Следующий блок при неправильном ответе').selectOption({ index: 2 });

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
    const lesson = ((((content.modules as Array<Record<string, unknown>>) ?? [])[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
    const singleChoiceNode = nodes.find(node => node.kind === 'single_choice');
    expect(singleChoiceNode).toBeTruthy();
    const options = ((singleChoiceNode?.options as Array<Record<string, unknown>>) ?? []);
    expect(options).toHaveLength(2);
    expect(options[0].nextNodeId).not.toBe(options[1].nextNodeId);

    const freeTextNode = nodes.find(node => node.kind === 'free_text');
    expect(freeTextNode).toBeTruthy();
    const transitions = ((freeTextNode?.transitions as Array<Record<string, unknown>>) ?? []);
    expect(transitions).toHaveLength(3);
    expect(transitions.find(item => item.onVerdict === 'correct')?.nextNodeId).not.toBe(
      transitions.find(item => item.onVerdict === 'partial')?.nextNodeId,
    );

    await page.reload();
    await expect(page.getByPlaceholder('Название этапа...')).toHaveValue('Урок ветвления v2');
    await expect(page.getByLabel('Текст истории').nth(1)).toHaveValue('Ветка после неправильного ответа.');
    await expect(page.getByLabel('Эталонный ответ')).toHaveValue('Проверка помогает заметить мошенников.');

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    await page.waitForURL(/\/teacher\/preview\/.+/);
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByRole('button', { name: 'Сразу перейти к оплате' }).click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'incorrect');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-role="prompt"]')).toContainText('Ветка после неправильного ответа.');
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByRole('button', { name: 'Завершить предпросмотр' }).click();
    await page.getByRole('button', { name: 'Вернуться в редактор' }).first().click();
    await page.waitForURL(`/teacher/courses/${courseId}/lessons/${lessonId}`);

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    await page.waitForURL(/\/teacher\/preview\/.+/);
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByRole('button', { name: 'Проверить отзывы и контакты' }).click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'correct');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible();
    await page.getByPlaceholder('Введите ваш ответ...').fill('[llm:correct] Проверка помогает заметить мошенников.');
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'correct');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-role="prompt"]')).toContainText('Ветка после правильного free-text ответа.');

    await teacherContext.close();
  });

  test('admin lesson editor preserves branching payload and preview follows the configured branch', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const setupPage = await adminContext.newPage();
    const lessonId = `admin_branch_roundtrip_${Date.now()}`;

    const { courseId } = await createAdminCourseWithDraft(setupPage, {
      title: `Admin Branch Roundtrip ${Date.now()}`,
      description: 'Проверка branch roundtrip в admin editor',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_admin_branch_roundtrip',
          title: 'Модуль ветвления',
          lessons: [
            buildSimpleStoryLesson({
              lessonId,
              title: 'Урок ветвления',
              storyText: 'Стартовый текст админского урока',
            }),
          ],
        },
      ],
    });

    const page = await adminContext.newPage();
    await page.goto(`/admin/courses/${courseId}/lessons/${lessonId}`);
    await expect(page.getByLabel('Название урока')).toBeVisible({ timeout: 10000 });

    await page.getByLabel('Название урока').fill('Admin lesson v2');
    await page.getByLabel('Текст').first().fill('История перед выбором в admin preview.');
    await page.getByRole('button', { name: /Выбор ответа/ }).click();
    await page.getByRole('button', { name: /История/ }).click();

    await page.getByLabel('Вопрос').fill('Какой шаг безопаснее в админском редакторе?');
    const optionInputs = page.getByPlaceholder('Вариант ответа');
    await optionInputs.nth(0).fill('Сначала проверю магазин');
    await optionInputs.nth(1).fill('Сразу отправлю деньги');
    await page.getByLabel('Обратная связь (правильно)').fill('Да, проверка магазина ведёт по правильной ветке.');
    await page.getByLabel('Обратная связь (неправильно)').fill('Нет, это должно вести в короткую ветку завершения.');
    await page.getByLabel('Текст').nth(1).fill('Правильная ветка из admin preview.');

    await page.getByLabel('Переход после этого ответа').nth(0).selectOption({ index: 1 });
    await page.getByLabel('Переход после этого ответа').nth(1).selectOption({ index: 2 });

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
    const lesson = ((((content.modules as Array<Record<string, unknown>>) ?? [])[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
    const singleChoiceNode = nodes.find(node => node.kind === 'single_choice');
    expect(singleChoiceNode).toBeTruthy();
    const options = ((singleChoiceNode?.options as Array<Record<string, unknown>>) ?? []);
    expect(options[0].nextNodeId).not.toBe(options[1].nextNodeId);

    await page.reload();
    await expect(page.getByLabel('Название урока')).toHaveValue('Admin lesson v2');
    await expect(page.getByLabel('Текст').nth(1)).toHaveValue('Правильная ветка из admin preview.');

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Превью' }).click();
    const previewPage = await popupPromise;
    await previewPage.waitForURL(/\/admin\/preview\/.+/);
    await previewPage.getByRole('button', { name: 'Далее' }).click();
    await previewPage.getByRole('button', { name: 'Сначала проверю магазин' }).click();
    await previewPage.getByRole('button', { name: 'Ответить' }).click();
    await expect(previewPage.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'correct');
    await previewPage.getByRole('button', { name: 'Далее' }).click();
    await expect(previewPage.locator('[data-role="prompt"]')).toContainText('Правильная ветка из admin preview.');
    await previewPage.close();

    await adminContext.close();
  });

  test('teacher editor removes only the selected option edge when multiple questions reuse option ids', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const setupPage = await teacherContext.newPage();
    const lessonId = `teacher_shared_option_ids_${Date.now()}`;

    const { courseId } = await createTeacherCourseWithDraft(setupPage, {
      title: `Teacher Shared Option IDs ${Date.now()}`,
      description: 'Проверка scoped удаления option edges',
      modules: [
        {
          id: 'module_teacher_shared_option_ids',
          title: 'Scoped option removal',
          lessons: [buildDuplicateOptionIdLesson(lessonId)],
        },
      ],
    });

    const page = await teacherContext.newPage();
    await page.goto(`/teacher/courses/${courseId}/lessons/${lessonId}`);
    await expect(page.getByPlaceholder('Название этапа...')).toBeVisible({ timeout: 10000 });

    await page
      .locator('div:has(> input[value="Q1 вариант 1"])')
      .getByRole('button', { name: 'Удалить вариант' })
      .click();

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
    const lesson = ((((content.modules as Array<Record<string, unknown>>) ?? [])[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
    const firstQuestion = nodes.find(node => node.prompt === 'Вопрос 1 с общим option id');
    const secondQuestion = nodes.find(node => node.prompt === 'Вопрос 2 с общим option id');

    expect(firstQuestion).toBeTruthy();
    expect(secondQuestion).toBeTruthy();

    const firstQuestionOptions = ((firstQuestion?.options as Array<Record<string, unknown>>) ?? []);
    const secondQuestionOptions = ((secondQuestion?.options as Array<Record<string, unknown>>) ?? []);

    expect(firstQuestionOptions.find(option => option.id === 'shared_a1')).toBeUndefined();
    expect(secondQuestionOptions.find(option => option.id === 'shared_a1')?.nextNodeId).toBe(`${lessonId}_q2_story_c`);

    await teacherContext.close();
  });

  test('admin editor removes only the selected option edge when multiple questions reuse option ids', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const setupPage = await adminContext.newPage();
    const lessonId = `admin_shared_option_ids_${Date.now()}`;

    const { courseId } = await createAdminCourseWithDraft(setupPage, {
      title: `Admin Shared Option IDs ${Date.now()}`,
      description: 'Проверка scoped удаления option edges в admin editor',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_admin_shared_option_ids',
          title: 'Scoped option removal',
          lessons: [buildDuplicateOptionIdLesson(lessonId)],
        },
      ],
    });

    const page = await adminContext.newPage();
    await page.goto(`/admin/courses/${courseId}/lessons/${lessonId}`);
    await expect(page.getByLabel('Название урока')).toBeVisible({ timeout: 10000 });

    await page
      .locator('div:has(> input[value="Q1 вариант 1"])')
      .getByRole('button', { name: 'Удалить вариант' })
      .click();

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
    const lesson = ((((content.modules as Array<Record<string, unknown>>) ?? [])[0]?.lessons as Array<Record<string, unknown>>) ?? [])[0];
    const graph = lesson.graph as Record<string, unknown>;
    const nodes = (graph.nodes as Array<Record<string, unknown>>) ?? [];
    const firstQuestion = nodes.find(node => node.prompt === 'Вопрос 1 с общим option id');
    const secondQuestion = nodes.find(node => node.prompt === 'Вопрос 2 с общим option id');

    expect(firstQuestion).toBeTruthy();
    expect(secondQuestion).toBeTruthy();

    const firstQuestionOptions = ((firstQuestion?.options as Array<Record<string, unknown>>) ?? []);
    const secondQuestionOptions = ((secondQuestion?.options as Array<Record<string, unknown>>) ?? []);

    expect(firstQuestionOptions.find(option => option.id === 'shared_a1')).toBeUndefined();
    expect(secondQuestionOptions.find(option => option.id === 'shared_a1')?.nextNodeId).toBe(`${lessonId}_q2_story_c`);

    await adminContext.close();
  });
});
