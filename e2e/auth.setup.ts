import { test as setup } from '@playwright/test';
import { loginAs } from './helpers/sso-login';

/**
 * Authentication setup project.
 *
 * Logs in as each role via mock Yandex SSO and saves browser
 * storageState to .auth/<role>.json for reuse in test projects.
 *
 * The mock SSO page at /authorize renders user-picker links:
 *   "Admin", "Teacher (Мария Ивановна)", "Student (Алиса)", etc.
 */

const roles: Array<{
  role: string;
  /** Text of the link on the mock SSO user-picker page. */
  linkText: string;
}> = [
  { role: 'admin', linkText: 'Admin' },
  { role: 'teacher', linkText: 'Teacher (Мария Ивановна)' },
  { role: 'student', linkText: 'Student (Алиса)' },
  { role: 'parent', linkText: 'Parent (Елена)' },
  { role: 'student2', linkText: 'Student 2 (Борис)' },
];

for (const { role, linkText } of roles) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    await loginAs(page, linkText);

    await page.context().storageState({
      path: `.auth/${role}.json`,
    });
  });
}
