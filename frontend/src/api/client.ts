import type { ApiError } from './types';

const BASE = '/api/v1';

let csrfToken: string | null = null;

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function translateApiMessage(status: number, code: string, message: string): string {
  if (code === 'bad_request' && message === 'Invalid JSON body') {
    return 'Форма содержит некорректные данные.';
  }
  if (code === 'bad_request' && message === 'Missing external_reference') {
    return 'Укажите внешний идентификатор оплаты.';
  }
  if (code === 'draft_validation_failed') {
    return 'Черновик содержит ошибки валидации.';
  }
  if (code === 'draft_version_conflict') {
    return 'Черновик был изменён в другой вкладке. Обновите страницу и повторите попытку.';
  }
  if (code === 'course_not_found') {
    return 'Курс не найден.';
  }
  if (code === 'review_not_found') {
    return 'Проверка не найдена.';
  }
  if (code === 'preview_session_not_found') {
    return 'Сессия предпросмотра не найдена или уже истекла.';
  }
  if (code === 'preview_session_state_conflict') {
    return 'Состояние предпросмотра устарело. Обновите страницу и попробуйте снова.';
  }
  if (code === 'invalid_preview_action') {
    return 'Это действие недоступно для текущего шага предпросмотра.';
  }
  if (code === 'llm_temporarily_unavailable') {
    return 'Проверка ответа временно недоступна. Попробуйте позже.';
  }
  if (code === 'manual_payment_mismatch') {
    return 'Сумма или валюта оплаты не совпадают с заказом. Укажите причину вручную.';
  }
  if (code === 'forbidden') {
    return 'Недостаточно прав для этого действия.';
  }
  if (status >= 500 && message === 'Internal server error') {
    return 'Внутренняя ошибка сервера.';
  }
  return message;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as ApiError | null;
    const code = err?.error?.code ?? 'unknown';
    const message = translateApiMessage(
      res.status,
      code,
      err?.error?.message ?? `HTTP ${res.status}`,
    );
    throw new ApiRequestError(
      res.status,
      code,
      message,
      err?.error?.details ?? undefined,
    );
  }
  return body as T;
}

function headers(mutating: boolean, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...extra,
  };
  if (mutating && csrfToken) {
    h['X-CSRF-Token'] = csrfToken;
  }
  return h;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: headers(false),
    cache: 'no-store',
  });
  return handleResponse<T>(res);
}

/**
 * GET a list endpoint that returns { items: T[] } and unwrap it.
 */
async function getList<T>(path: string, key = 'items'): Promise<T[]> {
  const raw = await get<Record<string, unknown>>(path);
  const arr = (raw as Record<string, unknown>)?.[key];
  return (Array.isArray(arr) ? arr : []) as T[];
}

function normalizeLinkInvite(raw: Record<string, unknown>): import('./types').LinkInvite {
  const inviteURL = (raw.invite_url ?? raw.claim_url) as string | undefined;
  return {
    invite_id: (raw.invite_id ?? '') as string,
    status: (raw.status ?? 'active') as import('./types').LinkInvite['status'],
    invite_url: inviteURL && inviteURL.trim() !== '' ? inviteURL : undefined,
    claim_url: (raw.claim_url as string) ?? undefined,
    url_status: (raw.url_status ?? (inviteURL ? 'available' : 'legacy_unavailable')) as import('./types').LinkInvite['url_status'],
    created_at: (raw.created_at as string) ?? undefined,
    expires_at: (raw.expires_at ?? '') as string,
    claimed_by: (raw.claimed_by as string) ?? undefined,
  };
}

