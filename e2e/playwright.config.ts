import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for "Право Просто" E2E tests.
 *
 * Uses non-standard ports to avoid conflicts with Docker containers.
 *   mockserver: 3091 (SSO) / 3090 (LLM)
 *   backend:    3080
 *   frontend:   3173
 */

const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? '3080';
const SSO_PORT = process.env.E2E_SSO_PORT ?? '3091';
const LLM_PORT = process.env.E2E_LLM_PORT ?? '3090';
const FRONTEND_PORT = process.env.E2E_FRONTEND_PORT ?? '3173';
const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DB_NAME = process.env.DB_NAME ?? 'pravoprost_e2e';

const backendEnv: Record<string, string> = {
  PRAVO_DATABASE_URL:
    `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}?sslmode=disable`,
  PRAVO_SIGNING_SECRET: 'e2e-test-signing-secret-32chars!',
  PRAVO_LLM_API_KEY: 'e2e-test-key',
  PRAVO_LLM_BASE_URL: `http://localhost:${LLM_PORT}`,
  PRAVO_COOKIE_SECURE: 'false',
  PRAVO_BASE_URL: `http://localhost:${FRONTEND_PORT}`,
  PRAVO_HTTP_ADDR: `:${BACKEND_PORT}`,
  PRAVO_LLM_MODEL: 'mock-gpt',
  PRAVO_LLM_TIMEOUT_SECONDS: '10',
  PRAVO_YANDEX_CLIENT_ID: 'mock-client-id',
  PRAVO_YANDEX_CLIENT_SECRET: 'mock-client-secret',
  PRAVO_YANDEX_AUTH_URL: `http://localhost:${SSO_PORT}/authorize`,
  PRAVO_YANDEX_TOKEN_URL: `http://localhost:${SSO_PORT}/token`,
  PRAVO_YANDEX_USERINFO_URL: `http://localhost:${SSO_PORT}/info`,
  PRAVO_SSO_BASE_URL: '',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  timeout: 60_000,
  reporter: process.env.CI ? 'html' : 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      command: `cd ../backend && MOCK_SSO_ADDR=:${SSO_PORT} MOCK_LLM_ADDR=:${LLM_PORT} ./mockserver`,
      port: Number(SSO_PORT),
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `bash -c "PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c \\"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}'\\" 2>/dev/null; PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c 'DROP DATABASE IF EXISTS ${DB_NAME}' 2>/dev/null; PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c 'CREATE DATABASE ${DB_NAME}' 2>/dev/null; cd ../backend && ./server"`,
      port: Number(BACKEND_PORT),
      reuseExistingServer: !process.env.CI,
      env: backendEnv,
      timeout: 60_000,
    },
    {
      command: `cd ../frontend && VITE_PORT=${FRONTEND_PORT} VITE_BACKEND_PORT=${BACKEND_PORT} npx vite --port ${FRONTEND_PORT}`,
      port: Number(FRONTEND_PORT),
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
