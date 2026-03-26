import { expect, type Page } from '@playwright/test';
import { apiRequest, extractClaimToken } from './browser-api';

type BackendNode = Record<string, unknown>;

export interface DraftLessonDefinition {
  id: string;
  title: string;
  graph: Record<string, unknown>;
}

export interface DraftModuleDefinition {
  id: string;
  title: string;
  lessons: DraftLessonDefinition[];
}

export interface CourseDraftDefinition {
  title: string;
  description: string;
  ageMin?: number;
  ageMax?: number;
  modules: DraftModuleDefinition[];
}

interface DraftResponse {
  draft_version?: number;
  title?: string;
  description?: string;
  age_min?: number;
  age_max?: number;
  cover_asset_id?: string | null;
  content?: { modules?: DraftModuleDefinition[] };
  content_json?: { modules?: DraftModuleDefinition[] };
}

function buildDraftBody(draft: DraftResponse, definition: CourseDraftDefinition, draftVersion: number) {
  return {
    draft_version: draftVersion,
    title: definition.title || draft.title || '',
    description: definition.description || draft.description || '',
    age_min: definition.ageMin ?? draft.age_min,
    age_max: definition.ageMax ?? draft.age_max,
    cover_asset_id: draft.cover_asset_id ?? null,
    content: {
      modules: definition.modules,
    },
  };
}

export function buildBranchingSingleChoiceLesson(params: {
  lessonId: string;
  title: string;
  introText: string;
  questionText: string;
  correctOptionText: string;
  incorrectOptionText: string;
  remediationText: string;
  successText: string;
  endText?: string;
}): DraftLessonDefinition {
  const introId = `${params.lessonId}_intro`;
  const questionId = `${params.lessonId}_question`;
  const retryId = `${params.lessonId}_retry`;
  const successId = `${params.lessonId}_success`;
  const endId = `${params.lessonId}_end`;
  const correctOptionId = `${params.lessonId}_correct`;
  const incorrectOptionId = `${params.lessonId}_incorrect`;

  const nodes: BackendNode[] = [
    {
      id: introId,
      kind: 'story',
      body: { text: params.introText },
      nextNodeId: questionId,
    },
    {
      id: questionId,
      kind: 'single_choice',
      prompt: params.questionText,
      options: [
        {
          id: correctOptionId,
          text: params.correctOptionText,
          result: 'correct',
          feedback: 'Правильно! Продолжай.',
          nextNodeId: successId,
        },
        {
          id: incorrectOptionId,
          text: params.incorrectOptionText,
          result: 'incorrect',
          feedback: 'Неправильно. Сначала проверь, кто просит действие.',
          nextNodeId: retryId,
        },
      ],
    },
    {
      id: retryId,
      kind: 'story',
      body: { text: params.remediationText },
      nextNodeId: endId,
    },
    {
      id: successId,
      kind: 'story',
      body: { text: params.successText },
      nextNodeId: endId,
    },
    {
      id: endId,
      kind: 'end',
      text: params.endText ?? 'Миссия завершена!',
    },
  ];

  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: introId,
      nodes,
    },
  };
}

export function buildSimpleStoryLesson(params: {
  lessonId: string;
  title: string;
  storyText: string;
  endText?: string;
}): DraftLessonDefinition {
  const introId = `${params.lessonId}_intro`;
  const endId = `${params.lessonId}_end`;
  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: introId,
      nodes: [
        {
          id: introId,
          kind: 'story',
          body: { text: params.storyText },
          nextNodeId: endId,
        },
        {
          id: endId,
          kind: 'end',
          text: params.endText ?? 'Миссия завершена!',
        },
      ],
    },
  };
}

export function buildHeartsDrainLesson(params: {
  lessonId: string;
  title: string;
  questions: number;
}): DraftLessonDefinition {
  const nodes: BackendNode[] = [];
  const totalQuestions = Math.max(1, params.questions);
  for (let index = 0; index < totalQuestions; index += 1) {
    const nodeId = `${params.lessonId}_q${index + 1}`;
    const nextNodeId = index === totalQuestions - 1 ? `${params.lessonId}_end` : `${params.lessonId}_q${index + 2}`;
    nodes.push({
      id: nodeId,
      kind: 'single_choice',
      prompt: `Контрольный вопрос #${index + 1}`,
      options: [
        {
          id: `${nodeId}_correct`,
          text: 'Правильный ответ',
          result: 'correct',
          feedback: 'Верно.',
          nextNodeId,
        },
        {
          id: `${nodeId}_incorrect`,
          text: 'Неправильный ответ',
          result: 'incorrect',
          feedback: 'Неверно.',
          nextNodeId,
        },
      ],
    });
  }
  nodes.push({
    id: `${params.lessonId}_end`,
    kind: 'end',
    text: 'Финал миссии',
  });

  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: `${params.lessonId}_q1`,
      nodes,
    },
  };
}