function normalizeAccessLink(raw: Record<string, unknown>): import('./types').AccessLink {
  const inviteURL = (raw.invite_url ?? raw.claim_url) as string | undefined;
  return {
    link_id: (raw.link_id ?? '') as string,
    status: (raw.status ?? 'active') as import('./types').AccessLink['status'],
    invite_url: inviteURL && inviteURL.trim() !== '' ? inviteURL : undefined,
    claim_url: (raw.claim_url as string) ?? undefined,
    url_status: (raw.url_status ?? (inviteURL ? 'available' : 'legacy_unavailable')) as import('./types').AccessLink['url_status'],
    created_at: (raw.created_at as string) ?? undefined,
    expires_at: (raw.expires_at as string) ?? undefined,
  };
}

function normalizePreviewStep(raw: Record<string, unknown>): import('./types').PreviewStepView {
  return {
    session_id: (raw.session_id ?? '') as string,
    course_id: (raw.course_id ?? '') as string,
    lesson_id: (raw.lesson_id ?? '') as string,
    state_version: (raw.state_version ?? 0) as number,
    node_id: (raw.node_id ?? '') as string,
    node_kind: (raw.node_kind ?? '') as string,
    payload: ((raw.payload as Record<string, unknown>) ?? {}),
    steps_completed: (raw.steps_completed ?? 0) as number,
    steps_total: (raw.steps_total ?? 0) as number,
    progress_ratio: (raw.progress_ratio ?? 0) as number,
  };
}

function normalizePreviewSession(raw: Record<string, unknown>): import('./types').PreviewSessionView {
  const step = normalizePreviewStep((raw.step ?? {}) as Record<string, unknown>);
  return {
    preview: true,
    preview_session_id: (raw.preview_session_id ?? step.session_id ?? '') as string,
    return_path: (raw.return_path as string) ?? undefined,
    step,
  };
}

function normalizeTeacherStudentDetail(raw: Record<string, unknown>): import('./types').TeacherStudentDetail {
  const student = (raw.student ?? {}) as Record<string, unknown>;
  const summary = (raw.summary ?? {}) as Record<string, unknown>;
  const lessons = ((raw.lessons ?? []) as Array<Record<string, unknown>>).map(lesson => ({
    lesson_id: (lesson.lesson_id ?? '') as string,
    title: (lesson.title ?? '') as string,
    status: (lesson.status ?? 'not_started') as string,
    best_verdict: (lesson.best_verdict as string) ?? undefined,
    attempts_count: (lesson.attempts_count ?? 0) as number,
    last_activity_at: (lesson.last_activity_at as string) ?? undefined,
  }));
  return {
    student: {
      student_id: (student.student_id ?? raw.student_id ?? '') as string,
      display_name: (student.display_name ?? raw.display_name ?? '') as string,
      avatar_url: (student.avatar_url as string) ?? undefined,
    },
    summary: {
      progress_percent: (summary.progress_percent ?? raw.progress_percent ?? 0) as number,
      xp_total: (summary.xp_total ?? raw.xp_total ?? 0) as number,
      correctness_percent: (summary.correctness_percent ?? raw.correctness_percent ?? 0) as number,
    },
    lessons,
  };
}

function buildDraftBody(data: import('./types').UpdateDraftInput): Record<string, unknown> {
  return {
    draft_version: data.draft_version,
    title: data.title,
    description: data.description,
    age_min: data.age_min,
    age_max: data.age_max,
    cover_asset_id: data.cover_asset_id,
    content: data.content_json,
  };
}

export async function post<T>(path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: headers(true, extra),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: headers(true),
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: headers(true),
  });
  return handleResponse<T>(res);
}

/* ===== Specific API calls ===== */

// Session
export const getSession = () => get<import('./types').SessionInfo>('/session');

// Auth
export const logout = () => post<void>('/auth/logout');

// Onboarding
export const selectRole = (role: string) => post<void>('/onboarding/role', { role });

// Public
export const getPromoCourses = () => getList<import('./types').PromoCourse>('/public/promo-courses');

