import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getTeacherDraft,
  updateTeacherDraft,
  createTeacherPreview,
} from '../../api/client';
import type {
  CourseDraft,
  ContentModule,
  GraphNode,
  LessonGraph,
  ChoiceOption,
  GraphVerdict,
  DecisionOption,
} from '../../api/types';
import {
  graphToBackendFormat,
  graphFromBackendFormat,
  isBackendLessonGraph,
  normalizeLessonGraph,
  optionEdgeCondition,
  verdictEdgeCondition,
  getGraphEdgeTarget,
  setGraphEdgeTarget,
  getForwardTargetNodes,
  connectMissingNodeOutputs,
  retargetNodeOutputs,
  reorderGraphNodes,
} from '../../api/types';
import { Button, ComicPanel, Badge, Spinner, Textarea, Modal, Select } from '../../components/ui';
import { getDraftValidationErrors } from '../../utils/editorErrors';
import s from './LessonConstructor.module.css';

function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

interface StoryData {
  text: string;
  illustration_url?: string;
}

interface SingleChoiceData {
  question_text: string;
  options: ChoiceOption[];
}

interface DecisionData {
  question_text: string;
  options: DecisionOption[];
}

interface FreeTextData {
  question_text: string;
  reference_answer: string;
  criteria_correct: string;
  criteria_partial: string;
  criteria_incorrect: string;
  feedback_correct: string;
  feedback_partial: string;
  feedback_incorrect: string;
}

function storyData(node: GraphNode): StoryData {
  return {
    text: (node.data.text as string) ?? '',
    illustration_url: node.data.illustration_url as string | undefined,
  };
}

function choiceData(node: GraphNode): SingleChoiceData {
  const options = ((node.data.options as Array<Record<string, unknown>>) ?? []).map((option) => {
    const optionId = ((option.option_id ?? option.id) as string) ?? '';
    const verdict = (option.verdict as GraphVerdict | undefined)
      ?? (((node.data.correct_option_id as string) ?? '') === optionId ? 'correct' : 'incorrect');
    const feedback = (option.feedback as string | undefined)
      ?? (verdict === 'correct'
        ? ((node.data.feedback_correct as string) ?? '')
        : ((node.data.feedback_incorrect as string) ?? ''));
    return {
      option_id: optionId,
      text: (option.text as string) ?? '',
      verdict,
      feedback,
    };
  });

  return {
    question_text: (node.data.question_text as string) ?? '',
    options,
  };
}

function decisionData(node: GraphNode): DecisionData {
  return {
    question_text: (node.data.question_text as string) ?? '',
    options: ((node.data.options as Array<Record<string, unknown>>) ?? []).map(option => ({
      option_id: ((option.option_id ?? option.id) as string) ?? '',
      text: (option.text as string) ?? '',
    })),
  };
}

function freeTextData(node: GraphNode): FreeTextData {
  const legacyCriteria = (node.data.criteria as string) ?? '';
  const legacyFeedback = (node.data.feedback_text as string) ?? '';
  return {
    question_text: (node.data.question_text as string) ?? '',
    reference_answer: (node.data.reference_answer as string) ?? '',
    criteria_correct: (node.data.criteria_correct as string) ?? legacyCriteria,
    criteria_partial: (node.data.criteria_partial as string) ?? legacyCriteria,
    criteria_incorrect: (node.data.criteria_incorrect as string) ?? legacyCriteria,
    feedback_correct: (node.data.feedback_correct as string) ?? legacyFeedback,
    feedback_partial: (node.data.feedback_partial as string) ?? legacyFeedback,
    feedback_incorrect: (node.data.feedback_incorrect as string) ?? legacyFeedback,
  };
}

const nodeTypeLabels: Record<string, { label: string; color: 'blue' | 'orange' | 'pink' | 'lime' | 'teal' }> = {
  story: { label: 'Блок истории', color: 'blue' },
  single_choice: { label: 'Выбор ответа', color: 'orange' },
  free_text: { label: 'Свободный ответ', color: 'pink' },
  decision: { label: 'Развилка сюжета', color: 'teal' },
  terminal: { label: 'Завершение', color: 'lime' },
};

