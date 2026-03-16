import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shape of the fixture data written by global-setup after seeding.
 */
export interface TestFixtures {
  platformCourseId: string;
  revisionId: string;
  teacherCourseId: string;
  accessLinkToken: string;
  offerId: string;
  guardianInviteToken: string;
  adminAccountId: string;
}

function getDir(): string {
  // Works both in CJS (__dirname) and ESM (import.meta.url) contexts.
  // Playwright's test runner typically transpiles to CJS so __dirname is available,
  // but we handle both cases for robustness.
  try {
    return __dirname;
  } catch {
    return path.dirname(fileURLToPath(import.meta.url));
  }
}

let _cached: TestFixtures | null = null;

/**
 * Reads and returns the seeded fixture IDs from `.test-fixtures.json`.
 *
 * Results are cached after the first read.
 *
 * @throws if the file does not exist (global-setup must run first).
 */
export function getFixtures(): TestFixtures {
  if (_cached) return _cached;

  const filePath = path.resolve(getDir(), '..', '.test-fixtures.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `.test-fixtures.json not found at ${filePath}. Did global-setup run?`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  _cached = JSON.parse(raw) as TestFixtures;
  return _cached;
}

/**
 * Lazily-loaded fixture proxy.
 *
 * Existing tests import this as:
 *   import { fixtures } from '../../helpers/fixtures';
 *   const { platformCourseId } = fixtures;
 *
 * Properties are resolved on first access from `.test-fixtures.json`.
 */
export const fixtures: TestFixtures = new Proxy({} as TestFixtures, {
  get(_target, prop: string) {
    const data = getFixtures();
    return data[prop as keyof TestFixtures];
  },
});

/**
 * Auth storage state file path for a given role.
 */
export function authFile(
  role: 'admin' | 'teacher' | 'student' | 'parent' | 'student2',
): string {
  return path.resolve(getDir(), '..', '.auth', `${role}.json`);
}
