import { test, expect } from '@playwright/test';

test.use({ storageState: '.auth/admin.json' });

test.describe('Admin: Moderation', () => {
  test('moderation page loads with heading, badge, and empty-queue state', async ({ page }) => {
    await page.goto('/admin/moderation');

    // Heading must be present
    await expect(page.getByRole('heading', { name: 'Модерация курсов' })).toBeVisible();

    // Queue count badge (seed approved the only teacher course, so expect "0 в очереди")
    const badge = page.getByText(/\d+\s*в очереди/);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('0 в очереди');

    // Since the teacher course was already approved during seed, the queue is empty.
    // Verify empty state renders with title AND description
    await expect(page.getByText('Очередь пуста')).toBeVisible();
    await expect(page.getByText('Нет курсов на модерации')).toBeVisible();

    // No table should be present when queue is empty
    await expect(page.getByRole('table')).not.toBeVisible();
  });
});
