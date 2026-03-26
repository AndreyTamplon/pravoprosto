import { test, expect } from '@playwright/test';
import {
  buildDecisionBranchingLesson,
  buildSimpleStoryLesson,
  createAdminCourseWithDraft,
  createTeacherCourseWithDraft,
} from '../../helpers/course-builders';

test.describe('QA Regression -- Lesson editor roundtrip for new branching model', () => {
  test('teacher editor preserves multi-verdict choice and free-text rubric across save, reload, and preview', async ({ browser }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const setupPage = await teacherContext.newPage();
    const lessonId = `teacher_new_roundtrip_${Date.now()}`;

    const { courseId } = await createTeacherCourseWithDraft(setupPage, {
      title: `Teacher New Roundtrip ${Date.now()}`,
      description: 'Проверка нового editor roundtrip в teacher editor',
      modules: [
        {
          id: 'module_teacher_roundtrip_new',
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

    await page.getByPlaceholder('Название этапа...').fill('Урок ветвления v3');
    await page.getByLabel('Текст истории').first().fill('История перед вопросом.');
    await page.getByRole('button', { name: /\+ Выбор ответа/i }).click();
    await page.getByRole('button', { name: /\+ Свободный ответ/i }).click();
    await page.getByRole('button', { name: /\+ Блок истории/i }).click();

    const questionFields = page.getByLabel('Текст вопроса');
    await questionFields.nth(0).fill('Какой шаг безопаснее?');
    await questionFields.nth(1).fill('Почему важно проверять магазин заранее?');

    const optionInputs = page.getByPlaceholder('Вариант ответа...');
    await optionInputs.nth(0).fill('Проверить отзывы');
    await optionInputs.nth(1).fill('Сравнить цену на других сайтах');
    await page.getByRole('button', { name: '+ Вариант' }).click();
    await page.getByRole('button', { name: '+ Вариант' }).click();
    await page.getByPlaceholder('Вариант ответа...').nth(2).fill('Посмотреть только красивый дизайн');
    await page.getByPlaceholder('Вариант ответа...').nth(3).fill('Сразу оплатить заказ');

    const verdictSelectors = page.getByLabel('Оценка варианта');
    await verdictSelectors.nth(0).selectOption('correct');
    await verdictSelectors.nth(1).selectOption('correct');
    await verdictSelectors.nth(2).selectOption('partial');
    await verdictSelectors.nth(3).selectOption('incorrect');

    const optionFeedbacks = page.getByLabel('Обратная связь для этого варианта');
    await optionFeedbacks.nth(0).fill('Верно: это полноценная проверка.');
    await optionFeedbacks.nth(1).fill('Тоже хороший безопасный шаг.');
    await optionFeedbacks.nth(2).fill('Неплохо, но этого пока недостаточно.');
    await optionFeedbacks.nth(3).fill('Это опасный импульсивный шаг.');

    const optionTargets = page.getByLabel('Переход после этого ответа');
    await optionTargets.nth(0).selectOption({ label: '#4 Блок истории' });
    await optionTargets.nth(1).selectOption({ label: '#4 Блок истории' });
    await optionTargets.nth(2).selectOption({ label: '#3 Свободный ответ' });
    await optionTargets.nth(3).selectOption({ label: '#4 Блок истории' });

    await page.getByLabel('Эталонный ответ').fill('Проверка помогает заметить мошенников.');
    await page.getByLabel('Критерии правильного ответа').fill('Нужно упомянуть риск мошенничества и проверку магазина.');
    await page.getByLabel('Критерии частично верного ответа').fill('Есть идея о проверке, но нет полного объяснения риска.');
    await page.getByLabel('Критерии неверного ответа').fill('Ответ не объясняет, зачем вообще проверять магазин.');
    await page.getByLabel('Обратная связь при правильном ответе').fill('Отлично, ты назвал ключевой риск.');
    await page.getByLabel('Обратная связь при частично верном ответе').fill('Ход мысли хороший, но ответ пока неполный.');
    await page.getByLabel('Обратная связь при неправильном ответе').fill('Ответ пока не объясняет главную опасность.');

    await page.getByLabel('Следующий блок при правильном ответе').selectOption({ label: '#4 Блок истории' });
    await page.getByLabel('Следующий блок при частично верном ответе').selectOption({ label: '#5 Завершение' });
    await page.getByLabel('Следующий блок при неправильном ответе').selectOption({ label: '#5 Завершение' });

    await page.getByLabel('Текст истории').nth(1).fill('Финальная ветка после проверок.');
    await page.getByLabel('Следующий блок').nth(1).selectOption({ label: '#5 Завершение' });

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
    expect(options.filter(option => option.result === 'correct')).toHaveLength(2);
    expect(options.find(option => option.result === 'partial')?.feedback).toBe('Неплохо, но этого пока недостаточно.');

    const freeTextNode = nodes.find(node => node.kind === 'free_text');
    expect(freeTextNode).toBeTruthy();
    const rubric = (freeTextNode?.rubric as Record<string, unknown>) ?? {};
    expect((rubric.criteriaByVerdict as Record<string, unknown>).correct).toBe('Нужно упомянуть риск мошенничества и проверку магазина.');
    expect((rubric.feedbackByVerdict as Record<string, unknown>).partial).toBe('Ход мысли хороший, но ответ пока неполный.');

    await page.reload();
    await expect(page.getByPlaceholder('Название этапа...')).toHaveValue('Урок ветвления v3');
    await expect(page.getByLabel('Критерии правильного ответа')).toHaveValue('Нужно упомянуть риск мошенничества и проверку магазина.');
    await expect(page.getByLabel('Обратная связь при частично верном ответе')).toHaveValue('Ход мысли хороший, но ответ пока неполный.');

    await page.getByRole('button', { name: 'Предпросмотр' }).click();
    await page.waitForURL(/\/teacher\/preview\/.+/);
    await page.getByRole('button', { name: 'Далее' }).click();
    await page.getByRole('button', { name: 'Посмотреть только красивый дизайн', exact: true }).click();
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'partial');
    await expect(page.locator('[data-role="feedback"]')).toContainText('Неплохо, но этого пока недостаточно.');
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible();
    await page.getByPlaceholder('Введите ваш ответ...').fill('[llm:correct] Проверка помогает заметить мошенников.');
    await page.getByRole('button', { name: 'Ответить' }).click();
    await expect(page.locator('[data-role="feedback"]')).toHaveAttribute('data-verdict', 'correct');
    await expect(page.locator('[data-role="feedback"]')).toContainText('Отлично, ты назвал ключевой риск.');

    await teacherContext.close();
  });

  test('admin editor preserves decision branching after node reorder and preview backtracking works', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const setupPage = await adminContext.newPage();
    const lessonId = `admin_decision_roundtrip_${Date.now()}`;

    const { courseId } = await createAdminCourseWithDraft(setupPage, {
      title: `Admin Decision Roundtrip ${Date.now()}`,
      description: 'Проверка decision branch roundtrip в admin editor',
      ageMin: 8,
      ageMax: 12,
      modules: [
        {
          id: 'module_admin_decision_roundtrip',
          title: 'Модуль ветвления',
          lessons: [
            buildDecisionBranchingLesson({
              lessonId,
              title: 'Урок с развилкой',
              introText: 'Перед тобой выбор.',
              decisionText: 'Что выберешь?',
              branchAText: 'Ветка A',
              branchBText: 'Ветка B',
            }),
          ],
        },
      ],
    });

    const page = await adminContext.newPage();
    await page.goto(`/admin/courses/${courseId}/lessons/${lessonId}`);
    await expect(page.getByLabel('Название урока')).toBeVisible({ timeout: 10000 });

    await page.getByLabel('Название урока').fill('Admin decision lesson v2');

    const downButtons = page.getByRole('button', { name: '↓' });
    await downButtons.nth(2).click();

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
    const decisionNode = nodes.find(node => node.kind === 'decision');
    expect(decisionNode).toBeTruthy();
    const options = ((decisionNode?.options as Array<Record<string, unknown>>) ?? []);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.nextNodeId).toBeTruthy();
    }

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Превью' }).click();
    const previewPage = await popupPromise;
    await previewPage.waitForURL(/\/admin\/preview\/.+/);
    await previewPage.getByRole('button', { name: 'Далее' }).click();
    await expect(previewPage.locator('[data-node-kind="decision"]')).toBeVisible({ timeout: 10000 });
    await previewPage.getByRole('button', { name: 'Сначала проверить факты', exact: true }).click();
    await previewPage.getByRole('button', { name: 'Выбрать' }).click();
    await expect(previewPage.locator('[data-role="prompt"]')).toContainText('Ветка A');
    await previewPage.getByRole('button', { name: 'Назад к выбору' }).click();
    await expect(previewPage.locator('[data-node-kind="decision"]')).toBeVisible({ timeout: 10000 });
    await previewPage.getByRole('button', { name: 'Сразу принять решение', exact: true }).click();
    await previewPage.getByRole('button', { name: 'Выбрать' }).click();
    await expect(previewPage.locator('[data-role="prompt"]')).toContainText('Ветка B');
    await previewPage.close();

    await adminContext.close();
  });
});
