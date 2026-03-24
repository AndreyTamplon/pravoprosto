import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * API seeder helpers.
 *
 * The primary seeding strategy uses the existing seed.sh script,
 * which performs all API calls via curl. These helpers provide
 * a TypeScript wrapper for additional ad-hoc seeding if needed.
 */

const BASE_URL = process.env.PRAVO_BASE_URL ?? `http://localhost:${process.env.E2E_BACKEND_PORT ?? '3080'}`;
const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DB_NAME = process.env.DB_NAME ?? 'pravoprost_e2e';
const DB_URL =
  process.env.PRAVO_DATABASE_URL ??
  `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}?sslmode=disable`;

function getDir(): string {
  try {
    return __dirname;
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
}

/**
 * Run a psql command against the test database.
 */
export function psqlExec(sql: string): string {
  return execSync(`psql "${DB_URL}" -q -t -c "${sql}"`, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PGPASSWORD: PG_PASSWORD,
    },
  }).trim();
}

/**
 * Perform the SSO login flow via API (no browser).
 *
 * Returns an object with the session cookie value and CSRF token.
 */
export async function apiLoginAs(
  userCode: string,
): Promise<{ cookieHeader: string; csrfToken: string }> {
  // Step 1: Start SSO flow -- get redirect Location
  const startRes = await fetch(`${BASE_URL}/api/v1/auth/sso/yandex/start`, {
    redirect: 'manual',
  });

  const setCookies = startRes.headers.getSetCookie();
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');

  const authorizeUrl = startRes.headers.get('location');
  if (!authorizeUrl) {
    throw new Error('SSO start did not return Location header');
  }

  // Step 2: Extract state and redirect_uri from authorize URL
  const parsed = new URL(authorizeUrl);
  const state = parsed.searchParams.get('state') ?? '';
  const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';

  // Step 3: Build callback URL and hit it
  const callbackUrl = `${redirectUri}?state=${state}&code=${userCode}`;
  const callbackRes = await fetch(callbackUrl, {
    redirect: 'manual',
    headers: { Cookie: cookieHeader },
  });

  // Merge new cookies from callback
  const callbackCookies = callbackRes.headers.getSetCookie();
  const allCookies = [
    ...setCookies.map((c) => c.split(';')[0]),
    ...callbackCookies.map((c) => c.split(';')[0]),
  ];
  const mergedCookies = allCookies.join('; ');

  // Step 4: Get session to retrieve CSRF token
  const sessionRes = await fetch(`${BASE_URL}/api/v1/session`, {
    headers: { Cookie: mergedCookies },
  });

  const session = (await sessionRes.json()) as { csrf_token?: string };
  const csrfToken = session.csrf_token ?? '';

  return { cookieHeader: mergedCookies, csrfToken };
}

/**
 * Run seed.sh and return its stdout.
 */
export function runSeedScript(): string {
  const dir = getDir();
  const e2eDir = path.resolve(dir, '..');
  const projectDir = path.resolve(e2eDir, '..');

  return execSync(`bash ${path.join(e2eDir, 'seed.sh')}`, {
    cwd: projectDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PRAVO_BASE_URL: BASE_URL,
      PRAVO_DATABASE_URL: DB_URL,
    },
    timeout: 120_000,
  });
}