// Student
export const getStudentCatalog = () => get<import('./types').CatalogResponse>('/student/catalog');
export const getGameState = () => get<import('./types').GameState>('/student/game-state');
export const getCourseTree = (courseId: string) => get<import('./types').CourseTree>(`/student/courses/${courseId}`);
export const startLesson = (courseId: string, lessonId: string) => post<import('./types').StepView>(`/student/courses/${courseId}/lessons/${lessonId}/start`);
export const getLessonSession = (courseId: string, lessonId: string) => get<import('./types').StepView>(`/student/courses/${courseId}/lessons/${lessonId}/session`);
export const getSessionById = (sessionId: string) => get<import('./types').StepView>(`/student/lesson-sessions/${sessionId}`);
export const nextStep = (sessionId: string, stateVersion: number, expectedNodeId: string) => post<import('./types').StepView>(`/student/lesson-sessions/${sessionId}/next`, { state_version: stateVersion, expected_node_id: expectedNodeId });
export const submitAnswer = (sessionId: string, body: { node_id: string; answer: unknown; state_version: number }, idempotencyKey: string) =>
  post<import('./types').AnswerOutcome>(`/student/lesson-sessions/${sessionId}/answer`, body, { 'Idempotency-Key': idempotencyKey });
export const retryLesson = (courseId: string, lessonId: string) => post<import('./types').StepView>(`/student/courses/${courseId}/lessons/${lessonId}/retry`);
export const claimGuardianLink = (token: string) => post<void>('/student/guardian-links/claim', { token });
export const claimCourseLink = (token: string) => post<void>('/student/course-links/claim', { token });
export const createPurchaseRequest = (offerId: string) => post<void>(`/student/offers/${offerId}/purchase-requests`);
export const getStudentProfile = () => get<import('./types').StudentProfile>('/student/profile');
export const updateStudentProfile = (data: { display_name: string }) => put<import('./types').StudentProfile>('/student/profile', data);

// Parent
export const getChildren = async (): Promise<import('./types').LinkedChild[]> => {
  const items = await getList<Record<string, unknown>>('/parent/children', 'children');
  return items.map(c => ({
    ...c,
    courses_in_progress: (c.courses_in_progress ?? 0) as number,
    courses_completed: (c.courses_completed ?? c.completed_lessons ?? 0) as number,
  })) as import('./types').LinkedChild[];
};
export const createLinkInvite = async (): Promise<import('./types').LinkInvite> => {
  const raw = await post<Record<string, unknown>>('/parent/children/link-invites');
  return normalizeLinkInvite(raw);
};
export const getLinkInvites = async (): Promise<import('./types').LinkInvite[]> => {
  const items = await getList<Record<string, unknown>>('/parent/children/link-invites');
  return items.map(normalizeLinkInvite);
};
export const revokeLinkInvite = (inviteId: string) => post<void>(`/parent/children/link-invites/${inviteId}/revoke`);
export const getChildProgress = async (studentId: string): Promise<import('./types').ChildProgress> => {
  const raw = await get<Record<string, unknown>>(`/parent/children/${studentId}/progress`);
  const student = (raw.student ?? {}) as Record<string, unknown>;
  const summary = (raw.summary ?? {}) as Record<string, unknown>;
  const rawCourses = (raw.courses ?? []) as Record<string, unknown>[];
  const courses: import('./types').ChildCourseProgress[] = rawCourses.map(c => ({
    course_id: (c.course_id ?? '') as string,
    title: (c.title ?? '') as string,
    status: (c.status ?? ((c.progress_percent as number) >= 100 ? 'completed' : 'in_progress')) as string,
    completed_lessons: (c.completed_lessons ?? 0) as number,
    total_lessons: (c.total_lessons ?? 0) as number,
    correct_answers: (c.correct_answers ?? 0) as number,
    partial_answers: (c.partial_answers ?? 0) as number,
    incorrect_answers: (c.incorrect_answers ?? 0) as number,
    last_activity_at: (c.last_activity_at ?? '') as string,
  }));
  return {
    student_id: (student.student_id ?? raw.student_id ?? '') as string,
    display_name: (student.display_name ?? raw.display_name ?? '') as string,
    xp_total: (summary.xp_total ?? raw.xp_total ?? 0) as number,
    current_streak_days: (summary.current_streak_days ?? raw.current_streak_days ?? 0) as number,
    accuracy_pct: (summary.correctness_percent ?? summary.accuracy_pct ?? raw.accuracy_pct ?? 0) as number,
    courses,
  };
};
export const getParentPaidOffers = (studentId: string) =>
  getList<import('./types').ParentPaidOffer>(`/parent/children/${studentId}/commerce/offers`);
