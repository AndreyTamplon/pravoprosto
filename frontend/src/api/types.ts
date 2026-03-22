/* ===== Auth & Session ===== */
export type Role = 'unselected' | 'student' | 'parent' | 'teacher' | 'admin';

export interface SessionUser {
  account_id: string;
  role: Role;
  status: string;
}

export interface SessionOnboarding {
  role_selection_required: boolean;
  teacher_profile_required: boolean;
}

export interface SessionInfo {
  authenticated: boolean;
  csrf_token?: string;
  user: SessionUser | null;
  onboarding: SessionOnboarding;
}

/* ===== Profiles ===== */
export interface StudentProfile {
  account_id: string;
  display_name: string;
  avatar_url?: string;
  xp_total?: number;
  level?: number;
  current_streak_days?: number;
  best_streak_days?: number;
  completed_lessons?: number;
  active_courses?: { course_id: string; title: string; progress_percent: number }[];
  badges?: Badge[];
}

export interface ParentProfile {
  account_id: string;
  display_name: string;
  avatar_url?: string;
}

export interface TeacherProfile {
  account_id: string;
  display_name: string;
  organization_name?: string;
  avatar_url?: string;
}

export interface AdminProfile {
  account_id: string;
  display_name: string;
  avatar_url?: string;
}

/* ===== Courses ===== */
export interface CatalogCourse {
  course_id: string;
  title: string;
  description: string;
  cover_url?: string;
  course_kind: string;
  owner_kind: string;
  source_section: string;
  progress_percent: number;
  is_new: boolean;
  badges: string[];
}

export interface CatalogSection {
  section: string;
  title: string;
  items: CatalogCourse[];
}

export interface CatalogResponse {
  sections: CatalogSection[];
}

export interface CourseProgressSummary {
  status: 'in_progress' | 'completed' | 'abandoned';
  completed_lessons: number;
  total_lessons: number;
  last_activity_at: string;
}

export interface CourseTree {
  course_id: string;
  title: string;
  description: string;
  cover_url?: string;
  course_revision_id: string;
  modules: CourseModule[];
  progress?: CourseProgressSummary;
}

export interface CourseModule {
  module_id: string;
  title: string;
  lessons: LessonNode[];
}

export interface LessonNode {
  lesson_id: string;
  title: string;
  status: string;
  progress_percent: number;
  access: {
    access_state: LessonAccessState;
    lesson_id: string;
    offer?: LessonOffer | null;
    order?: unknown;
    support_hint?: string | null;
  };
}

export type LessonAccessState =
  | 'free'
  | 'locked_prerequisite'
  | 'locked_paid'
  | 'awaiting_payment_confirmation'
  | 'granted'
  | 'completed';

export interface LessonProgressInfo {
  status: 'not_started' | 'in_progress' | 'completed';
  best_verdict?: 'incorrect' | 'partial' | 'correct';
  attempts_count: number;
}

export interface LessonOffer {
  offer_id: string;
  price_amount_minor: number;
  price_currency: string;
  has_open_request: boolean;
}

/* ===== Lesson Runtime ===== */
export interface GameStateMini {
  xp_total: number;
  level: number;
  hearts_current: number;
  hearts_max: number;
  hearts_restore_at?: string | null;
}

export interface StepView {
  session_id: string;
  course_id: string;
  lesson_id: string;
  state_version: number;
  node_id: string;
  node_kind: string;
  payload: Record<string, unknown>;
  steps_completed: number;
  steps_total: number;
  progress_ratio: number;
  game_state: GameStateMini;
}

export interface AnswerOutcome {
  verdict: 'correct' | 'partial' | 'incorrect';
  feedback_text: string;
  xp_delta: number;
  hearts_delta: number;
  game_state: GameStateMini;
  next_action: string;
  next_node_id?: string;
  lesson_completion: Record<string, unknown> | null;
  next_step: StepView | null;
}

/* ===== Gamification ===== */
export interface GameState {
  xp_total: number;
  level: number;
  hearts_current: number;
  hearts_max: number;
  hearts_restore_at?: string | null;
  current_streak_days: number;
  best_streak_days: number;
  badges: Badge[];
}

export interface Badge {
  badge_code: string;
  awarded_at: string;
}

/* ===== Parent ===== */
export interface LinkedChild {
  student_id: string;
  display_name: string;
  avatar_url?: string;
  xp_total: number;
  current_streak_days: number;
  courses_in_progress: number;
  courses_completed: number;
  last_activity_at?: string;
}

export interface ChildProgress {
  student_id: string;
  display_name: string;
  xp_total: number;
  current_streak_days: number;
  accuracy_pct: number;
  courses: ChildCourseProgress[];
}

