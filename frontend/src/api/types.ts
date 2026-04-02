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

export interface PreviewStepView {
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
}

export interface PreviewSessionView {
  preview: true;
  preview_session_id: string;
  return_path?: string;
  step: PreviewStepView;
}

export interface PreviewAnswerView {
  preview: true;
  verdict: 'correct' | 'partial' | 'incorrect';
  feedback_text: string;
  next_step: PreviewStepView | null;
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

export interface ParentPaidOffer {
  offer_id: string;
  title: string;
  description: string;
  target_type: 'course' | 'lesson';
  target_course_id: string;
  target_lesson_id?: string;
  course_title?: string;
  lesson_title?: string;
  price_amount_minor: number;
  price_currency: string;
  access_state: 'locked_paid' | 'awaiting_payment_confirmation' | 'granted';
  order_id?: string;
  payment_url?: string;
}

export interface ParentCheckoutResponse {
  order_id: string;
  access_state: 'awaiting_payment_confirmation';
  payment_url: string;
  payment_id?: string;
}

export interface LinkInvite {
  invite_id: string;
  status: 'active' | 'claimed' | 'expired' | 'revoked';
  invite_url?: string;
  claim_url?: string;
  url_status: 'available' | 'legacy_unavailable';
  created_at?: string;
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

export type GraphVerdict = 'correct' | 'partial' | 'incorrect';

export interface ChoiceOption {
  option_id: string;
  text: string;
}

const OPTION_EDGE_PREFIX = 'option:';
const VERDICT_EDGE_PREFIX = 'verdict:';

export function optionEdgeCondition(optionId: string): string {
  return `${OPTION_EDGE_PREFIX}${optionId}`;
}

export function verdictEdgeCondition(verdict: GraphVerdict): string {
  return `${VERDICT_EDGE_PREFIX}${verdict}`;
}

function parseOptionEdgeCondition(condition?: string): string | null {
  if (!condition?.startsWith(OPTION_EDGE_PREFIX)) {
    return null;
  }
  const optionId = condition.slice(OPTION_EDGE_PREFIX.length).trim();
  return optionId || null;
}

function parseVerdictEdgeCondition(condition?: string): GraphVerdict | null {
  if (!condition?.startsWith(VERDICT_EDGE_PREFIX)) {
    return null;
  }
  const verdict = condition.slice(VERDICT_EDGE_PREFIX.length).trim();
  if (verdict === 'correct' || verdict === 'partial' || verdict === 'incorrect') {
    return verdict;
  }
  return null;
}

function edgeKey(from: string, condition?: string): string {
  return `${from}::${condition ?? ''}`;
}

function nextNodeIdByOrder(nodes: GraphNode[], nodeId: string): string {
  const index = nodes.findIndex(node => node.id === nodeId);
  if (index < 0) return '';
  return nodes[index + 1]?.id ?? '';
}

export function getForwardTargetNodes(nodes: GraphNode[], nodeId: string): GraphNode[] {
  const index = nodes.findIndex(node => node.id === nodeId);
  if (index < 0) {
    return nodes;
  }
  return nodes.slice(index + 1);
}

export function getGraphEdgeTarget(edges: GraphEdge[], from: string, condition?: string): string {
  const target = edges.find(edge =>
    edge.from === from && (edge.condition ?? undefined) === (condition ?? undefined),
  )?.to;
  return target ?? '';
}

export function getGraphEdgeTargetWithFallback(edges: GraphEdge[], from: string, condition?: string): string {
  return getGraphEdgeTarget(edges, from, condition) || (condition ? getGraphEdgeTarget(edges, from) : '');
}

export function setGraphEdgeTarget(
  edges: GraphEdge[],
  from: string,
  condition: string | undefined,
  to: string,
): GraphEdge[] {
  const normalizedCondition = condition?.trim() || undefined;
  const trimmedTarget = to.trim();
  const nextEdges = edges.filter(edge =>
    !(edge.from === from && (edge.condition ?? undefined) === normalizedCondition),
  );
  if (!trimmedTarget) {
    return nextEdges;
  }
  return [
    ...nextEdges,
    normalizedCondition ? { from, to: trimmedTarget, condition: normalizedCondition } : { from, to: trimmedTarget },
  ];
}

function isValidEdgeForNode(node: GraphNode, edge: GraphEdge): boolean {
  if (node.type === 'story') {
    return !edge.condition;
  }
  if (node.type === 'single_choice') {
    if (!edge.condition) return true;
    const optionId = parseOptionEdgeCondition(edge.condition);
    if (!optionId) return false;
    const options = (node.data.options as ChoiceOption[]) ?? [];
    return options.some(option => option.option_id === optionId);
  }
  if (node.type === 'free_text') {
    return !edge.condition || parseVerdictEdgeCondition(edge.condition) !== null;
  }
  return false;
}

export function normalizeLessonGraph(graph: LessonGraph): LessonGraph {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const dedupedEdges = new Map<string, GraphEdge>();

  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      continue;
    }
    const node = nodeMap.get(edge.from);
    if (!node || !isValidEdgeForNode(node, edge)) {
      continue;
    }
    dedupedEdges.set(edgeKey(edge.from, edge.condition), edge);
  }