export const startParentCheckout = (studentId: string, offerId: string) =>
  post<import('./types').ParentCheckoutResponse>(`/parent/children/${studentId}/commerce/offers/${offerId}/checkout`, {});
export const getParentProfile = () => get<import('./types').ParentProfile>('/parent/profile');
export const updateParentProfile = (data: { display_name: string }) => put<import('./types').ParentProfile>('/parent/profile', data);

// Teacher
export const getTeacherCourses = async (): Promise<import('./types').TeacherCourse[]> => {
  const items = await getList<Record<string, unknown>>('/teacher/courses');
  return items.map(c => ({
    ...c,
    student_count: (c.students_count ?? c.student_count ?? 0) as number,
    has_published_revision: !!(c.has_published_revision ?? c.published_revision_id),
    status: (c.status ?? (c.workflow_status === 'archived' ? 'archived' : 'active')) as 'active' | 'archived',
  })) as import('./types').TeacherCourse[];
};
export const createTeacherCourse = (data: { title: string; description: string }) => post<{ course_id: string }>('/teacher/courses', data);
export const getTeacherDraft = async (courseId: string): Promise<import('./types').CourseDraft> => {
  const raw = await get<Record<string, unknown>>(`/teacher/courses/${courseId}/draft`);
  const content = (raw.content_json ?? raw.content ?? { modules: [] }) as import('./types').CourseContent;
  return {
    ...raw,
    content_json: content,
    has_published_revision: !!(raw.has_published_revision ?? raw.last_published_revision_id),
  } as import('./types').CourseDraft;
};
export const updateTeacherDraft = (courseId: string, data: import('./types').UpdateDraftInput) =>
  put<{ draft_version: number }>(`/teacher/courses/${courseId}/draft`, buildDraftBody(data));