export interface ChildCourseProgress {
  course_id: string;
  title: string;
  status: string;
  completed_lessons: number;
  total_lessons: number;
  correct_answers: number;
  partial_answers: number;
  incorrect_answers: number;
  last_activity_at: string;
}

export interface LinkInvite {
  invite_id: string;
  status: 'active' | 'claimed' | 'expired' | 'revoked';
  invite_url: string;
  created_at: string;
  expires_at: string;
  claimed_by?: string;
}

/* ===== Teacher ===== */
export interface TeacherCourse {
  course_id: string;
  title: string;
  description: string;
  status: 'active' | 'archived';
  workflow_status: 'editing' | 'in_review' | 'changes_requested' | 'archived';
  has_published_revision: boolean;
  student_count: number;
  created_at: string;
  updated_at: string;
}

export interface CourseDraft {
  course_id: string;
  draft_version: number;
  title: string;
  description: string;
  age_min?: number;
  age_max?: number;
  cover_asset_id?: string;
  cover_url?: string;
  workflow_status: string;
  content_json: CourseContent;
  last_review_comment?: string;
  has_published_revision?: boolean;
}

export interface CourseContent {
  modules: ContentModule[];
}

export interface ContentModule {
  id: string;
  title: string;
  lessons: ContentLesson[];
}

export interface ContentLesson {
  id: string;
  title: string;
  graph: LessonGraph;
}

export interface LessonGraph {
  startNodeId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  type: 'story' | 'single_choice' | 'free_text' | 'terminal';
  data: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  condition?: string;
}

/**
 * Convert editor graph (type/data/edges) to backend format (kind/nextNodeId/options/transitions).
 */
export function graphToBackendFormat(graph: LessonGraph): Record<string, unknown> {
  const { startNodeId, nodes, edges } = graph;

  // Build edge map: fromId -> toId (for simple linear edges)
  const edgeMap = new Map<string, string>();
  for (const e of edges) {
    edgeMap.set(e.from, e.to);
  }

  const backendNodes: Record<string, unknown>[] = nodes.map(node => {
    const nextNodeId = edgeMap.get(node.id) ?? '';
    const kind = node.type === 'terminal' ? 'end' : node.type;

    if (kind === 'story') {
      return {
        id: node.id,
        kind,
        nextNodeId,
        text: (node.data.text as string) ?? '',
        asset_url: (node.data.illustration_url as string) ?? '',
      };
    }

    if (kind === 'single_choice') {
      const opts = (node.data.options as Array<{ option_id?: string; id?: string; text: string; is_correct?: boolean }>) ?? [];
      const correctId = (node.data.correct_option_id as string) ?? '';
      const feedbackCorrect = (node.data.feedback_correct as string) ?? '';
      const feedbackIncorrect = (node.data.feedback_incorrect as string) ?? '';
      return {
        id: node.id,
        kind,
        prompt: (node.data.question_text as string) ?? '',
        options: opts.map(o => {
          const optId = o.option_id ?? o.id ?? '';
          const isCorrect = o.is_correct ?? (optId === correctId);
          return {
            id: optId,
            text: o.text,
            result: isCorrect ? 'correct' : 'incorrect',
            feedback: isCorrect ? feedbackCorrect : feedbackIncorrect,
            nextNodeId,
          };
        }),
      };
    }

    if (kind === 'free_text') {
      return {
        id: node.id,
        kind,
        prompt: (node.data.question_text as string) ?? '',
        rubric: {
          reference_answer: (node.data.reference_answer ?? node.data.expected_answer ?? '') as string,
          criteria: (node.data.criteria as string) ?? '',
        },
        transitions: [
          { onVerdict: 'correct', nextNodeId },
          { onVerdict: 'partial', nextNodeId },
          { onVerdict: 'incorrect', nextNodeId },
        ],
      };
    }

    // end node
    return {
      id: node.id,
      kind: 'end',
    };
  });

  return { startNodeId, nodes: backendNodes };
}

/**
 * Convert backend graph format back to editor format for editing.
 */