export function buildBranchingFreeTextLesson(params: {
  lessonId: string;
  title: string;
  introText: string;
  questionText: string;
  referenceAnswer: string;
  criteria: string;
  correctText: string;
  partialText: string;
  incorrectText: string;
  endText?: string;
}): DraftLessonDefinition {
  const introId = `${params.lessonId}_intro`;
  const questionId = `${params.lessonId}_question`;
  const correctId = `${params.lessonId}_correct`;
  const partialId = `${params.lessonId}_partial`;
  const incorrectId = `${params.lessonId}_incorrect`;
  const endId = `${params.lessonId}_end`;

  const nodes: BackendNode[] = [
    {
      id: introId,
      kind: 'story',
      body: { text: params.introText },
      nextNodeId: questionId,
    },
    {
      id: questionId,
      kind: 'free_text',
      prompt: params.questionText,
      rubric: {
        referenceAnswer: params.referenceAnswer,
        criteriaByVerdict: {
          correct: params.criteria,
          partial: params.criteria,
          incorrect: params.criteria,
        },
        feedbackByVerdict: {
          correct: 'Отлично, ты указал ключевой риск.',
          partial: 'Ход мысли верный, но ответ пока неполный.',
          incorrect: 'Ответ не объясняет основной риск.',
        },
      },
      transitions: [
        { onVerdict: 'correct', nextNodeId: correctId },
        { onVerdict: 'partial', nextNodeId: partialId },
        { onVerdict: 'incorrect', nextNodeId: incorrectId },
      ],
    },
    {
      id: correctId,
      kind: 'story',
      body: { text: params.correctText },
      nextNodeId: endId,
    },
    {
      id: partialId,
      kind: 'story',
      body: { text: params.partialText },
      nextNodeId: endId,
    },
    {
      id: incorrectId,
      kind: 'story',
      body: { text: params.incorrectText },
      nextNodeId: endId,
    },
    {
      id: endId,
      kind: 'end',
      text: params.endText ?? 'Миссия завершена!',
    },
  ];

  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: introId,
      nodes,
    },
  };
}

export function buildMultiVerdictSingleChoiceLesson(params: {
  lessonId: string;
  title: string;
  questionText: string;
  correctA: string;
  correctB: string;
  partial: string;
  incorrect: string;
  successText: string;
  partialText: string;
  incorrectText: string;
}): DraftLessonDefinition {
  const questionId = `${params.lessonId}_question`;
  const successId = `${params.lessonId}_success`;
  const partialId = `${params.lessonId}_partial`;
  const incorrectId = `${params.lessonId}_incorrect`;
  const endId = `${params.lessonId}_end`;

  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: questionId,
      nodes: [
        {
          id: questionId,
          kind: 'single_choice',
          prompt: params.questionText,
          options: [
            { id: `${params.lessonId}_correct_a`, text: params.correctA, result: 'correct', feedback: 'Это полноценный правильный ответ.', nextNodeId: successId },
            { id: `${params.lessonId}_correct_b`, text: params.correctB, result: 'correct', feedback: 'Тоже правильный ход.', nextNodeId: successId },
            { id: `${params.lessonId}_partial`, text: params.partial, result: 'partial', feedback: 'Почти верно, но не хватает важного шага.', nextNodeId: partialId },
            { id: `${params.lessonId}_incorrect`, text: params.incorrect, result: 'incorrect', feedback: 'Это опасный выбор.', nextNodeId: incorrectId },
          ],
        },
        { id: successId, kind: 'story', body: { text: params.successText }, nextNodeId: endId },
        { id: partialId, kind: 'story', body: { text: params.partialText }, nextNodeId: endId },
        { id: incorrectId, kind: 'story', body: { text: params.incorrectText }, nextNodeId: endId },
        { id: endId, kind: 'end', text: 'Миссия завершена!' },
      ],
    },
  };
}

export function buildDecisionBranchingLesson(params: {
  lessonId: string;
  title: string;
  introText: string;
  decisionText: string;
  branchAText: string;
  branchBText: string;
}): DraftLessonDefinition {
  const introId = `${params.lessonId}_intro`;
  const decisionId = `${params.lessonId}_decision`;
  const branchAId = `${params.lessonId}_branch_a`;
  const branchBId = `${params.lessonId}_branch_b`;
  const branchAStoryId = `${params.lessonId}_branch_a_story`;
  const branchBStoryId = `${params.lessonId}_branch_b_story`;
  const endId = `${params.lessonId}_end`;

  return {
    id: params.lessonId,
    title: params.title,
    graph: {
      startNodeId: introId,
      nodes: [
        { id: introId, kind: 'story', body: { text: params.introText }, nextNodeId: decisionId },
        {
          id: decisionId,
          kind: 'decision',
          prompt: params.decisionText,
          options: [
            { id: branchAId, text: 'Сначала проверить факты', nextNodeId: branchAStoryId },
            { id: branchBId, text: 'Сразу принять решение', nextNodeId: branchBStoryId },
          ],
        },
        { id: branchAStoryId, kind: 'story', body: { text: params.branchAText }, nextNodeId: endId },
        { id: branchBStoryId, kind: 'story', body: { text: params.branchBText }, nextNodeId: endId },
        { id: endId, kind: 'end', text: 'Финал развилки' },
      ],
    },
  };
}