export const submitTeacherReview = (courseId: string) => post<void>(`/teacher/courses/${courseId}/submit-review`);
export const getTeacherReviewStatus = async (courseId: string): Promise<import('./types').ReviewStatus> => {
  const raw = await get<Record<string, unknown>>(`/teacher/courses/${courseId}/review-status`);
  const current = (raw.current as Record<string, unknown> | null) ?? null;
  if (!current) {
    return { status: 'none' };
  }
  return {
    review_id: (current.review_id as string) ?? undefined,
    status: ((current.status ?? 'none') as import('./types').ReviewStatus['status']),
    review_comment: (current.review_comment as string) ?? undefined,
    submitted_at: (current.submitted_at as string) ?? undefined,
    resolved_at: (current.resolved_at as string) ?? undefined,
  };
};
export const createTeacherPreview = async (
  courseId: string,
  lessonId: string,
  returnPath?: string,
): Promise<import('./types').PreviewSessionView> => {
  const raw = await post<Record<string, unknown>>(`/teacher/courses/${courseId}/preview`, { lesson_id: lessonId, return_path: returnPath });
  return normalizePreviewSession(raw);
};
export const createTeacherAccessLink = async (courseId: string): Promise<import('./types').AccessLink> => {
  const raw = await post<Record<string, unknown>>(`/teacher/courses/${courseId}/access-links`, {});
  return normalizeAccessLink(raw);
};
export const getTeacherAccessLinks = async (courseId: string): Promise<import('./types').AccessLink[]> => {
  const items = await getList<Record<string, unknown>>(`/teacher/courses/${courseId}/access-links`);
  return items.map(normalizeAccessLink);
};
export const revokeTeacherAccessLink = (linkId: string) => post<void>(`/teacher/access-links/${linkId}/revoke`);
export const getTeacherStudents = async (courseId: string): Promise<import('./types').TeacherStudent[]> => {
  const items = await getList<Record<string, unknown>>(`/teacher/courses/${courseId}/students`, 'students');
  return items.map(s => ({
    student_id: (s.student_id ?? '') as string,
    display_name: (s.display_name ?? '') as string,
    avatar_url: (s.avatar_url as string) ?? undefined,
    progress_pct: (s.progress_percent ?? s.progress_pct ?? 0) as number,
    xp_earned: (s.xp_total ?? s.xp_earned ?? 0) as number,
    accuracy_pct: (s.correctness_percent ?? s.accuracy_pct ?? 0) as number,
    last_activity_at: (s.last_activity_at ?? '') as string,
  }));
};
export const getTeacherStudentDetail = async (courseId: string, studentId: string): Promise<import('./types').TeacherStudentDetail> => {
  const raw = await get<Record<string, unknown>>(`/teacher/courses/${courseId}/students/${studentId}`);
  return normalizeTeacherStudentDetail(raw);
};
export const archiveTeacherCourse = (courseId: string) => post<void>(`/teacher/courses/${courseId}/archive`);
export const getTeacherProfile = () => get<import('./types').TeacherProfile>('/teacher/profile');
export const updateTeacherProfile = (data: { display_name: string; organization_name?: string }) => put<import('./types').TeacherProfile>('/teacher/profile', data);

// Preview (shared teacher+admin)
export const getPreviewSession = async (previewSessionId: string): Promise<import('./types').PreviewSessionView> => {
  const raw = await get<Record<string, unknown>>(`/preview-sessions/${previewSessionId}`);
  return normalizePreviewSession(raw);
};
export const previewNext = async (previewSessionId: string, stateVersion: number, expectedNodeId: string): Promise<import('./types').PreviewSessionView> => {
  const raw = await post<Record<string, unknown>>(`/preview-sessions/${previewSessionId}/next`, { state_version: stateVersion, expected_node_id: expectedNodeId });
  return normalizePreviewSession(raw);
};
export const previewAnswer = async (previewSessionId: string, body: { node_id: string; answer: unknown; state_version: number }): Promise<import('./types').PreviewAnswerView> => {
  const raw = await post<Record<string, unknown>>(`/preview-sessions/${previewSessionId}/answer`, body);
  return {
    preview: true,
    verdict: (raw.verdict ?? 'incorrect') as import('./types').PreviewAnswerView['verdict'],
    feedback_text: (raw.feedback_text ?? '') as string,
    next_step: raw.next_step ? normalizePreviewStep(raw.next_step as Record<string, unknown>) : null,
  };
};

// Admin
export const getAdminCourses = async (): Promise<import('./types').AdminCourse[]> => {
  const items = await getList<Record<string, unknown>>('/admin/courses');
  return items.map(c => ({
    ...c,
    has_published_revision: !!(c.has_published_revision ?? c.current_revision_id),
    student_count: (c.student_count ?? c.students_count ?? 0) as number,
    lesson_count: (c.lesson_count ?? c.lessons_count ?? 0) as number,
    status: (c.status ?? (c.current_revision_id ? 'published' : 'draft')) as string,
    created_at: (c.created_at ?? c.updated_at ?? '') as string,
  })) as import('./types').AdminCourse[];
};
export const createAdminCourse = (data: { title: string; description: string }) => post<{ course_id: string }>('/admin/courses', data);
export const getAdminDraft = async (courseId: string): Promise<import('./types').CourseDraft> => {
  const raw = await get<Record<string, unknown>>(`/admin/courses/${courseId}/draft`);
  const content = (raw.content_json ?? raw.content ?? { modules: [] }) as import('./types').CourseContent;
  return { ...raw, content_json: content } as import('./types').CourseDraft;
};
export const getModerationReviewDraft = async (reviewId: string): Promise<import('./types').CourseDraft> => {
  const raw = await get<Record<string, unknown>>(`/admin/moderation/reviews/${reviewId}/draft`);
  const content = (raw.content_json ?? raw.content ?? { modules: [] }) as import('./types').CourseContent;
  return { ...raw, content_json: content } as import('./types').CourseDraft;
};
export const updateAdminDraft = (courseId: string, data: import('./types').UpdateDraftInput) =>
  put<{ draft_version: number }>(`/admin/courses/${courseId}/draft`, buildDraftBody(data));