  let edges = Array.from(dedupedEdges.values());

  for (const node of nodes) {
    const defaultTarget = getGraphEdgeTarget(edges, node.id) || nextNodeIdByOrder(nodes, node.id);
    if (node.type === 'story') {
      if (!getGraphEdgeTarget(edges, node.id) && defaultTarget) {
        edges = setGraphEdgeTarget(edges, node.id, undefined, defaultTarget);
      }
      continue;
    }

    if (node.type === 'single_choice') {
      const options = (node.data.options as ChoiceOption[]) ?? [];
      for (const option of options) {
        if (!getGraphEdgeTarget(edges, node.id, optionEdgeCondition(option.option_id)) && defaultTarget) {
          edges = setGraphEdgeTarget(edges, node.id, optionEdgeCondition(option.option_id), defaultTarget);
        }
      }
      edges = edges.filter(edge => !(edge.from === node.id && !edge.condition));
      continue;
    }

    if (node.type === 'free_text') {
      for (const verdict of ['correct', 'partial', 'incorrect'] as GraphVerdict[]) {
        if (!getGraphEdgeTarget(edges, node.id, verdictEdgeCondition(verdict)) && defaultTarget) {
          edges = setGraphEdgeTarget(edges, node.id, verdictEdgeCondition(verdict), defaultTarget);
        }
      }
      edges = edges.filter(edge => !(edge.from === node.id && !edge.condition));
    }
  }

  const startNodeId = nodes.some(node => node.id === graph.startNodeId)
    ? graph.startNodeId
    : (nodes[0]?.id ?? '');

  return { startNodeId, nodes, edges };
}

export function isBackendLessonGraph(rawGraph: unknown): rawGraph is Record<string, unknown> {
  if (!rawGraph || typeof rawGraph !== 'object') return false;
  const graph = rawGraph as Record<string, unknown>;
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes as Array<Record<string, unknown>> : [];
  if (rawNodes.some(node => typeof node?.kind === 'string')) return true;
  if (rawNodes.some(node => typeof node?.type === 'string')) return false;
  return Array.isArray(graph.nodes) && !Array.isArray(graph.edges);
}

/**
 * Convert editor graph (type/data/edges) to backend format (kind/nextNodeId/options/transitions).
 */
