import { execSync } from 'node:child_process';

/**
 * Global teardown for E2E tests.
 *
 * Drops the test database unless E2E_KEEP_DB is set.
 */

const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DB_NAME = process.env.DB_NAME ?? 'pravoprost_e2e';

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_DB) {
    console.log(
      `[global-teardown] E2E_KEEP_DB is set -- keeping database "${DB_NAME}"`,
    );
    return;
  }

  console.log(`[global-teardown] Dropping database "${DB_NAME}"...`);

  try {
    execSync(
      `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}'"`,
      {
        env: { ...process.env, PGPASSWORD: PG_PASSWORD },
        stdio: 'pipe',
      },
    );
  } catch {
    // ignore
  }

  try {
    execSync(
      `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d postgres -q -c "DROP DATABASE IF EXISTS ${DB_NAME}"`,
      {
        env: { ...process.env, PGPASSWORD: PG_PASSWORD },
        stdio: 'pipe',
      },
    );
    console.log(`[global-teardown] Database "${DB_NAME}" dropped.`);
  } catch (err) {
    console.warn(
      `[global-teardown] Failed to drop database: ${err instanceof Error ? err.message : err}`,
    );
  }
}