export const publishAdminCourse = (courseId: string) => post<void>(`/admin/courses/${courseId}/publish`);
export const createAdminPreview = async (
  courseId: string,
  lessonId: string,
  returnPath?: string,
): Promise<import('./types').PreviewSessionView> => {
  const raw = await post<Record<string, unknown>>(`/admin/courses/${courseId}/preview`, { lesson_id: lessonId, return_path: returnPath });
  return normalizePreviewSession(raw);
};
export const createModerationPreview = async (
  reviewId: string,
  lessonId: string,
  returnPath?: string,
): Promise<import('./types').PreviewSessionView> => {
  const raw = await post<Record<string, unknown>>(`/admin/moderation/reviews/${reviewId}/preview`, { lesson_id: lessonId, return_path: returnPath });
  return normalizePreviewSession(raw);
};
export const createAdminAccessGrant = (courseId: string, studentId: string) => post<void>(`/admin/courses/${courseId}/access-grants`, { student_id: studentId });
export const getAdminUsers = async (params?: { role?: string }): Promise<import('./types').AdminUser[]> => {
  const items = await getList<Record<string, unknown>>(`/admin/users${params?.role ? `?role=${params.role}` : ''}`);
  return items.map(u => ({
    ...u,
    created_at: (u.created_at ?? u.registered_at ?? '') as string,
    status: (u.status ?? 'active') as 'active' | 'blocked',
    email: (u.email as string) ?? undefined,
  })) as import('./types').AdminUser[];
};
export const getAdminUser = (userId: string) => get<import('./types').AdminUser>(`/admin/users/${userId}`);
export const blockUser = (userId: string) => post<void>(`/admin/users/${userId}/block`);
export const unblockUser = (userId: string) => post<void>(`/admin/users/${userId}/unblock`);
export const getModerationQueue = async (): Promise<import('./types').PendingReview[]> => {
  const items = await getList<Record<string, unknown>>('/admin/moderation/queue');
  return items.map(r => ({
    ...r,
    course_title: (r.course_title ?? r.title ?? '') as string,
    teacher_name: (r.teacher_name ?? (r.teacher as Record<string, unknown>)?.display_name ?? '') as string,
    draft_version: (r.draft_version ?? 1) as number,
  })) as import('./types').PendingReview[];
};
export const approveReview = (reviewId: string, comment?: string) => post<void>(`/admin/moderation/reviews/${reviewId}/approve`, { comment: comment ?? null });
export const rejectReview = (reviewId: string, comment: string) => post<void>(`/admin/moderation/reviews/${reviewId}/reject`, { comment });