function isPlaceholderGraph(graph: LessonGraph): boolean {
  if (graph.startNodeId !== 'start' || graph.nodes.length !== 2 || graph.edges.length !== 1) {
    return false;
  }

  const storyNode = graph.nodes.find(node => node.id === 'start' && node.type === 'story');
  const endNode = graph.nodes.find(node => node.id === 'end' && node.type === 'terminal');
  const edge = graph.edges[0];

  return Boolean(
    storyNode
      && endNode
      && edge?.from === 'start'
      && edge?.to === 'end'
      && ((storyNode.data.text as string | undefined) ?? '') === '',
  );
}

function nodeDisplayLabel(nodes: GraphNode[], nodeId: string): string {
  const index = nodes.findIndex(node => node.id === nodeId);
  const node = nodes[index];
  if (!node) {
    return nodeId;
  }
  const label = nodeTypeLabels[node.type]?.label ?? node.type;
  return `#${index + 1} ${label}`;
}

function createNode(type: GraphNode['type']): GraphNode {
  if (type === 'story') {
    return { id: genId(), type, data: { text: '', illustration_url: '' } };
  }
  if (type === 'single_choice') {
    return {
      id: genId(),
      type,
      data: {
        question_text: '',
        options: [
          { option_id: genId(), text: '', verdict: 'correct', feedback: 'Правильно!' },
          { option_id: genId(), text: '', verdict: 'incorrect', feedback: 'Неправильно.' },
        ],
      },
    };
  }
  if (type === 'decision') {
    return {
      id: genId(),
      type,
      data: {
        question_text: '',
        options: [
          { option_id: genId(), text: '' },
          { option_id: genId(), text: '' },
        ],
      },
    };
  }
  if (type === 'free_text') {
    return {
      id: genId(),
      type,
      data: {
        question_text: '',
        reference_answer: '',
        criteria_correct: '',
        criteria_partial: '',
        criteria_incorrect: '',
        feedback_correct: '',
        feedback_partial: '',
        feedback_incorrect: '',
      },
    };
  }
  return { id: genId(), type, data: { text: 'Миссия завершена!' } };
}

