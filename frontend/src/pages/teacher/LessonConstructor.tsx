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
} from '../../api/types';
import {
  graphToBackendFormat,
  graphFromBackendFormat,
  isBackendLessonGraph,
  normalizeLessonGraph,
  optionEdgeCondition,
  verdictEdgeCondition,
  getGraphEdgeTargetWithFallback,
  setGraphEdgeTarget,
  getForwardTargetNodes,
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
  correct_option_id: string;
  feedback_correct: string;
  feedback_incorrect: string;
}

interface FreeTextData {
  question_text: string;
  reference_answer: string;
  criteria: string;
  feedback_text: string;
}

/* helpers to read/write node data with proper typing */
function storyData(n: GraphNode): StoryData {
  return {
    text: (n.data.text as string) ?? '',
    illustration_url: n.data.illustration_url as string | undefined,
  };
}

function choiceData(n: GraphNode): SingleChoiceData {
  return {
    question_text: (n.data.question_text as string) ?? '',
    options: (n.data.options as ChoiceOption[]) ?? [],
    correct_option_id: (n.data.correct_option_id as string) ?? '',
    feedback_correct: (n.data.feedback_correct as string) ?? '',
    feedback_incorrect: (n.data.feedback_incorrect as string) ?? '',
  };
}

function freeTextData(n: GraphNode): FreeTextData {
  return {
    question_text: (n.data.question_text as string) ?? '',
    reference_answer: (n.data.reference_answer as string) ?? '',
    criteria: (n.data.criteria as string) ?? '',
    feedback_text: (n.data.feedback_text as string) ?? '',
  };
}

