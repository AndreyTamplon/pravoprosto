import { randomUUID, createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  buildSimpleStoryLesson,
  createTeacherAccessLink,
  createTeacherCourseWithDraft,
  approveTeacherCourse,
  submitTeacherCourseForReview,
} from '../../helpers/course-builders';
import {
  extractClaimToken,
  getSessionAccountId,
} from '../../helpers/browser-api';
import { psqlExec } from '../../helpers/api-seeder';
import { createFreshStudentPage } from '../../helpers/student-lessons';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Nightly: invite lifecycle contracts', () => {
  test('teacher access links preserve available URLs, show legacy unavailable rows, and support claim + revoke lifecycle', async ({
    browser,
  }) => {
    const teacherContext = await browser.newContext({ storageState: '.auth/teacher.json' });
    const teacherPage = await teacherContext.newPage();
    const adminContext = await browser.newContext({ storageState: '.auth/admin.json' });
    const adminPage = await adminContext.newPage();

    const courseTitle = `Nightly Access ${Date.now()}`;
    const course = await createTeacherCourseWithDraft(teacherPage, {
      title: courseTitle,
      description: 'Курс для проверки lifecycle access links',
      modules: [
        {
          id: 'module_access',
          title: 'Доступ',
          lessons: [
            buildSimpleStoryLesson({
              lessonId: 'lesson_access_intro',
              title: 'Первый доступ',
              storyText: 'Добро пожаловать в закрытый курс по ссылке.',
            }),
          ],
        },
      ],
    });
    await submitTeacherCourseForReview(teacherPage, course.courseId);
    await approveTeacherCourse(adminPage, course.courseId);

    const teacherAccountId = await getSessionAccountId(teacherPage, '/teacher');
    expect(teacherAccountId).toBeTruthy();

    const initialLink = await createTeacherAccessLink(teacherPage, course.courseId);
    const legacyLinkID = randomUUID();
    const legacyTokenHash = createHash('sha256')
      .update(`legacy-course-link-${Date.now()}`)
      .digest('hex');

    psqlExec(`
      insert into course_access_links(id, course_id, token_hash, token_encrypted, status, expires_at, created_by_account_id, created_at)
      values (
        '${legacyLinkID}',
        '${course.courseId}',
        '${legacyTokenHash}',
        '   ',
        'active',
        now() + interval '1 day',
        '${teacherAccountId}',
        now() - interval '1 hour'
      )
    `);

    await teacherPage.goto(`/teacher/courses/${course.courseId}`);
    await teacherPage.getByRole('button', { name: 'Поделиться' }).click();
    const dialog = teacherPage.getByRole('dialog', { name: 'Поделиться курсом' });
    await expect(dialog).toBeVisible();

    const initialAvailableCount = await dialog.getByText(/\/claim\/course-link#token=/).count();
    const initialCopyButtons = await dialog.getByRole('button', { name: 'Копировать' }).count();
    const initialRevokeButtons = await dialog.getByRole('button', { name: 'Отозвать' }).count();
    await expect(dialog.getByText(new RegExp(escapeRegex(initialLink.token)))).toBeVisible();
    await expect(dialog.getByText('Ссылка недоступна для старого приглашения').first()).toBeVisible();
    expect(initialAvailableCount).toBeGreaterThanOrEqual(1);
    expect(initialCopyButtons).toBe(initialAvailableCount);
    expect(initialRevokeButtons).toBeGreaterThan(initialCopyButtons);

    const { context: studentContext, page: studentPage } = await createFreshStudentPage(
      browser,
      'nightly-teacher-access',
    );
    await studentPage.goto(initialLink.claimUrl);
    await expect(studentPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({
      timeout: 15000,
    });
    await expect(studentPage.getByText('Курс успешно добавлен')).toBeVisible();
    await studentPage.getByRole('button', { name: 'Продолжить' }).click();
    await studentPage.waitForURL(/\/student\/courses/);
    await expect(
      studentPage.getByRole('heading', { name: courseTitle, exact: true }).first(),
    ).toBeVisible({ timeout: 10000 });

    const beforeCreateUrls = await dialog.getByText(/\/claim\/course-link#token=/).count();
    const beforeCreateCopyButtons = await dialog.getByRole('button', { name: 'Копировать' }).count();
    const beforeCreateRevokeButtons = await dialog.getByRole('button', { name: 'Отозвать' }).count();
    const createResponse = teacherPage.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes(`/teacher/courses/${course.courseId}/access-links`),
    );
    await dialog.getByRole('button', { name: /\+ Создать ссылку/i }).click();
    expect((await createResponse).ok()).toBeTruthy();

    const newLinkText = dialog.getByText(/\/claim\/course-link#token=/).first();
    await expect(dialog.getByText(/\/claim\/course-link#token=/)).toHaveCount(beforeCreateUrls + 1);
    const newLinkURL = ((await newLinkText.textContent()) ?? '').trim();
    const newLinkToken = extractClaimToken(newLinkURL);
    expect(newLinkToken).toBeTruthy();
    await expect(dialog.getByRole('button', { name: 'Копировать' })).toHaveCount(beforeCreateCopyButtons + 1);
    await expect(dialog.getByRole('button', { name: 'Отозвать' })).toHaveCount(beforeCreateRevokeButtons + 1);

    const revokeResponse = teacherPage.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/teacher/access-links/')
      && response.url().includes('/revoke'),
    );
    await dialog.getByRole('button', { name: 'Отозвать' }).first().click();
    expect((await revokeResponse).ok()).toBeTruthy();

    await expect(dialog.getByText(new RegExp(escapeRegex(newLinkToken)))).toHaveCount(0);
    await expect(dialog.getByText(new RegExp(escapeRegex(initialLink.token)))).toBeVisible();
    await expect(dialog.getByText('Ссылка недоступна для старого приглашения').first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Копировать' })).toHaveCount(beforeCreateCopyButtons);
    await expect(dialog.getByRole('button', { name: 'Отозвать' })).toHaveCount(beforeCreateRevokeButtons);

    await studentContext.close();
    await teacherContext.close();
    await adminContext.close();
  });

  test('guardian invites distinguish legacy unavailable rows and support create, claim, and revoke lifecycle', async ({
    browser,
  }) => {
    const parentContext = await browser.newContext({ storageState: '.auth/parent.json' });
    const parentPage = await parentContext.newPage();

    await parentPage.goto('/parent');
    await expect(parentPage.getByRole('heading', { name: 'Мои дети' })).toBeVisible();

    const parentAccountId = await getSessionAccountId(parentPage, '/parent');
    expect(parentAccountId).toBeTruthy();

    const legacyInviteID = randomUUID();
    const legacyTokenHash = createHash('sha256')
      .update(`legacy-guardian-link-${Date.now()}`)
      .digest('hex');
    psqlExec(`
      insert into guardian_link_invites(id, created_by_parent_id, token_hash, token_encrypted, status, expires_at, created_at)
      values (
        '${legacyInviteID}',
        '${parentAccountId}',
        '${legacyTokenHash}',
        null,
        'active',
        now() + interval '7 days',
        now() - interval '1 hour'
      )
    `);

    await parentPage.reload();
    await expect(parentPage.getByText('Активные приглашения')).toBeVisible();
    await expect(parentPage.getByText('Ссылка недоступна для старого приглашения').first()).toBeVisible();
    await expect(parentPage.getByText('Создайте новое приглашение').first()).toBeVisible();

    await parentPage.getByRole('button', { name: /\+ Добавить ребёнка/i }).click();
    const createDialog = parentPage.getByRole('dialog', { name: 'Добавить ребёнка' });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole('button', { name: 'Создать приглашение' }).click();

    const firstInviteURL = ((await createDialog.getByText(/\/claim\/guardian-link#token=/).textContent()) ?? '').trim();
    const firstInviteToken = extractClaimToken(firstInviteURL);
    expect(firstInviteToken).toBeTruthy();
    await parentPage.keyboard.press('Escape');

    await expect(parentPage.getByText(new RegExp(escapeRegex(firstInviteToken)))).toBeVisible({
      timeout: 10000,
    });

    const {
      context: childContext,
      page: childPage,
      loginCode: childDisplayName,
    } = await createFreshStudentPage(browser, 'nightly-guardian-child');
    await childPage.goto(firstInviteURL);
    await expect(childPage.getByRole('heading', { name: 'Готово!' })).toBeVisible({
      timeout: 15000,
    });
    await expect(childPage.getByText('Связь с родителем установлена')).toBeVisible();
    await childPage.getByRole('button', { name: 'Продолжить' }).click();
    await childPage.waitForURL(/\/student\/profile/);

    await parentPage.goto('/parent');
    await expect(parentPage.getByText(childDisplayName)).toBeVisible({ timeout: 10000 });
    await expect(parentPage.getByText(new RegExp(escapeRegex(firstInviteToken)))).toHaveCount(0);
    await expect(parentPage.getByText('Ссылка недоступна для старого приглашения').first()).toBeVisible();

    await parentPage.getByRole('button', { name: /\+ Добавить ребёнка/i }).click();
    const secondDialog = parentPage.getByRole('dialog', { name: 'Добавить ребёнка' });
    await secondDialog.getByRole('button', { name: 'Создать приглашение' }).click();
    const secondInviteURL = ((await secondDialog.getByText(/\/claim\/guardian-link#token=/).textContent()) ?? '').trim();
    const secondInviteToken = extractClaimToken(secondInviteURL);
    expect(secondInviteToken).toBeTruthy();
    await parentPage.keyboard.press('Escape');

    const revokeResponse = parentPage.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/api/v1/parent/children/link-invites/')
      && response.url().includes('/revoke'),
    );
    await parentPage.getByRole('button', { name: 'Отозвать' }).first().click();
    expect((await revokeResponse).ok()).toBeTruthy();

    await expect(parentPage.getByText(new RegExp(escapeRegex(secondInviteToken)))).toHaveCount(0);
    await expect(parentPage.getByText(childDisplayName)).toBeVisible();
    await expect(parentPage.getByText('Ссылка недоступна для старого приглашения').first()).toBeVisible();

    await childContext.close();
    await parentContext.close();
  });
});
