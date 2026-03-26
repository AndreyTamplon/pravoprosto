import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from '@playwright/test';
import { createFreshStudentPage, openLessonAttempt, openPasswordsFreeTextStep } from '../../helpers/student-lessons';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  buildBranchingFreeTextLesson,
  createAdminCourseWithDraft,
  publishAdminCourse,
} from '../../helpers/course-builders';
import { apiRequest } from '../../helpers/browser-api';

/**
 * Real-LLM E2E tests.
 *
 * These tests send actual student answers to a real LLM provider (no [llm:] markers).
 * The LLM evaluates answers and returns verdict + feedback.
 *
 * Timeout is high (120s per test) because real LLM calls can take 30-60s.
 */

test.describe('Real LLM — free-text evaluation', () => {

  test('correct answer gets non-incorrect verdict and shows feedback', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `real_llm_correct_${Date.now()}`;
    const lesson = buildBranchingFreeTextLesson({
      lessonId,
      title: 'Реальный LLM — correct',
      introText: 'Ответь на вопрос про безопасность паролей.',
      questionText: 'Почему опасно использовать один и тот же пароль на всех сайтах?',
      referenceAnswer: 'Если злоумышленники взломают один сайт и узнают пароль, они получат доступ ко всем остальным аккаунтам пользователя с этим же паролем.',
      criteria: 'placeholder',
      correctText: 'Ты попал на правильную ветку — отлично!',
      partialText: 'Ты попал на частичную ветку.',
      incorrectText: 'Ты попал на неправильную ветку.',
    });
    // Override criteriaByVerdict with DISTINCT per-verdict criteria (helper uses same for all 3)
    const freeTextNode = lesson.graph.nodes.find((n: Record<string, unknown>) => n.kind === 'free_text') as Record<string, unknown>;
    (freeTextNode.rubric as Record<string, unknown>).criteriaByVerdict = {
      correct: 'Ученик объясняет, что взлом одного аккаунта даёт доступ ко всем остальным, где используется тот же пароль.',
      partial: 'Ученик упоминает, что это опасно, но не раскрывает конкретный механизм цепной компрометации.',
      incorrect: 'Ответ полностью не по теме, бессмысленный, или не содержит попытки ответить на вопрос.',
    };

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Real LLM Correct ${Date.now()}`,
      description: 'Тест реального LLM — correct verdict',
      ageMin: 8,
      ageMax: 14,
      modules: [{ id: 'mod_real_llm', title: 'LLM модуль', lessons: [lesson] }],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context, page } = await createFreshStudentPage(browser, 'real-llm-correct');
    await expect
      .poll(async () => {
        const r = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, { fallbackPath: '/student/courses' });
        return r.status;
      }, { timeout: 15000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible({ timeout: 10000 });

    // Real correct answer — no markers
    await page.getByPlaceholder('Напиши свой ответ...').fill(
      'Если злоумышленники взломают один сайт и получат твой пароль, то они смогут войти во все твои аккаунты, где ты использовал этот же пароль. Поэтому для каждого сайта нужен уникальный пароль.',
    );
    await page.getByRole('button', { name: 'Проверить' }).click();

    // Wait for LLM response — either feedback or error banner
    const feedback = page.locator('[data-role="feedback"]');
    const errorBanner = page.getByText('временно недоступна');
    await expect(feedback.or(errorBanner)).toBeVisible({ timeout: 90000 });

    if (await errorBanner.isVisible()) {
      console.log('LLM temporarily unavailable — skipping verdict check');
      await context.close();
      return;
    }

    const verdict = await feedback.getAttribute('data-verdict');
    console.log(`LLM verdict: ${verdict}`);
    console.log(`Feedback text: ${await feedback.textContent()}`);

    // Good answer should NOT be "incorrect" (LLMs vary — accept correct or partial)
    expect(['correct', 'partial']).toContain(verdict);

    // Verify feedback UI rendered properly (verdict-specific burst + Далее button)
    const hasBurst =
      (await feedback.textContent())?.includes('ВЕРНО!') ||
      (await feedback.textContent())?.includes('ПОЧТИ!');
    expect(hasBurst).toBe(true);
    await expect(page.getByRole('button', { name: 'Далее' })).toBeVisible();

    await context.close();
  });

  test('incorrect answer gets "incorrect" verdict', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `real_llm_incorrect_${Date.now()}`;
    const lesson = buildBranchingFreeTextLesson({
      lessonId,
      title: 'Реальный LLM — incorrect',
      introText: 'Ответь на вопрос.',
      questionText: 'Почему опасно использовать один и тот же пароль на всех сайтах?',
      referenceAnswer: 'Если злоумышленники взломают один сайт и узнают пароль, они получат доступ ко всем остальным аккаунтам пользователя.',
      criteria: 'Ученик должен объяснить, что компрометация одного пароля ставит под угрозу все аккаунты.',
      correctText: 'Верная ветка.',
      partialText: 'Частичная ветка.',
      incorrectText: 'Неверная ветка — ответ не по теме.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Real LLM Incorrect ${Date.now()}`,
      description: 'Тест реального LLM — incorrect verdict',
      ageMin: 8,
      ageMax: 14,
      modules: [{ id: 'mod_real_llm_inc', title: 'LLM модуль', lessons: [lesson] }],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context, page } = await createFreshStudentPage(browser, 'real-llm-incorrect');
    await expect
      .poll(async () => {
        const r = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, { fallbackPath: '/student/courses' });
        return r.status;
      }, { timeout: 15000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible({ timeout: 10000 });

    // Completely off-topic answer
    await page.getByPlaceholder('Напиши свой ответ...').fill(
      'Я люблю играть в футбол и есть мороженое.',
    );
    await page.getByRole('button', { name: 'Проверить' }).click();

    const feedback = page.locator('[data-role="feedback"]');
    await expect(feedback).toBeVisible({ timeout: 90000 });

    const verdict = await feedback.getAttribute('data-verdict');
    console.log(`LLM verdict: ${verdict}`);
    console.log(`Feedback text: ${await feedback.textContent()}`);

    expect(verdict).toBe('incorrect');
    await expect(feedback).toContainText('ПРОМАХ!');

    await context.close();
  });

  test('vague answer gets non-correct verdict or LLM handles gracefully', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `real_llm_partial_${Date.now()}`;
    const lesson = buildBranchingFreeTextLesson({
      lessonId,
      title: 'Реальный LLM — partial',
      introText: 'Ответь на вопрос.',
      questionText: 'Почему опасно использовать один и тот же пароль на всех сайтах?',
      referenceAnswer: 'Если злоумышленники взломают один сайт и узнают пароль, они получат доступ ко всем остальным аккаунтам пользователя.',
      criteria: 'correct = ученик объясняет цепную компрометацию аккаунтов. partial = упоминает опасность, но не раскрывает механизм. incorrect = ответ полностью не по теме.',
      correctText: 'Верная ветка.',
      partialText: 'Частичная ветка — ты уловил суть, но не объяснил полностью.',
      incorrectText: 'Неверная ветка.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Real LLM Partial ${Date.now()}`,
      description: 'Тест реального LLM — partial verdict',
      ageMin: 8,
      ageMax: 14,
      modules: [{ id: 'mod_real_llm_part', title: 'LLM модуль', lessons: [lesson] }],
    });
    await publishAdminCourse(adminPage, courseId);
    await adminContext.close();

    const { context, page } = await createFreshStudentPage(browser, 'real-llm-partial');
    await expect
      .poll(async () => {
        const r = await apiRequest(page, 'GET', `/student/courses/${courseId}`, undefined, { fallbackPath: '/student/courses' });
        return r.status;
      }, { timeout: 15000 })
      .toBe(200);

    await openLessonAttempt(page, courseId, lessonId);
    await page.getByRole('button', { name: 'Далее' }).click();
    await expect(page.locator('[data-node-kind="free_text"]')).toBeVisible({ timeout: 10000 });

    // Vague answer — correct direction but not enough detail
    await page.getByPlaceholder('Напиши свой ответ...').fill(
      'Потому что это небезопасно, кто-то может узнать пароль.',
    );
    await page.getByRole('button', { name: 'Проверить' }).click();

    // Wait for feedback OR error banner (LLM may timeout)
    const feedback = page.locator('[data-role="feedback"]');
    const errorBanner = page.getByText('временно недоступна');
    await expect(feedback.or(errorBanner)).toBeVisible({ timeout: 90000 });

    if (await errorBanner.isVisible()) {
      console.log('LLM temporarily unavailable — verifying retry UI');
      // Error handling: student sees error and can retry
      await expect(page.getByRole('button', { name: 'Проверить' })).toBeVisible();
      await context.close();
      return;
    }

    const verdict = await feedback.getAttribute('data-verdict');
    console.log(`LLM verdict: ${verdict}`);
    console.log(`Feedback text: ${await feedback.textContent()}`);

    // Vague answer should NOT be "correct" (partial or incorrect)
    expect(['partial', 'incorrect']).toContain(verdict);

    await context.close();
  });

  test('seeded passwords lesson free-text works with real LLM', async ({ browser }) => {
    // Use the platform course seeded by seed.sh
    const fixturesRaw = fs.readFileSync(path.resolve(__dirname, '../../.test-fixtures.json'), 'utf-8');
    const fixtures = JSON.parse(fixturesRaw) as Record<string, string>;
    const courseId = fixtures.platformCourseId;
    if (!courseId) {
      test.skip(true, 'No PLATFORM_COURSE_ID in fixtures — seed may not have run');
      return;
    }

    const { context, page } = await createFreshStudentPage(browser, 'real-llm-seeded');

    // Complete phishing lesson first, then reach passwords free-text
    await openPasswordsFreeTextStep(page, courseId);

    // Now on the free-text question about passwords
    await expect(page.getByText(/почему нельзя использовать один пароль/i)).toBeVisible();
    await page.getByPlaceholder('Напиши свой ответ...').fill(
      'Если один из сайтов взломают, хакеры получат пароль и смогут зайти во все остальные аккаунты, где стоит тот же самый пароль.',
    );
    await page.getByRole('button', { name: 'Проверить' }).click();

    const feedback = page.locator('[data-role="feedback"]');
    await expect(feedback).toBeVisible({ timeout: 90000 });

    const verdict = await feedback.getAttribute('data-verdict');
    console.log(`Seeded lesson LLM verdict: ${verdict}`);
    console.log(`Feedback text: ${await feedback.textContent()}`);

    // This is a good answer, should be correct or partial
    expect(['correct', 'partial']).toContain(verdict);

    await context.close();
  });

  test('teacher preview with free-text triggers real LLM evaluation', async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const lessonId = `real_llm_preview_${Date.now()}`;
    const lesson = buildBranchingFreeTextLesson({
      lessonId,
      title: 'Превью LLM',
      introText: 'Вопрос про интернет-безопасность.',
      questionText: 'Что такое фишинг и как от него защититься?',
      referenceAnswer: 'Фишинг — это вид мошенничества, когда злоумышленники создают поддельные сайты или отправляют фальшивые письма, чтобы украсть личные данные. Защититься можно, проверяя адрес сайта и не переходя по подозрительным ссылкам.',
      criteria: 'Ученик должен объяснить что такое фишинг и назвать хотя бы один способ защиты.',
      correctText: 'Верно!',
      partialText: 'Частично.',
      incorrectText: 'Неверно.',
    });

    const { courseId } = await createAdminCourseWithDraft(adminPage, {
      title: `Real LLM Preview ${Date.now()}`,
      description: 'Тест превью с реальным LLM',
      ageMin: 8,
      ageMax: 14,
      modules: [{ id: 'mod_preview', title: 'Модуль', lessons: [lesson] }],
    });

    // Start preview session via API
    const previewResp = await apiRequest<{ preview_session_id?: string; step?: Record<string, unknown> }>(
      adminPage,
      'POST',
      `/admin/courses/${courseId}/preview`,
      { lesson_id: lessonId, return_path: '' },
      { fallbackPath: '/admin/courses' },
    );
    expect(previewResp.status).toBeGreaterThanOrEqual(200);
    expect(previewResp.status).toBeLessThan(300);
    const previewSessionId = previewResp.body?.preview_session_id;
    expect(previewSessionId).toBeTruthy();

    // Navigate to preview player
    await adminPage.goto(`/admin/preview/${previewSessionId}`);

    // If on intro story, advance past it
    const storyNode = adminPage.locator('[data-node-kind="story"]');
    const freeTextNode = adminPage.locator('[data-node-kind="free_text"]');
    await expect(storyNode.or(freeTextNode)).toBeVisible({ timeout: 15000 });
    if (await storyNode.isVisible()) {
      await adminPage.getByRole('button', { name: 'Далее' }).click();
    }
    await expect(freeTextNode).toBeVisible({ timeout: 10000 });

    // Submit answer in preview (preview uses different placeholder/button text)
    await adminPage.getByPlaceholder('Введите ваш ответ...').fill(
      'Фишинг — это когда мошенники подделывают сайты, чтобы украсть пароли. Нужно всегда проверять URL сайта перед вводом данных.',
    );
    await adminPage.getByRole('button', { name: 'Ответить' }).click();

    const feedback = adminPage.locator('[data-role="feedback"]');
    await expect(feedback).toBeVisible({ timeout: 90000 });

    const verdict = await feedback.getAttribute('data-verdict');
    console.log(`Preview LLM verdict: ${verdict}`);
    console.log(`Preview feedback: ${await feedback.textContent()}`);

    // Good answer about phishing — should be correct or partial
    expect(['correct', 'partial']).toContain(verdict);

    await adminContext.close();
  });
});