const nodeTypeLabels: Record<string, { label: string; color: 'blue' | 'orange' | 'pink' | 'lime' }> = {
  story: { label: 'Блок истории', color: 'blue' },
  single_choice: { label: 'Выбор ответа', color: 'orange' },
  free_text: { label: 'Свободный ответ', color: 'pink' },
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
  const startNodeId = graph.startNodeId;

  // Find our lesson in the draft (scan all modules for lessonId)
  const moduleId = draft?.content_json?.modules?.find(
    m => m.lessons.some(l => l.id === lessonId),
  )?.id;

  useEffect(() => {
    if (!draft) return;
    setDraftVersion(draft.draft_version);
    for (const mod of draft.content_json?.modules ?? []) {
      const lesson = mod.lessons.find(l => l.id === lessonId);
      if (lesson) {
        setLessonTitle(lesson.title);
        // Detect backend format (nodes have 'kind' not 'type') and convert
        const rawGraph = lesson.graph as unknown as Record<string, unknown>;
        if (isBackendLessonGraph(rawGraph)) {
          const converted = graphFromBackendFormat(rawGraph);
          if (isPlaceholderGraph(converted)) {
            setGraph({ startNodeId: '', nodes: [], edges: [] });
          } else {
            setGraph(normalizeLessonGraph(converted));
          }
        } else {
          const editorGraph = normalizeLessonGraph(lesson.graph ?? { startNodeId: '', nodes: [], edges: [] });
          if (isPlaceholderGraph(editorGraph)) {
            setGraph({ startNodeId: '', nodes: [], edges: [] });
          } else {
            setGraph(editorGraph);
          }
        }
        break;
      }
    }
  }, [draft, lessonId]);

  const updateGraph = useCallback((updater: (prev: LessonGraph) => LessonGraph) => {
    setGraph(prev => normalizeLessonGraph(updater(prev)));
  }, []);

  // Node CRUD
  const addNode = (type: GraphNode['type']) => {
    const newNode: GraphNode = { id: genId(), type, data: {} };
    if (type === 'story') {
      newNode.data = { text: '', illustration_url: '' };
    } else if (type === 'single_choice') {
      const opt1Id = genId();
      const opt2Id = genId();
      newNode.data = {
        question_text: '',
        options: [
          { option_id: opt1Id, text: '' },
          { option_id: opt2Id, text: '' },
        ],
        correct_option_id: opt1Id,
        feedback_correct: 'Правильно!',
        feedback_incorrect: 'Неправильно.',
      };
    } else if (type === 'free_text') {
      newNode.data = {
        question_text: '',
        reference_answer: '',
        criteria: '',
        feedback_text: '',
      };
    } else if (type === 'terminal') {
      newNode.data = { text: 'Миссия завершена!' };
    }
    updateGraph(prev => {
      if (type === 'terminal' && prev.nodes.some(node => node.type === 'terminal')) {
        return prev;
      }
      const terminalNode = prev.nodes.find(node => node.type === 'terminal');
      const previousContentNode =
        type !== 'terminal'
          ? [...prev.nodes.filter(node => node.type !== 'terminal')].at(-1)
          : undefined;
      const nextNodes =
        type !== 'terminal' && terminalNode
          ? [...prev.nodes.filter(node => node.id !== terminalNode.id), newNode, terminalNode]
          : [...prev.nodes, newNode];
      const nextEdges =
        type !== 'terminal' && terminalNode && previousContentNode
          ? prev.edges.map(edge =>
              edge.from === previousContentNode.id && edge.to === terminalNode.id
                ? { ...edge, to: newNode.id }
                : edge,
            )
          : prev.edges;
      return {
        ...prev,
        nodes: nextNodes,
        edges: nextEdges,
        startNodeId: prev.startNodeId || (nextNodes[0]?.id ?? ''),
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
    updateGraph(prev => {
      const arr = [...prev.nodes];
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      return { ...prev, nodes: arr };
    });
  };

  const moveNodeDown = (idx: number) => {
    updateGraph(prev => {
      if (idx >= prev.nodes.length - 1) return prev;
      const arr = [...prev.nodes];
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      return { ...prev, nodes: arr };
    });
  };

  const updateNodeData = (nodeId: string, field: string, value: unknown) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, [field]: value } } : node,
      ),
    }));
  };

  // Choice option helpers
  const addOption = (nodeId: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const opts = (node.data.options as ChoiceOption[]) ?? [];
        return {
          ...node,
          data: {
            ...node.data,
            options: [...opts, { option_id: genId(), text: '' }],
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
        const opts = ((node.data.options as ChoiceOption[]) ?? []).filter(option => option.option_id !== optionId);
        const correctId = node.data.correct_option_id as string;
        return {
          ...node,
          data: {
            ...node.data,
            options: opts,
            correct_option_id: correctId === optionId ? (opts[0]?.option_id ?? '') : correctId,
          },
        };
      }),
      edges: prev.edges.filter(edge => !(
        edge.from === nodeId
        && edge.condition === optionEdgeCondition(optionId)
      )),
    }));
  };

  const updateOptionText = (nodeId: string, optionId: string, text: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const opts = ((node.data.options as ChoiceOption[]) ?? []).map(option =>
          option.option_id === optionId ? { ...option, text } : option,
        );
        return { ...node, data: { ...node.data, options: opts } };
      }),
    }));
  };

  const setCorrectOption = (nodeId: string, optionId: string) => {
    updateNodeData(nodeId, 'correct_option_id', optionId);
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
      const targetId = getGraphEdgeTargetWithFallback(edges, node.id);
      return targetId ? [`Далее -> ${nodeDisplayLabel(nodes, targetId)}`] : [];
    }
    if (node.type === 'single_choice') {
      const cd = choiceData(node);
      return cd.options.flatMap(option => {
        const targetId = getGraphEdgeTargetWithFallback(edges, node.id, optionEdgeCondition(option.option_id));
        if (!targetId) return [];
        return [`${option.text || 'Без текста'} -> ${nodeDisplayLabel(nodes, targetId)}`];
      });
    }
    if (node.type === 'free_text') {
      return (['correct', 'partial', 'incorrect'] as GraphVerdict[]).flatMap(verdict => {
        const targetId = getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition(verdict));
        if (!targetId) return [];
        return [`${verdict} -> ${nodeDisplayLabel(nodes, targetId)}`];
      });
    }
    return [];
  };

  // Save
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

  // Preview
  const handlePreview = useCallback(async () => {
    // Save first, then create preview session
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

      {/* Header */}
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

      {/* Node list */}
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
              <ComicPanel
                className={`${s.nodeCard} ${s[node.type]}`}
              >
                <div className={s.nodeHeader}>
                  <div className={s.nodeTypeLabel}>
                    <Badge color={typeInfo.color}>{typeInfo.label}</Badge>
                    <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>#{idx + 1}</span>
                  </div>
                  <div className={s.nodeActions}>
                    <button
                      className={s.moveBtn}
                      onClick={() => moveNodeUp(idx)}
                      disabled={idx === 0}
                    >
                      &uarr;
                    </button>
                    <button
                      className={s.moveBtn}
                      onClick={() => moveNodeDown(idx)}
                      disabled={idx === nodes.length - 1}
                    >
                      &darr;
                    </button>
                    <button
                      className={s.deleteNodeBtn}
                      onClick={() => removeNode(node.id)}
                      title="Удалить блок"
                    >
                      &times;
                    </button>
                  </div>
                </div>

                {/* Story node */}
                {node.type === 'story' && (
                  <div className={s.storyContent}>
                    <Textarea
                      label="Текст истории"
                      value={storyData(node).text}
                      onChange={e => updateNodeData(node.id, 'text', e.target.value)}
                      placeholder="Напишите текст истории для ученика..."
                      rows={4}
                    />
                    <div
                      className={s.illustrationPlaceholder}
                      title="Загрузка иллюстраций (в разработке)"
                    >
                      {storyData(node).illustration_url
                        ? 'Иллюстрация загружена'
                        : 'Нажмите для загрузки иллюстрации'}
                    </div>
                    <Select
                      label="Следующий блок"
                      value={getGraphEdgeTargetWithFallback(edges, node.id)}
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

                {/* Single choice node */}
                {node.type === 'single_choice' && (() => {
                  const cd = choiceData(node);
                  return (
                    <div className={s.choiceContent}>
                      <Textarea
                        label="Текст вопроса"
                        value={cd.question_text}
                        onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                        placeholder="Напишите вопрос..."
                        rows={2}
                      />

                      <div>
                        <span className={s.feedbackLabel}>Варианты ответа (нажмите кружок для правильного):</span>
                        <div className={s.optionsList}>
                          {cd.options.map(opt => (
                            <div key={opt.option_id} className={s.optionBlock}>
                              <div className={s.optionRow}>
                                <button
                                  className={`${s.correctToggle} ${cd.correct_option_id === opt.option_id ? s.active : ''}`}
                                  onClick={() => setCorrectOption(node.id, opt.option_id)}
                                  title={cd.correct_option_id === opt.option_id ? 'Правильный' : 'Отметить как правильный'}
                                >
                                  {cd.correct_option_id === opt.option_id ? '✓' : ''}
                                </button>
                                <input
                                  className={s.optionInput}
                                  value={opt.text}
                                  onChange={e => updateOptionText(node.id, opt.option_id, e.target.value)}
                                  placeholder="Вариант ответа..."
                                />
                                {cd.options.length > 2 && (
                                  <button
                                    className={s.removeOptionBtn}
                                    onClick={() => removeOption(node.id, opt.option_id)}
                                    type="button"
                                    aria-label="Удалить вариант"
                                    title="Удалить вариант"
                                  >
                                    &times;
                                  </button>
                                )}
                              </div>
                              <Select
                                label="Переход после этого ответа"
                                value={getGraphEdgeTargetWithFallback(edges, node.id, optionEdgeCondition(opt.option_id))}
                                onChange={event => setOptionNextNode(node.id, opt.option_id, event.target.value)}
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => addOption(node.id)}
                          style={{ marginTop: 8 }}
                        >
                          + Вариант
                        </Button>
                      </div>

                      <Textarea
                        label="Обратная связь (правильно)"
                        value={cd.feedback_correct}
                        onChange={e => updateNodeData(node.id, 'feedback_correct', e.target.value)}
                        placeholder="Текст при правильном ответе..."
                        rows={2}
                      />
                      <Textarea
                        label="Обратная связь (неправильно)"
                        value={cd.feedback_incorrect}
                        onChange={e => updateNodeData(node.id, 'feedback_incorrect', e.target.value)}
                        placeholder="Текст при неправильном ответе..."
                        rows={2}
                      />
                    </div>
                  );
                })()}

                {/* Free text node */}
                {node.type === 'free_text' && (() => {
                  const fd = freeTextData(node);
                  return (
                    <div className={s.freeTextContent}>
                      <Textarea
                        label="Текст вопроса"
                        value={fd.question_text}
                        onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                        placeholder="Напишите вопрос..."
                        rows={2}
                      />
                      <Textarea
                        label="Эталонный ответ"
                        value={fd.reference_answer}
                        onChange={e => updateNodeData(node.id, 'reference_answer', e.target.value)}
                        placeholder="Правильный ответ для сравнения..."
                        rows={2}
                      />
                      <Textarea
                        label="Критерии оценивания"
                        value={fd.criteria}
                        onChange={e => updateNodeData(node.id, 'criteria', e.target.value)}
                        placeholder="Как оценивать ответ..."
                        rows={2}
                      />
                      <Textarea
                        label="Обратная связь"
                        value={fd.feedback_text}
                        onChange={e => updateNodeData(node.id, 'feedback_text', e.target.value)}
                        placeholder="Текст обратной связи..."
                        rows={2}
                      />
                      <Select
                        label="Следующий блок при правильном ответе"
                        value={getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('correct'))}
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
                        value={getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('partial'))}
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
                        value={getGraphEdgeTargetWithFallback(edges, node.id, verdictEdgeCondition('incorrect'))}
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

                {/* Terminal node */}
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

                {/* Edge info */}
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

      {/* Add node buttons */}
      <div className={s.addNodeBar}>
        <Button size="sm" variant="outline" onClick={() => addNode('story')}>
          + Блок истории
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('single_choice')}>
          + Выбор ответа
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('free_text')}>
          + Свободный ответ
        </Button>
        <Button size="sm" variant="outline" onClick={() => addNode('terminal')}>
          + Завершение
        </Button>
      </div>

      {/* Confirm Action Modal */}
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
