import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Global setup for E2E tests.
 *
 * 1. Creates (or recreates) the pravoprost_e2e database.
 * 2. Waits for all three services to become healthy.
 * 3. Seeds data by running seed.sh and captures fixture IDs from its output.
 * 4. Writes .test-fixtures.json for test consumption.
 */

const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DB_NAME = process.env.DB_NAME ?? 'pravoprost_e2e';

function getE2eDir(): string {
  try {
    return __dirname;
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
}

const E2E_DIR = getE2eDir();
const PROJECT_DIR = path.resolve(E2E_DIR, '..');

function psql(sql: string): void {
  execSync(
    `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c "${sql}"`,
    { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, stdio: 'pipe' },
  );
}

async function waitForHealth(
  url: string,
  label: string,
  maxAttempts = 30,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`  [health] ${label} is up`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${label} did not become healthy at ${url}`);
}

function extractField(output: string, label: string): string {
  // Matches lines like "Platform course: <uuid>" or "Access link token: <value>"
  const re = new RegExp(`${label}:\\s*(.+)`, 'i');
  const m = output.match(re);
  return m ? m[1].trim() : '';
}

export default async function globalSetup(): Promise<void> {
  console.log('[global-setup] Database created by webServer command.');

  // Wait for services to become healthy
  console.log('[global-setup] Waiting for services...');
  const BACKEND_PORT = process.env.E2E_BACKEND_PORT ?? '3080';
  const SSO_PORT = process.env.E2E_SSO_PORT ?? '3091';
  const LLM_PORT = process.env.E2E_LLM_PORT ?? '3090';
  const FRONTEND_PORT = process.env.E2E_FRONTEND_PORT ?? '3173';

  await Promise.all([
    waitForHealth(`http://localhost:${SSO_PORT}/health`, 'mockserver (SSO)'),
    waitForHealth(`http://localhost:${LLM_PORT}/health`, 'mockserver (LLM)'),
    waitForHealth(`http://localhost:${BACKEND_PORT}/health`, 'backend'),
  ]);
  await waitForHealth(`http://localhost:${FRONTEND_PORT}`, 'frontend');

  // Run seed.sh
  console.log('[global-setup] Seeding data via seed.sh...');
  const seedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PRAVO_BASE_URL: `http://localhost:${BACKEND_PORT}`,
    PRAVO_DATABASE_URL: `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}?sslmode=disable`,
    PGPASSWORD: PG_PASSWORD,
    MOCK_SSO_PORT: SSO_PORT,
    MOCK_LLM_PORT: LLM_PORT,
  };

  let seedOutput: string;
  try {
    seedOutput = execSync(`bash ${path.join(E2E_DIR, 'seed.sh')}`, {
      cwd: PROJECT_DIR,
      env: seedEnv,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    console.error('[global-setup] seed.sh FAILED');
    console.error('[global-setup] stdout:', e.stdout?.toString().slice(-2000));
    console.error('[global-setup] stderr:', e.stderr?.toString().slice(-2000));
    throw e;
  }

  console.log('[global-setup] Seed output (summary):');

  // Parse IDs from seed.sh output
  const platformCourseId = extractField(seedOutput, 'Platform course');
  const revisionId = extractField(seedOutput, 'Published revision');
  const teacherCourseId = extractField(seedOutput, 'Teacher course');
  const accessLinkToken = extractField(seedOutput, 'Access link token');
  const offerId = extractField(seedOutput, 'Offer ID');
  const guardianInviteToken = extractField(seedOutput, 'Guardian invite token');
  const adminAccountId = extractField(seedOutput, 'Admin account');

  const fixtures = {
    platformCourseId,
    revisionId,
    teacherCourseId,
    accessLinkToken,
    offerId,
    guardianInviteToken,
    adminAccountId,
  };

  console.log('[global-setup] Fixtures:', JSON.stringify(fixtures, null, 2));

  fs.writeFileSync(
    path.join(E2E_DIR, '.test-fixtures.json'),
    JSON.stringify(fixtures, null, 2),
  );

  // Ensure .auth directory exists
  fs.mkdirSync(path.join(E2E_DIR, '.auth'), { recursive: true });

  console.log('[global-setup] Done.');
}
