import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface ApiResult<T> {
  status: number;
  body: T | null;
}

export async function createFreshStudentPage(
  browser: Browser,
  codePrefix = 'e2e-student',
): Promise<{ context: BrowserContext; page: Page; loginCode: string }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const loginCode = `${codePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await page.goto('/auth');
  await page.getByRole('button', { name: /Яндекс/i }).click();
  await page.waitForURL(/\/authorize/);
  await page.getByPlaceholder('custom-user-code').fill(loginCode);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => {
    const path = url.pathname;
    return path.includes('/role-select') || path.includes('/student-onboarding') || path.includes('/student/courses');
  });

  if (page.url().includes('/role-select')) {
    await page.getByText('Ученик').click();
    await page.waitForURL((url) => {
      const path = url.pathname;
      return path.includes('/student-onboarding') || path.includes('/student/courses');
    });
  }

  if (!page.url().includes('/student/courses')) {
    await page.goto('/student/courses');
    await page.waitForURL(/\/student\/courses/);
  }

  return { context, page, loginCode };
}

interface CourseTreeLesson {
  lesson_id: string;
  status: string;
}

interface CourseTreeResponse {
  modules?: Array<{
    lessons?: CourseTreeLesson[];
  }>;
}

async function getCsrfToken(page: Page): Promise<string> {
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return response.ok ? response.json().catch(() => null) : null;
  });
  return (session?.csrf_token as string | undefined) ?? '';
}

async function apiRequest<T>(page: Page, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  if (page.url() === 'about:blank') {
    await page.goto('/student/courses');
  }
  const csrfToken = method === 'POST' ? await getCsrfToken(page) : '';
  return page.evaluate(
    async ({ requestMethod, requestPath, requestBody, csrf }) => {
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
      const parsed = await response.json().catch(() => null);
      return { status: response.status, body: parsed };
    },
    {
      requestMethod: method,
      requestPath: path,
      requestBody: body,
      csrf: csrfToken,
    },
  ) as Promise<ApiResult<T>>;
}

async function getLessonStatus(page: Page, courseId: string, lessonId: string): Promise<string | null> {
  const response = await apiRequest<CourseTreeResponse>(page, 'GET', `/student/courses/${courseId}`);
  expect(response.status).toBe(200);
  const lessons = response.body?.modules?.flatMap(module => module.lessons ?? []) ?? [];
  const lesson = lessons.find(item => item.lesson_id === lessonId);
  return lesson?.status ?? null;
}

export async function openLessonAttempt(page: Page, courseId: string, lessonId: string) {
  const status = await getLessonStatus(page, courseId, lessonId);

  if (status === 'completed') {
    const retry = await apiRequest(page, 'POST', `/student/courses/${courseId}/lessons/${lessonId}/retry`);
    expect(retry.status).toBe(200);
  } else {
    const start = await apiRequest(page, 'POST', `/student/courses/${courseId}/lessons/${lessonId}/start`);
    expect(start.status).toBe(200);
  }

  await page.goto(`/student/courses/${courseId}/lessons/${lessonId}`);
}

export async function completePhishingLesson(page: Page, courseId: string) {
  await openLessonAttempt(page, courseId, 'lesson_phishing');

  await expect(page.getByText(/Тебе пришло сообщение/)).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.getByText('Что ты сделаешь с этим сообщением?')).toBeVisible();
  await page.getByRole('button', { name: /Покажу родителям и не буду переходить/ }).click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.getByText(/Мошенники часто используют/)).toBeVisible();
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.getByText('Какой из признаков указывает на мошенническое сообщение?')).toBeVisible();
  await page.getByRole('button', { name: /Просят срочно перейти по ссылке/ }).click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.getByText('Миссия выполнена!')).toBeVisible({ timeout: 10000 });
}

export async function openPasswordsFreeTextStep(page: Page, courseId: string) {
  const phishingStatus = await getLessonStatus(page, courseId, 'lesson_phishing');
  if (phishingStatus !== 'completed') {
    await completePhishingLesson(page, courseId);
  }

  await openLessonAttempt(page, courseId, 'lesson_passwords');

  await expect(page.getByText(/Пароль.*ключ к твоим данным/)).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(page.getByText('Какой пароль самый надёжный?')).toBeVisible();
  await page.getByRole('button', { name: /Kx9#mL2\$vQ/ }).click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await expect(page.getByText('ВЕРНО!', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Далее' }).click();

  await expect(
    page.getByText(/почему нельзя использовать один пароль для всех сайтов/i),
  ).toBeVisible();
}