// Commerce (admin)
export const getOffers = async (): Promise<import('./types').CommercialOffer[]> => {
  const items = await getList<Record<string, unknown>>('/admin/commerce/offers');
  return items.map(o => ({
    offer_id: (o.offer_id ?? '') as string,
    target_type: (o.target_type ?? 'course') as 'course' | 'lesson',
    target_course_id: (o.target_course_id ?? '') as string,
    target_lesson_id: (o.target_lesson_id ?? undefined) as string | undefined,
    course_title: (o.course_title ?? undefined) as string | undefined,
    lesson_title: (o.lesson_title ?? undefined) as string | undefined,
    title: (o.title ?? '') as string,
    description: (o.description ?? '') as string,
    price_amount_minor: Number(o.price_amount_minor ?? 0),
    price_currency: (o.price_currency ?? o.currency ?? 'RUB') as string,
    status: (o.status ?? 'draft') as 'draft' | 'active' | 'archived',
    created_at: (o.created_at ?? new Date().toISOString()) as string,
  }));
};
export const createOffer = (data: Record<string, unknown>) => post<{ offer_id: string }>('/admin/commerce/offers', data);
export const updateOffer = (offerId: string, data: Record<string, unknown>) => put<void>(`/admin/commerce/offers/${offerId}`, data);
export const getPurchaseRequests = async (): Promise<import('./types').PurchaseRequest[]> => {
  const items = await getList<Record<string, unknown>>('/admin/commerce/purchase-requests');
  return items.map(r => {
    const student = (r.student ?? {}) as Record<string, unknown>;
    const offer = (r.offer ?? {}) as Record<string, unknown>;
    return {
      request_id: (r.purchase_request_id ?? r.request_id ?? '') as string,
      student_id: (student.account_id ?? r.student_id ?? '') as string,
      student_name: (student.display_name ?? r.student_name ?? '') as string,
      offer_id: (offer.offer_id ?? r.offer_id ?? '') as string,
      offer_title: (offer.title ?? r.offer_title ?? '') as string,
      target_type: (r.target_type ?? '') as string,
      status: (r.status ?? 'open') as 'open' | 'processed' | 'declined',
      created_at: (r.created_at ?? '') as string,
    };
  });
};
export const declinePurchaseRequest = (requestId: string) => post<void>(`/admin/commerce/purchase-requests/${requestId}/decline`);
export const getOrders = async (): Promise<import('./types').CommercialOrder[]> => {
  const items = await getList<Record<string, unknown>>('/admin/commerce/orders');
  return items.map(o => {
    const student = (o.student ?? {}) as Record<string, unknown>;
    const offer = (o.offer ?? {}) as Record<string, unknown>;
    return {
      order_id: (o.order_id ?? '') as string,
      student_id: (student.account_id ?? o.student_id ?? '') as string,
      student_name: (student.display_name ?? o.student_name ?? '') as string,
      offer_title: (offer.title ?? o.offer_title ?? '') as string,
      target_type: (o.target_type ?? '') as string,
      status: (o.status ?? 'awaiting_confirmation') as 'awaiting_confirmation' | 'fulfilled' | 'canceled',
      price_amount_minor: Number(o.price_amount_minor ?? 0),
      price_currency: (o.price_currency ?? o.currency ?? 'RUB') as string,
      created_at: (o.created_at ?? '') as string,
      fulfilled_at: (o.fulfilled_at as string) ?? undefined,
    };
  });
};
export const createManualOrder = (data: import('./types').ManualOrderInput) => post<{ order_id: string }>('/admin/commerce/orders/manual', data);
export const confirmPayment = (orderId: string, data: Record<string, unknown>, idempotencyKey: string) =>
  post<void>(`/admin/commerce/orders/${orderId}/payments/manual-confirm`, data, { 'Idempotency-Key': idempotencyKey });
export const grantEntitlement = (data: Record<string, unknown>) => post<void>('/admin/commerce/entitlements/grants', data);
export const revokeEntitlement = (entitlementId: string) => post<void>(`/admin/commerce/entitlements/${entitlementId}/revoke`);
export const getAdminProfile = () => get<import('./types').AdminProfile>('/admin/profile');
export const updateAdminProfile = (data: { display_name: string }) => put<import('./types').AdminProfile>('/admin/profile', data);

// Assets
export const requestUpload = (data: { file_name: string; mime_type: string; size_bytes: number }) =>
  post<import('./types').UploadSlot>('/assets/upload-requests', data);