export async function createTeacherCourseWithDraft(
  page: Page,
  definition: CourseDraftDefinition,
): Promise<{ courseId: string; draftVersion: number }> {
  await page.goto('/teacher');

  const createResponse = await apiRequest<{ course_id?: string }>(
    page,
    'POST',
    '/teacher/courses',
    { title: definition.title, description: definition.description },
    { fallbackPath: '/teacher' },
  );
  expect(createResponse.status).toBeGreaterThanOrEqual(200);
  expect(createResponse.status).toBeLessThan(300);
  const courseId = createResponse.body?.course_id ?? '';
  expect(courseId).toBeTruthy();

  const draftResponse = await apiRequest<DraftResponse>(
    page,
    'GET',
    `/teacher/courses/${courseId}/draft`,
    undefined,
    { fallbackPath: '/teacher' },
  );
  expect(draftResponse.status).toBe(200);
  const draftVersion = draftResponse.body?.draft_version ?? 0;
  expect(draftVersion).toBeGreaterThan(0);

  const updateResponse = await apiRequest<{ draft_version?: number }>(
    page,
    'PUT',
    `/teacher/courses/${courseId}/draft`,
    buildDraftBody(draftResponse.body ?? {}, definition, draftVersion),
    { fallbackPath: '/teacher' },
  );
  expect(updateResponse.status).toBe(200);

  return {
    courseId,
    draftVersion: updateResponse.body?.draft_version ?? draftVersion,
  };
}

export async function submitTeacherCourseForReview(page: Page, courseId: string): Promise<void> {
  const response = await apiRequest(
    page,
    'POST',
    `/teacher/courses/${courseId}/submit-review`,
    {},
    { fallbackPath: '/teacher' },
  );
  expect(response.status).toBe(200);
}

export async function approveTeacherCourse(page: Page, courseId: string): Promise<string> {
  await page.goto('/admin/moderation');

  const queueResponse = await apiRequest<{ items?: Array<{ review_id?: string; course_id?: string }> } | Array<{ review_id?: string; course_id?: string }>>(
    page,
    'GET',
    '/admin/moderation/queue',
    undefined,
    { fallbackPath: '/admin/moderation' },
  );
  expect(queueResponse.status).toBe(200);

  const rawItems = Array.isArray(queueResponse.body)
    ? queueResponse.body
    : queueResponse.body?.items ?? [];
  const reviewId = rawItems.find(item => item.course_id === courseId)?.review_id ?? '';
  expect(reviewId).toBeTruthy();

  const approveResponse = await apiRequest(
    page,
    'POST',
    `/admin/moderation/reviews/${reviewId}/approve`,
    { comment: null },
    { fallbackPath: '/admin/moderation' },
  );
  expect(approveResponse.status).toBe(200);
  return reviewId;
}

export async function createTeacherAccessLink(page: Page, courseId: string): Promise<{ claimUrl: string; token: string }> {
  await page.goto('/teacher');
  const response = await apiRequest<{ invite_url?: string; claim_url?: string }>(
    page,
    'POST',
    `/teacher/courses/${courseId}/access-links`,
    {},
    { fallbackPath: '/teacher' },
  );
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  const claimUrl = response.body?.claim_url ?? response.body?.invite_url ?? '';
  expect(claimUrl).toBeTruthy();
  return { claimUrl, token: extractClaimToken(claimUrl) };
}

export async function createAdminCourseWithDraft(
  page: Page,
  definition: CourseDraftDefinition,
): Promise<{ courseId: string; draftVersion: number }> {
  await page.goto('/admin/courses');

  const createResponse = await apiRequest<{ course_id?: string }>(
    page,
    'POST',
    '/admin/courses',
    {
      title: definition.title,
      description: definition.description,
      age_min: definition.ageMin,
      age_max: definition.ageMax,
    },
    { fallbackPath: '/admin/courses' },
  );
  expect(createResponse.status).toBeGreaterThanOrEqual(200);
  expect(createResponse.status).toBeLessThan(300);
  const courseId = createResponse.body?.course_id ?? '';
  expect(courseId).toBeTruthy();

  const draftResponse = await apiRequest<DraftResponse>(
    page,
    'GET',
    `/admin/courses/${courseId}/draft`,
    undefined,
    { fallbackPath: '/admin/courses' },
  );
  expect(draftResponse.status).toBe(200);
  const draftVersion = draftResponse.body?.draft_version ?? 0;
  expect(draftVersion).toBeGreaterThan(0);

  const updateResponse = await apiRequest<{ draft_version?: number }>(
    page,
    'PUT',
    `/admin/courses/${courseId}/draft`,
    buildDraftBody(draftResponse.body ?? {}, definition, draftVersion),
    { fallbackPath: '/admin/courses' },
  );
  expect(updateResponse.status).toBe(200);

  return {
    courseId,
    draftVersion: updateResponse.body?.draft_version ?? draftVersion,
  };
}

export async function publishAdminCourse(page: Page, courseId: string): Promise<void> {
  const response = await apiRequest(page, 'POST', `/admin/courses/${courseId}/publish`, {}, { fallbackPath: '/admin/courses' });
  expect(response.status).toBe(200);
}
