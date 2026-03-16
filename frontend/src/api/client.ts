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

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new ApiRequestError(
      res.status,
      err?.error?.code ?? 'unknown',
      err?.error?.message ?? `HTTP ${res.status}`,
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
  return {
    invite_id: (raw.invite_id ?? '') as string,
    status: 'active' as const,
    invite_url: (raw.invite_url ?? raw.claim_url ?? '') as string,
    created_at: (raw.created_at ?? new Date().toISOString()) as string,
    expires_at: (raw.expires_at ?? '') as string,
  };
};
export const getLinkInvites = async (): Promise<import('./types').LinkInvite[]> => {
  const items = await getList<Record<string, unknown>>('/parent/children/link-invites');
  return items.map(i => ({
    ...i,
    invite_url: (i.invite_url ?? i.claim_url ?? '') as string,
  })) as import('./types').LinkInvite[];
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
export const updateTeacherDraft = (courseId: string, data: Partial<import('./types').CourseDraft> & { draft_version: number }) => {
  const body: Record<string, unknown> = { ...data };
  // Backend expects 'content' not 'content_json'
  if (body.content_json && !body.content) {
    body.content = body.content_json;
    delete body.content_json;
  }
  return put<{ draft_version: number }>(`/teacher/courses/${courseId}/draft`, body);
};
export const submitTeacherReview = (courseId: string) => post<void>(`/teacher/courses/${courseId}/submit-review`);
export const getTeacherReviewStatus = (courseId: string) => get<import('./types').ReviewStatus>(`/teacher/courses/${courseId}/review-status`);
export const createTeacherPreview = (courseId: string, lessonId: string) => post<import('./types').StepView>(`/teacher/courses/${courseId}/preview`, { lesson_id: lessonId });
export const createTeacherAccessLink = (courseId: string) => post<import('./types').AccessLink>(`/teacher/courses/${courseId}/access-links`);
export const getTeacherAccessLinks = (courseId: string) => getList<import('./types').AccessLink>(`/teacher/courses/${courseId}/access-links`);
export const revokeTeacherAccessLink = (linkId: string) => post<void>(`/teacher/access-links/${linkId}/revoke`);
export const getTeacherStudents = (courseId: string) => getList<import('./types').TeacherStudent>(`/teacher/courses/${courseId}/students`);
export const getTeacherStudentDetail = (courseId: string, studentId: string) => get<import('./types').TeacherStudentDetail>(`/teacher/courses/${courseId}/students/${studentId}`);
export const archiveTeacherCourse = (courseId: string) => post<void>(`/teacher/courses/${courseId}/archive`);
export const getTeacherProfile = () => get<import('./types').TeacherProfile>('/teacher/profile');
export const updateTeacherProfile = (data: { display_name: string; organization_name?: string }) => put<import('./types').TeacherProfile>('/teacher/profile', data);

// Preview (shared teacher+admin)
export const previewNext = (previewSessionId: string, stateVersion: number, expectedNodeId: string) => post<import('./types').StepView>(`/preview-sessions/${previewSessionId}/next`, { state_version: stateVersion, expected_node_id: expectedNodeId });
export const previewAnswer = (previewSessionId: string, body: { node_id: string; answer: unknown; state_version: number }) =>
  post<import('./types').AnswerOutcome>(`/preview-sessions/${previewSessionId}/answer`, body);

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
export const updateAdminDraft = (courseId: string, data: Partial<import('./types').CourseDraft> & { draft_version: number }) => {
  const body: Record<string, unknown> = { ...data };
  if (body.content_json && !body.content) {
    body.content = body.content_json;
    delete body.content_json;
  }
  return put<{ draft_version: number }>(`/admin/courses/${courseId}/draft`, body);
};
export const publishAdminCourse = (courseId: string) => post<void>(`/admin/courses/${courseId}/publish`);
export const createAdminPreview = (courseId: string, lessonId: string) => post<import('./types').StepView>(`/admin/courses/${courseId}/preview`, { lesson_id: lessonId });
export const createAdminAccessGrant = (courseId: string, studentId: string) => post<void>(`/admin/courses/${courseId}/access-grants`, { student_id: studentId });
export const getAdminUsers = async (params?: { role?: string }): Promise<import('./types').AdminUser[]> => {
  const items = await getList<Record<string, unknown>>(`/admin/users${params?.role ? `?role=${params.role}` : ''}`);
  return items.map(u => ({
    ...u,
    created_at: (u.created_at ?? u.registered_at ?? '') as string,
    status: (u.status ?? 'active') as 'active' | 'blocked',
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
export const getOffers = () => getList<import('./types').CommercialOffer>('/admin/commerce/offers');
export const createOffer = (data: Record<string, unknown>) => post<{ offer_id: string }>('/admin/commerce/offers', data);
export const updateOffer = (offerId: string, data: Record<string, unknown>) => put<void>(`/admin/commerce/offers/${offerId}`, data);
export const getPurchaseRequests = () => getList<import('./types').PurchaseRequest>('/admin/commerce/purchase-requests');
export const declinePurchaseRequest = (requestId: string) => post<void>(`/admin/commerce/purchase-requests/${requestId}/decline`);
export const getOrders = () => getList<import('./types').CommercialOrder>('/admin/commerce/orders');
export const createManualOrder = (data: Record<string, unknown>) => post<{ order_id: string }>('/admin/commerce/orders/manual', data);
export const confirmPayment = (orderId: string, data: Record<string, unknown>, idempotencyKey: string) =>
  post<void>(`/admin/commerce/orders/${orderId}/payments/manual-confirm`, data, { 'Idempotency-Key': idempotencyKey });
export const grantEntitlement = (data: Record<string, unknown>) => post<void>('/admin/commerce/entitlements/grants', data);
export const revokeEntitlement = (entitlementId: string) => post<void>(`/admin/commerce/entitlements/${entitlementId}/revoke`);
export const getAdminProfile = () => get<import('./types').AdminProfile>('/admin/profile');
export const updateAdminProfile = (data: { display_name: string }) => put<import('./types').AdminProfile>('/admin/profile', data);

// Assets
export const requestUpload = (data: { file_name: string; mime_type: string; size_bytes: number }) =>
  post<import('./types').UploadSlot>('/assets/upload-requests', data);
