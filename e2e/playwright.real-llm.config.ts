import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for real-LLM E2E tests.
 *
 * Uses the same ports/infra as the main config, but points the backend
 * to a real OpenAI-compatible LLM provider instead of the mock server.
 *
 * Requires .env at project root with:
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, '../.env');
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
  return result;
}

const dotenv = loadDotEnv();

const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? '3080';
const SSO_PORT = process.env.E2E_SSO_PORT ?? '3091';
const LLM_PORT = process.env.E2E_LLM_PORT ?? '3090';
const FRONTEND_PORT = process.env.E2E_FRONTEND_PORT ?? '3173';
const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DB_NAME = process.env.DB_NAME ?? 'pravoprost_e2e';

// Real LLM config from .env (strip trailing /v1 if present — code appends /v1/chat/completions)
let llmBaseUrl = dotenv.LLM_BASE_URL ?? process.env.LLM_BASE_URL ?? '';
llmBaseUrl = llmBaseUrl.replace(/\/v1\/?$/, '');
const llmApiKey = dotenv.LLM_API_KEY ?? process.env.LLM_API_KEY ?? '';
const llmModel = dotenv.LLM_MODEL ?? process.env.LLM_MODEL ?? '';

if (!llmBaseUrl || !llmApiKey || !llmModel) {
  throw new Error('Missing LLM_BASE_URL, LLM_API_KEY, or LLM_MODEL in .env or environment');
}

const backendEnv: Record<string, string> = {
  PRAVO_DATABASE_URL:
    `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}?sslmode=disable`,
  PRAVO_SIGNING_SECRET: 'e2e-test-signing-secret-32chars!',
  PRAVO_LLM_BASE_URL: llmBaseUrl,
  PRAVO_LLM_API_KEY: llmApiKey,
  PRAVO_LLM_MODEL: llmModel,
  PRAVO_LLM_TIMEOUT_SECONDS: '90',
  PRAVO_COOKIE_SECURE: 'false',
  PRAVO_BASE_URL: `http://localhost:${FRONTEND_PORT}`,
  PRAVO_HTTP_ADDR: `:${BACKEND_PORT}`,
  PRAVO_YANDEX_CLIENT_ID: 'mock-client-id',
  PRAVO_YANDEX_CLIENT_SECRET: 'mock-client-secret',
  PRAVO_YANDEX_AUTH_URL: `http://localhost:${SSO_PORT}/authorize`,
  PRAVO_YANDEX_TOKEN_URL: `http://localhost:${SSO_PORT}/token`,
  PRAVO_YANDEX_USERINFO_URL: `http://localhost:${SSO_PORT}/info`,
  PRAVO_SSO_BASE_URL: '',
};

export default defineConfig({
  testDir: './tests/real-llm',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on',
    screenshot: 'on',
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'real-llm',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      command: `cd ../backend && MOCK_SSO_ADDR=:${SSO_PORT} MOCK_LLM_ADDR=:${LLM_PORT} ./mockserver`,
      port: Number(SSO_PORT),
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: `bash -c "PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c \\"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}'\\" 2>/dev/null; PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c 'DROP DATABASE IF EXISTS ${DB_NAME}' 2>/dev/null; PGPASSWORD=${PG_PASSWORD} psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c 'CREATE DATABASE ${DB_NAME}' 2>/dev/null; cd ../backend && ./server"`,
      port: Number(BACKEND_PORT),
      reuseExistingServer: true,
      env: backendEnv,
      timeout: 60_000,
    },
    {
      command: `cd ../frontend && VITE_PORT=${FRONTEND_PORT} VITE_BACKEND_PORT=${BACKEND_PORT} npx vite --port ${FRONTEND_PORT}`,
      port: Number(FRONTEND_PORT),
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