export function graphFromBackendFormat(raw: Record<string, unknown>): LessonGraph {
  const startNodeId = (raw.startNodeId as string) ?? '';
  const rawNodes = (raw.nodes as Array<Record<string, unknown>>) ?? [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const rn of rawNodes) {
    const id = (rn.id as string) ?? '';
    const kind = (rn.kind as string) ?? (rn.type as string) ?? 'story';
    const type = kind === 'end' ? 'terminal' : kind as GraphNode['type'];
    const data: Record<string, unknown> = {};

    if (kind === 'story') {
      data.text = (rn.text as string) ?? '';
      data.illustration_url = (rn.asset_url as string) ?? '';
      const nextNodeId = (rn.nextNodeId as string) ?? '';
      if (nextNodeId) edges.push({ from: id, to: nextNodeId });
    } else if (kind === 'single_choice') {
      data.question_text = (rn.prompt as string) ?? '';
      const opts = (rn.options as Array<Record<string, unknown>>) ?? [];
      let correctId = '';
      data.options = opts.map(o => {
        const optId = (o.id as string) ?? '';
        if ((o.result as string) === 'correct') correctId = optId;
        return { option_id: optId, text: (o.text as string) ?? '' };
      });
      data.correct_option_id = correctId;
      data.feedback_correct = opts.find(o => (o.result as string) === 'correct')?.feedback ?? '';
      data.feedback_incorrect = opts.find(o => (o.result as string) !== 'correct')?.feedback ?? '';
      // All options point to same nextNodeId
      const nextId = (opts[0]?.nextNodeId as string) ?? '';
      if (nextId) edges.push({ from: id, to: nextId });
    } else if (kind === 'free_text') {
      data.question_text = (rn.prompt as string) ?? '';
      const rubric = (rn.rubric as Record<string, unknown>) ?? {};
      data.reference_answer = (rubric.reference_answer as string) ?? '';
      data.criteria = (rubric.criteria as string) ?? '';
      const transitions = (rn.transitions as Array<Record<string, unknown>>) ?? [];
      const correctTransition = transitions.find(t => (t.onVerdict as string) === 'correct');
      const nextId = (correctTransition?.nextNodeId as string) ?? '';
      if (nextId) edges.push({ from: id, to: nextId });
    }

    nodes.push({ id, type, data });
  }

  return { startNodeId, nodes, edges };
}

export interface TeacherStudent {
  student_id: string;
  display_name: string;
  avatar_url?: string;
  progress_pct: number;
  xp_earned: number;
  accuracy_pct: number;
  last_activity_at: string;
}

export interface TeacherStudentDetail {
  student_id: string;
  display_name: string;
  lessons: TeacherStudentLesson[];
}

export interface TeacherStudentLesson {
  lesson_id: string;
  title: string;
  status: string;
  best_verdict?: string;
  attempts_count: number;
  last_activity_at?: string;
}

export interface ReviewStatus {
  review_id?: string;
  status: 'none' | 'pending' | 'approved' | 'rejected';
  review_comment?: string;
  submitted_at?: string;
  resolved_at?: string;
}

export interface AccessLink {
  link_id: string;
  status: 'active' | 'expired' | 'revoked';
  invite_url: string;
  created_at: string;
  expires_at?: string;
}

/* ===== Admin ===== */
export interface AdminCourse {
  course_id: string;
  title: string;
  owner_kind: 'platform' | 'teacher';
  course_kind: string;
  status: string;
  has_published_revision: boolean;
  lesson_count: number;
  student_count: number;
  created_at: string;
}

export interface AdminUser {
  account_id: string;
  role: Role;
  status: 'active' | 'blocked';
  display_name: string;
  email?: string;
  xp_total?: number;
  created_at: string;
  last_activity_at?: string;
}

export interface PendingReview {
  review_id: string;
  course_id: string;
  course_title: string;
  teacher_name: string;
  submitted_at: string;
  draft_version: number;
}

/* ===== Commerce ===== */
export interface CommercialOffer {
  offer_id: string;
  target_type: 'course' | 'lesson';
  target_course_id: string;
  target_lesson_id?: string;
  course_title?: string;
  lesson_title?: string;
  title: string;
  description: string;
  price_amount_minor: number;
  price_currency: string;
  status: 'draft' | 'active' | 'archived';
  created_at: string;
}

export interface PurchaseRequest {
  request_id: string;
  student_id: string;
  student_name: string;
  offer_id: string;
  offer_title: string;
  target_type: string;
  status: 'open' | 'processed' | 'declined';
  created_at: string;
}

export interface CommercialOrder {
  order_id: string;
  student_id: string;
  student_name: string;
  offer_title: string;
  target_type: string;
  status: 'awaiting_confirmation' | 'fulfilled' | 'canceled';
  price_amount_minor: number;
  price_currency: string;
  created_at: string;
  fulfilled_at?: string;
}

/* ===== Promo ===== */
export interface PromoCourse {
  course_id: string;
  title: string;
  description: string;
  cover_url?: string;
  age_min?: number;
  age_max?: number;
  lesson_count: number;
}

/* ===== Assets ===== */
export interface UploadSlot {
  asset_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
}

/* ===== Error ===== */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