export default function LessonConstructor() {
  const { courseId, lessonId } = useParams<{
    courseId: string;
    lessonId: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: draft, loading, error: loadError } = useApi<CourseDraft>(
    () => getTeacherDraft(courseId!),
    [courseId],
  );

  const [lessonTitle, setLessonTitle] = useState('');
  const [graph, setGraph] = useState<LessonGraph>({ startNodeId: '', nodes: [], edges: [] });
  const [draftVersion, setDraftVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const nodes = graph.nodes;
  const edges = graph.edges;

  const moduleId = draft?.content_json?.modules?.find(
    m => m.lessons.some(l => l.id === lessonId),
  )?.id;

  useEffect(() => {
    if (!draft) return;
    setDraftVersion(draft.draft_version);
    for (const mod of draft.content_json?.modules ?? []) {
      const lesson = mod.lessons.find(l => l.id === lessonId);
      if (!lesson) continue;

      setLessonTitle(lesson.title);
      const rawGraph = lesson.graph as unknown as Record<string, unknown>;
      if (isBackendLessonGraph(rawGraph)) {
        const converted = graphFromBackendFormat(rawGraph);
        setGraph(isPlaceholderGraph(converted) ? { startNodeId: '', nodes: [], edges: [] } : normalizeLessonGraph(converted));
      } else {
        const editorGraph = normalizeLessonGraph(lesson.graph ?? { startNodeId: '', nodes: [], edges: [] });
        setGraph(isPlaceholderGraph(editorGraph) ? { startNodeId: '', nodes: [], edges: [] } : editorGraph);
      }
      break;
    }
  }, [draft, lessonId]);

  const updateGraph = useCallback((updater: (prev: LessonGraph) => LessonGraph) => {
    setGraph(prev => normalizeLessonGraph(updater(prev)));
  }, []);

  const showReorderWarning = (clearedEdges: number) => {
    if (clearedEdges > 0) {
      setError(`После переноса блока сброшено переходов: ${clearedEdges}. Проверьте связи веток перед сохранением.`);
    }
  };

  const addNode = (type: GraphNode['type']) => {
    const newNode = createNode(type);
    updateGraph(prev => {
      if (type === 'terminal' && prev.nodes.some(node => node.type === 'terminal')) {
        return prev;
      }

      const existingTerminal = prev.nodes.find(node => node.type === 'terminal');
      const nextNodes = [...prev.nodes];
      if (type !== 'terminal' && existingTerminal) {
        const terminalIndex = nextNodes.findIndex(node => node.id === existingTerminal.id);
        nextNodes.splice(terminalIndex, 0, newNode);
      } else {
        nextNodes.push(newNode);
      }

      let nextEdges = [...prev.edges];
      const nonTerminalNodes = nextNodes.filter(node => node.type !== 'terminal');
      const newNonTerminalIndex = nonTerminalNodes.findIndex(node => node.id === newNode.id);
      const previousContentNode = type === 'terminal'
        ? [...prev.nodes].at(-1)
        : (newNonTerminalIndex > 0 ? nonTerminalNodes[newNonTerminalIndex - 1] : undefined);

      if (type === 'terminal' && previousContentNode) {
        nextEdges = connectMissingNodeOutputs(nextEdges, previousContentNode, newNode.id);
      } else if (type !== 'terminal' && existingTerminal && previousContentNode) {
        nextEdges = retargetNodeOutputs(nextEdges, previousContentNode, existingTerminal.id, newNode.id);
        nextEdges = connectMissingNodeOutputs(nextEdges, newNode, existingTerminal.id);
      } else if (previousContentNode) {
        nextEdges = connectMissingNodeOutputs(nextEdges, previousContentNode, newNode.id);
      }

      const nextStartNodeId = prev.startNodeId && nextNodes.some(node => node.id === prev.startNodeId)
        ? prev.startNodeId
        : (nextNodes[0]?.id ?? '');

      return {
        ...prev,
        nodes: nextNodes,
        edges: nextEdges,
        startNodeId: nextStartNodeId,
      };
    });
  };

  const removeNode = (nodeId: string) => {
    setConfirmAction({
      message: 'Удалить этот блок?',
      onConfirm: () => {
        setConfirmAction(null);
        updateGraph(prev => {
          const nextNodes = prev.nodes.filter(node => node.id !== nodeId);
          const nextEdges = prev.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
          return {
            ...prev,
            nodes: nextNodes,
            edges: nextEdges,
            startNodeId: prev.startNodeId === nodeId ? (nextNodes[0]?.id ?? '') : prev.startNodeId,
          };
        });
      },
    });
  };

  const moveNodeUp = (idx: number) => {
    if (idx === 0) return;
    const result = reorderGraphNodes(graph, idx, idx - 1);
    setGraph(result.graph);
    showReorderWarning(result.clearedEdges);
  };

  const moveNodeDown = (idx: number) => {
    if (idx >= graph.nodes.length - 1) return;
    const result = reorderGraphNodes(graph, idx, idx + 1);
    setGraph(result.graph);
    showReorderWarning(result.clearedEdges);
  };

  const updateNodeData = (nodeId: string, field: string, value: unknown) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, [field]: value } } : node,
      ),
    }));
  };

  const addOption = (nodeId: string, type: 'single_choice' | 'decision') => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = (node.data.options as Array<ChoiceOption | DecisionOption>) ?? [];
        const nextOption = type === 'single_choice'
          ? { option_id: genId(), text: '', verdict: 'incorrect' as GraphVerdict, feedback: '' }
          : { option_id: genId(), text: '' };
        return {
          ...node,
          data: {
            ...node.data,
            options: [...options, nextOption],
          },
        };
      }),
    }));
  };

  const removeOption = (nodeId: string, optionId: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = ((node.data.options as Array<ChoiceOption | DecisionOption>) ?? [])
          .filter(option => option.option_id !== optionId);
        return { ...node, data: { ...node.data, options } };
      }),
      edges: prev.edges.filter(edge => !(edge.from === nodeId && edge.condition === optionEdgeCondition(optionId))),
    }));
  };

  const updateChoiceOption = (nodeId: string, optionId: string, patch: Partial<ChoiceOption>) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = choiceData(node).options.map(option =>
          option.option_id === optionId ? { ...option, ...patch } : option,
        );
        return { ...node, data: { ...node.data, options } };
      }),
    }));
  };

  const updateDecisionOption = (nodeId: string, optionId: string, patch: Partial<DecisionOption>) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = decisionData(node).options.map(option =>
          option.option_id === optionId ? { ...option, ...patch } : option,
        );
        return { ...node, data: { ...node.data, options } };
      }),
    }));
  };

  const setStoryNextNode = (nodeId: string, targetId: string) => {
    updateGraph(prev => ({
      ...prev,
      edges: setGraphEdgeTarget(prev.edges, nodeId, undefined, targetId),
    }));
  };

  const setOptionNextNode = (nodeId: string, optionId: string, targetId: string) => {
    updateGraph(prev => ({
      ...prev,
      edges: setGraphEdgeTarget(prev.edges, nodeId, optionEdgeCondition(optionId), targetId),
    }));
  };

  const setFreeTextNextNode = (nodeId: string, verdict: GraphVerdict, targetId: string) => {
    updateGraph(prev => ({
      ...prev,
      edges: setGraphEdgeTarget(prev.edges, nodeId, verdictEdgeCondition(verdict), targetId),
    }));
  };

  const describeOutgoingEdges = (node: GraphNode): string[] => {
    if (node.type === 'story') {
      const targetId = getGraphEdgeTarget(edges, node.id);
      return targetId ? [`Далее -> ${nodeDisplayLabel(nodes, targetId)}`] : [];
    }
    if (node.type === 'single_choice' || node.type === 'decision') {
      const options = node.type === 'single_choice' ? choiceData(node).options : decisionData(node).options;
      return options.flatMap(option => {
        const targetId = getGraphEdgeTarget(edges, node.id, optionEdgeCondition(option.option_id));
        if (!targetId) return [];
        return [`${option.text || 'Без текста'} -> ${nodeDisplayLabel(nodes, targetId)}`];
      });
    }
    if (node.type === 'free_text') {
      return (['correct', 'partial', 'incorrect'] as GraphVerdict[]).flatMap(verdict => {
        const targetId = getGraphEdgeTarget(edges, node.id, verdictEdgeCondition(verdict));
        if (!targetId) return [];
        return [`${verdict} -> ${nodeDisplayLabel(nodes, targetId)}`];
      });
    }
    return [];
  };

  const handleSave = useCallback(async (): Promise<number> => {
    if (!draft || !moduleId || !lessonId || !courseId) {
      throw new Error('Черновик урока не найден');
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    setValidationErrors([]);
    try {
      const backendGraph = graphToBackendFormat(graph);

      const updatedModules: ContentModule[] = (draft.content_json?.modules ?? []).map(mod => {
        if (mod.id !== moduleId) return mod;
        return {
          ...mod,
          lessons: mod.lessons.map(l =>
            l.id === lessonId ? { ...l, title: lessonTitle, graph: backendGraph as unknown as LessonGraph } : l,
          ),
        };
      });

      const result = await updateTeacherDraft(courseId, {
        draft_version: draftVersion,
        title: draft.title,
        description: draft.description,
        age_min: draft.age_min,
        age_max: draft.age_max,
        cover_asset_id: draft.cover_asset_id,
        content_json: { modules: updatedModules },
      });
      setDraftVersion(result.draft_version);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      return result.draft_version;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setError(details.length > 0 ? null : message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setSaving(false);
    }
  }, [courseId, draft, draftVersion, graph, lessonId, lessonTitle, moduleId]);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setValidationErrors([]);
    try {
      await handleSave();
      const session = await createTeacherPreview(courseId!, lessonId!, location.pathname);
      navigate(`/teacher/preview/${session.preview_session_id}?return_to=${encodeURIComponent(location.pathname)}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ошибка предпросмотра';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setError(details.length > 0 ? null : message);
    } finally {
      setPreviewing(false);
    }
  }, [courseId, handleSave, lessonId, location.pathname, navigate]);

  if (loading) return <Spinner text="Загрузка этапа..." />;
  if (loadError) return <div className={s.error}>{loadError}</div>;
  if (!draft) return null;

  return (
    <div className={s.page}>
      <Button
        variant="ghost"
        className={s.backBtn}
        onClick={() => navigate(`/teacher/courses/${courseId}`)}
      >
        &larr; К курсу
      </Button>

      <ComicPanel className={s.headerPanel}>
        <div className={s.headerTop}>
          <input
            className={s.titleInput}
            value={lessonTitle}
            onChange={e => setLessonTitle(e.target.value)}
            placeholder="Название этапа..."
          />
          <div className={s.headerActions}>
            <Button onClick={() => { void handleSave().catch(() => undefined); }} disabled={saving} size="sm">
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
            <Button variant="secondary" size="sm" onClick={handlePreview} disabled={previewing}>
              {previewing ? 'Загрузка...' : 'Предпросмотр'}
            </Button>
            {saved && <span className={s.saved}>Сохранено!</span>}
          </div>
        </div>
      </ComicPanel>

      {error && <div className={s.error}>{error}</div>}
      {validationErrors.length > 0 && (
        <div className={s.error}>
          <div>Что нужно исправить:</div>
          <ul style={{ margin: '8px 0 0 20px' }}>
            {validationErrors.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={s.nodeList}>
        {nodes.map((node, idx) => {
          const typeInfo = nodeTypeLabels[node.type] ?? nodeTypeLabels.story;
          return (
            <div key={node.id}>
              {idx > 0 && (
                <div className={s.connector}>
                  <div className={s.connectorLine} />
                  <div className={s.connectorArrow} />
                </div>
              )}
              <ComicPanel className={[s.nodeCard, s[node.type]].filter(Boolean).join(' ')}>
                <div className={s.nodeHeader}>
                  <div className={s.nodeTypeLabel}>
                    <Badge color={typeInfo.color}>{typeInfo.label}</Badge>
                    <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>#{idx + 1}</span>
                  </div>
                  <div className={s.nodeActions}>
                    <button className={s.moveBtn} onClick={() => moveNodeUp(idx)} disabled={idx === 0}>
                      &uarr;
                    </button>
                    <button className={s.moveBtn} onClick={() => moveNodeDown(idx)} disabled={idx === nodes.length - 1}>
                      &darr;
                    </button>
                    <button className={s.deleteNodeBtn} onClick={() => removeNode(node.id)} title="Удалить блок">
                      &times;
                    </button>
                  </div>
                </div>

                {node.type === 'story' && (
                  <div className={s.storyContent}>
                    <Textarea
                      label="Текст истории"
                      value={storyData(node).text}
                      onChange={e => updateNodeData(node.id, 'text', e.target.value)}
                      placeholder="Напишите текст истории для ученика..."
                      rows={4}
                    />
                    <div className={s.illustrationPlaceholder} title="Загрузка иллюстраций (в разработке)">
                      {storyData(node).illustration_url ? 'Иллюстрация загружена' : 'Нажмите для загрузки иллюстрации'}
                    </div>
                    <Select
                      label="Следующий блок"
                      value={getGraphEdgeTarget(edges, node.id)}
                      onChange={event => setStoryNextNode(node.id, event.target.value)}
                    >
                      <option value="">Выберите следующий блок</option>
                      {getForwardTargetNodes(nodes, node.id).map(target => (
                        <option key={target.id} value={target.id}>
                          {nodeDisplayLabel(nodes, target.id)}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}

                {node.type === 'single_choice' && (() => {
                  const data = choiceData(node);
                  return (
                    <div className={s.choiceContent}>
                      <Textarea
                        label="Текст вопроса"
                        value={data.question_text}
                        onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                        placeholder="Напишите вопрос..."
                        rows={2}
                      />
                      <div>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Варианты ответа</div>
                        <div className={s.optionsList}>
                          {data.options.map(option => (
                            <div key={option.option_id} className={s.optionBlock}>
                              <div className={s.optionRow}>
                                <input
                                  className={s.optionInput}
                                  value={option.text}
                                  onChange={e => updateChoiceOption(node.id, option.option_id, { text: e.target.value })}
                                  placeholder="Вариант ответа..."
                                />
                                {data.options.length > 2 && (
                                  <button
                                    className={s.removeOptionBtn}
                                    onClick={() => removeOption(node.id, option.option_id)}
                                    type="button"
                                    aria-label="Удалить вариант"
                                    title="Удалить вариант"
                                  >
                                    &times;
                                  </button>
                                )}
                              </div>
                              <Select
                                label="Оценка варианта"
                                value={option.verdict ?? 'incorrect'}
                                onChange={event => updateChoiceOption(node.id, option.option_id, { verdict: event.target.value as GraphVerdict })}
                              >
                                <option value="correct">Правильный</option>
                                <option value="partial">Почти правильный</option>
                                <option value="incorrect">Неправильный</option>
                              </Select>
                              <Textarea
                                label="Обратная связь для этого варианта"
                                value={option.feedback ?? ''}
                                onChange={e => updateChoiceOption(node.id, option.option_id, { feedback: e.target.value })}
                                placeholder="Что увидит ученик после выбора этого варианта..."
                                rows={2}
                              />
                              <Select
                                label="Переход после этого ответа"
                                value={getGraphEdgeTarget(edges, node.id, optionEdgeCondition(option.option_id))}
                                onChange={event => setOptionNextNode(node.id, option.option_id, event.target.value)}
                              >
                                <option value="">Выберите следующий блок</option>
                                {getForwardTargetNodes(nodes, node.id).map(target => (
                                  <option key={target.id} value={target.id}>
                                    {nodeDisplayLabel(nodes, target.id)}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          ))}
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => addOption(node.id, 'single_choice')} style={{ marginTop: 8 }}>
                          + Вариант
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {node.type === 'decision' && (() => {
                  const data = decisionData(node);
                  return (
                    <div className={s.choiceContent}>
                      <Textarea
                        label="Текст выбора"
                        value={data.question_text}
                        onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                        placeholder="Опишите сюжетный выбор..."
                        rows={2}
                      />
                      <div>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Варианты сюжетного выбора</div>
                        <div className={s.optionsList}>
                          {data.options.map(option => (
                            <div key={option.option_id} className={s.optionBlock}>
                              <div className={s.optionRow}>
                                <input
                                  className={s.optionInput}
                                  value={option.text}
                                  onChange={e => updateDecisionOption(node.id, option.option_id, { text: e.target.value })}
                                  placeholder="Вариант выбора..."
                                />
                                {data.options.length > 2 && (
                                  <button
                                    className={s.removeOptionBtn}
                                    onClick={() => removeOption(node.id, option.option_id)}
                                    type="button"
                                    aria-label="Удалить вариант"
                                    title="Удалить вариант"
                                  >
                                    &times;
                                  </button>
                                )}
                              </div>
                              <Select
                                label="Переход после выбора"
                                value={getGraphEdgeTarget(edges, node.id, optionEdgeCondition(option.option_id))}
                                onChange={event => setOptionNextNode(node.id, option.option_id, event.target.value)}
                              >
                                <option value="">Выберите следующий блок</option>
                                {getForwardTargetNodes(nodes, node.id).map(target => (
                                  <option key={target.id} value={target.id}>
                                    {nodeDisplayLabel(nodes, target.id)}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          ))}
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => addOption(node.id, 'decision')} style={{ marginTop: 8 }}>
                          + Вариант выбора
                        </Button>
                      </div>
                    </div>
                  );
                })()}

                {node.type === 'free_text' && (() => {
                  const data = freeTextData(node);
                  return (
                    <div className={s.freeTextContent}>
                      <Textarea
                        label="Текст вопроса"
                        value={data.question_text}
                        onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                        placeholder="Напишите вопрос..."
                        rows={2}
                      />
                      <Textarea
                        label="Эталонный ответ"
                        value={data.reference_answer}
                        onChange={e => updateNodeData(node.id, 'reference_answer', e.target.value)}
                        placeholder="Коротко сформулируйте сильный ответ..."
                        rows={2}
                      />
                      <div style={{ border: 'var(--border-thin)', borderRadius: '12px', padding: '12px 14px', background: 'rgba(13,148,136,0.06)' }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>Как писать критерии оценивания</div>
                        <div style={{ fontSize: '0.92rem', lineHeight: 1.5 }}>
                          Пишите наблюдаемые признаки ответа, а не общие формулировки. Для `правильно` укажите, какие мысли ответ обязан содержать.
                          Для `почти правильно` опишите, чего в ответе уже хватает, но что ещё отсутствует. Для `неверно` перечислите типичные упущения или неверные идеи.
                        </div>
                      </div>
                      <Textarea
                        label="Критерии правильного ответа"
                        value={data.criteria_correct}
                        onChange={e => updateNodeData(node.id, 'criteria_correct', e.target.value)}
                        placeholder="Что обязательно должно быть в сильном ответе..."
                        rows={2}
                      />
                      <Textarea
                        label="Критерии частично верного ответа"
                        value={data.criteria_partial}
                        onChange={e => updateNodeData(node.id, 'criteria_partial', e.target.value)}
                        placeholder="Что уже неплохо, но ещё не дотягивает до полного ответа..."
                        rows={2}
                      />
                      <Textarea
                        label="Критерии неверного ответа"
                        value={data.criteria_incorrect}
                        onChange={e => updateNodeData(node.id, 'criteria_incorrect', e.target.value)}
                        placeholder="Какие ответы считаем неверными или не по делу..."
                        rows={2}
                      />
                      <Textarea
                        label="Обратная связь при правильном ответе"
                        value={data.feedback_correct}
                        onChange={e => updateNodeData(node.id, 'feedback_correct', e.target.value)}
                        placeholder="Что увидит ученик при правильном ответе..."
                        rows={2}
                      />
                      <Textarea
                        label="Обратная связь при частично верном ответе"
                        value={data.feedback_partial}
                        onChange={e => updateNodeData(node.id, 'feedback_partial', e.target.value)}
                        placeholder="Что увидит ученик при частично верном ответе..."
                        rows={2}
                      />
                      <Textarea
                        label="Обратная связь при неправильном ответе"
                        value={data.feedback_incorrect}
                        onChange={e => updateNodeData(node.id, 'feedback_incorrect', e.target.value)}
                        placeholder="Что увидит ученик при неправильном ответе..."
                        rows={2}
                      />
                      <Select
                        label="Следующий блок при правильном ответе"
                        value={getGraphEdgeTarget(edges, node.id, verdictEdgeCondition('correct'))}
                        onChange={event => setFreeTextNextNode(node.id, 'correct', event.target.value)}
                      >
                        <option value="">Выберите следующий блок</option>
                        {getForwardTargetNodes(nodes, node.id).map(target => (
                          <option key={target.id} value={target.id}>
                            {nodeDisplayLabel(nodes, target.id)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Следующий блок при частично верном ответе"
                        value={getGraphEdgeTarget(edges, node.id, verdictEdgeCondition('partial'))}
                        onChange={event => setFreeTextNextNode(node.id, 'partial', event.target.value)}
                      >
                        <option value="">Выберите следующий блок</option>
                        {getForwardTargetNodes(nodes, node.id).map(target => (
                          <option key={target.id} value={target.id}>
                            {nodeDisplayLabel(nodes, target.id)}
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Следующий блок при неправильном ответе"
                        value={getGraphEdgeTarget(edges, node.id, verdictEdgeCondition('incorrect'))}
                        onChange={event => setFreeTextNextNode(node.id, 'incorrect', event.target.value)}
                      >
                        <option value="">Выберите следующий блок</option>
                        {getForwardTargetNodes(nodes, node.id).map(target => (
                          <option key={target.id} value={target.id}>
                            {nodeDisplayLabel(nodes, target.id)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  );
                })()}

                {node.type === 'terminal' && (
                  <div className={s.terminalContent}>
                    <Textarea
                      label="Текст завершения"
                      value={(node.data.text as string) ?? ''}
                      onChange={e => updateNodeData(node.id, 'text', e.target.value)}
                      placeholder="Что увидит ученик в конце этапа..."
                      rows={2}
                    />
                  </div>
                )}

                {describeOutgoingEdges(node).length > 0 && (
                  <div className={s.edgeInfo}>
                    {describeOutgoingEdges(node).map(line => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                )}
              </ComicPanel>
            </div>
          );
        })}
      </div>

      <div className={s.addNodeBar}>
        <Button size="sm" variant="outline" onClick={() => addNode('story')}>
          + Блок истории
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('single_choice')}>
          + Выбор ответа
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('decision')}>
          + Развилка сюжета
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('free_text')}>
          + Свободный ответ
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('terminal')}>
          + Завершение
        </Button>
      </div>

      <Modal
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title="Подтверждение"
      >
        <div>
          <p>{confirmAction?.message}</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)}>
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={confirmAction?.onConfirm}>
              Подтвердить
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