export function graphToBackendFormat(graph: LessonGraph): Record<string, unknown> {
  const normalizedGraph = normalizeLessonGraph(graph);
  const startNodeId = normalizedGraph.startNodeId ?? '';
  const nodes = Array.isArray(normalizedGraph.nodes) ? normalizedGraph.nodes : [];
  const edges = Array.isArray(normalizedGraph.edges) ? normalizedGraph.edges : [];

  const backendNodes: Record<string, unknown>[] = nodes.map(node => {
    const nextNodeId = getGraphEdgeTarget(edges, node.id);
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
          const optionNextNodeId = getGraphEdgeTargetWithFallback(edges, node.id, optionEdgeCondition(optId));
          return {
            id: optId,
            text: o.text,
            result: isCorrect ? 'correct' : 'incorrect',
            feedback: isCorrect ? feedbackCorrect : feedbackIncorrect,
            nextNodeId: optionNextNodeId,
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
          referenceAnswer: (node.data.reference_answer ?? node.data.expected_answer ?? '') as string,
          criteria: (node.data.criteria as string) ?? '',
        },
        transitions: [
          {
            onVerdict: 'correct',
            nextNodeId: getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('correct')),
          },
          {
            onVerdict: 'partial',
            nextNodeId: getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('partial')),
          },
          {
            onVerdict: 'incorrect',
            nextNodeId: getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('incorrect')),
          },
        ],
      };
    }

    // end node
    return {
      id: node.id,
      kind: 'end',
      text: (node.data.text as string) ?? '',
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
    const body = (rn.body as Record<string, unknown>) ?? {};

    if (kind === 'story') {
      data.text = (rn.text ?? body.text ?? '') as string;
      data.illustration_url = (rn.asset_url ?? body.assetUrl ?? body.asset_url ?? '') as string;
      const nextNodeId = (rn.nextNodeId as string) ?? '';
      if (nextNodeId) edges.push({ from: id, to: nextNodeId });
    } else if (kind === 'single_choice') {
      data.question_text = (rn.prompt as string) ?? '';
      const opts = (rn.options as Array<Record<string, unknown>>) ?? [];
      let correctId = '';
      data.options = opts.map(o => {
        const optId = (o.id as string) ?? '';
        if ((o.result as string) === 'correct') correctId = optId;
        const nextNodeId = (o.nextNodeId as string) ?? '';
        if (nextNodeId) {
          edges.push({ from: id, to: nextNodeId, condition: optionEdgeCondition(optId) });
        }
        return { option_id: optId, text: (o.text as string) ?? '' };
      });
      data.correct_option_id = correctId;
      data.feedback_correct = opts.find(o => (o.result as string) === 'correct')?.feedback ?? '';
      data.feedback_incorrect = opts.find(o => (o.result as string) !== 'correct')?.feedback ?? '';
    } else if (kind === 'free_text') {
      data.question_text = (rn.prompt as string) ?? '';
      const rubric = (rn.rubric as Record<string, unknown>) ?? {};
      data.reference_answer = (rubric.referenceAnswer ?? rubric.reference_answer ?? '') as string;
      data.criteria = (rubric.criteria as string) ?? '';
      const transitions = (rn.transitions as Array<Record<string, unknown>>) ?? [];
      for (const transition of transitions) {
        const verdict = parseVerdictEdgeCondition(verdictEdgeCondition((transition.onVerdict as GraphVerdict) ?? 'correct'));
        const nextNodeId = (transition.nextNodeId as string) ?? '';
        if (verdict && nextNodeId) {
          edges.push({ from: id, to: nextNodeId, condition: verdictEdgeCondition(verdict) });
        }
      }
    } else if (kind === 'end') {
      data.text = (rn.text ?? body.text ?? '') as string;
    }

    nodes.push({ id, type, data });
  }

  return normalizeLessonGraph({ startNodeId, nodes, edges });
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
  student: {
    student_id: string;
    display_name: string;
    avatar_url?: string;
  };
  summary: {
    progress_percent: number;
    xp_total: number;
    correctness_percent: number;
  };
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
  invite_url?: string;
  claim_url?: string;
  url_status?: 'available' | 'legacy_unavailable';
  created_at?: string;
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

export interface UpdateDraftInput {
  draft_version: number;
  title: string;
  description: string;
  age_min?: number;
  age_max?: number;
  cover_asset_id?: string;
  content_json: CourseContent;
}

export interface ManualOrderInput {
  student_id: string;
  offer_id: string;
  purchase_request_id?: string;
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
