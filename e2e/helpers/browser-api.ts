import type { Page } from '@playwright/test';

export interface ApiResult<T> {
  status: number;
  body: T | null;
}

export interface SessionSnapshot {
  csrf_token?: string;
  user?: {
    account_id?: string;
    role?: string;
    display_name?: string;
  } | null;
}

async function ensurePageOrigin(page: Page, fallbackPath: string): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.goto(fallbackPath);
  }
}

async function getCsrfToken(page: Page, fallbackPath: string): Promise<string> {
  const session = await getSession(page, fallbackPath);
  return (session?.csrf_token as string | undefined) ?? '';
}

export async function getSession(
  page: Page,
  fallbackPath = '/',
): Promise<SessionSnapshot | null> {
  await ensurePageOrigin(page, fallbackPath);
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/session', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    return response.json().catch(() => null);
  }) as Promise<SessionSnapshot | null>;
}

export async function getSessionAccountId(
  page: Page,
  fallbackPath = '/',
): Promise<string> {
  const session = await getSession(page, fallbackPath);
  return (session?.user?.account_id as string | undefined) ?? '';
}

export async function apiRequest<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options?: { fallbackPath?: string; extraHeaders?: Record<string, string> },
): Promise<ApiResult<T>> {
  const fallbackPath = options?.fallbackPath ?? '/';
  await ensurePageOrigin(page, fallbackPath);
  const csrfToken = method === 'GET' ? '' : await getCsrfToken(page, fallbackPath);

  return page.evaluate(
    async ({ requestMethod, requestPath, requestBody, csrf, extraHeaders }) => {
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(extraHeaders ?? {}),
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
      extraHeaders: options?.extraHeaders ?? {},
    },
  ) as Promise<ApiResult<T>>;
}

export function extractClaimToken(url?: string | null): string {
  if (!url) {
    return '';
  }
  const match = url.match(/(?:#|[?&])token=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
