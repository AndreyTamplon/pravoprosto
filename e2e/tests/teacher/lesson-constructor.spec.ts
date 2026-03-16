import { test, expect } from '@playwright/test';
import { fixtures } from '../../helpers/fixtures';

test.use({ storageState: '.auth/teacher.json' });

test.describe('Teacher: Lesson constructor', () => {
  test('course constructor shows module "Безопасные покупки" and lesson "Проверяем магазин"', async ({ page }) => {
    const { teacherCourseId } = fixtures;
    await page.goto(`/teacher/courses/${teacherCourseId}`);

    // Constructor header with title input
    await expect(page.locator('input[value="Покупки онлайн"]')).toBeVisible({ timeout: 10000 });

    // "Модули и этапы" section
    await expect(page.getByText('Модули и этапы')).toBeVisible();

    // Module "Безопасные покупки" should be visible as input value
    await expect(page.locator('input[value="Безопасные покупки"]')).toBeVisible();

    // Lesson "Проверяем магазин" within the module
    await expect(page.getByText('Проверяем магазин')).toBeVisible();

    // "Редактировать" button for the lesson
    await expect(page.getByRole('button', { name: /Редактировать/ }).first()).toBeVisible();

    // "Прогресс учеников" link at the bottom
    await expect(page.getByRole('button', { name: /Прогресс учеников/ })).toBeVisible();
  });

  test('navigating to lesson constructor shows node-type buttons and back navigation', async ({ page }) => {
    const { teacherCourseId } = fixtures;
    await page.goto(`/teacher/courses/${teacherCourseId}`);

    // Wait for module to load
    await expect(page.getByText('Проверяем магазин')).toBeVisible({ timeout: 10000 });

    // Click "Редактировать" to open lesson constructor
    await page.getByRole('button', { name: /Редактировать/ }).first().click();
    await page.waitForURL(/\/teacher\/courses\/.+\/lessons\/.+/);

    // Add-node buttons should be visible
    await expect(page.getByRole('button', { name: /Блок истории/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Выбор ответа/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Свободный ответ/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Завершение/ })).toBeVisible();

    // Toolbar buttons
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Предпросмотр/ })).toBeVisible();

    // Back to course button
    const backBtn = page.getByRole('button', { name: /К курсу/ });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL(/\/teacher\/courses\/[^/]+$/);
    await expect(page.getByText('Модули и этапы')).toBeVisible();
  });
});
