import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getAdminDraft, updateAdminDraft, createAdminPreview } from '../../api/client';
import { Button, Badge, Spinner, EmptyState, Input, Textarea, Select } from '../../components/ui';
import type {
  CourseDraft,
  GraphNode,
  ContentModule,
  ContentLesson,
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
import { getDraftValidationErrors } from '../../utils/editorErrors';
import styles from './AdminLessonEditor.module.css';

type NodeType = 'story' | 'single_choice' | 'free_text' | 'decision' | 'terminal';

type StoryData = {
  text: string;
  speaker?: string;
};

type SingleChoiceData = {
  question_text: string;
  options: ChoiceOption[];
};

type DecisionData = {
  question_text: string;
  options: DecisionOption[];
};

type FreeTextData = {
  question_text: string;
  reference_answer: string;
  criteria_correct: string;
  criteria_partial: string;
  criteria_incorrect: string;
  feedback_correct: string;
  feedback_partial: string;
  feedback_incorrect: string;
};

const NODE_ICONS: Record<NodeType, string> = {
  story: '📖',
  single_choice: '🔘',
  free_text: '✏️',
  decision: '🧭',
  terminal: '🏁',
};

const NODE_LABELS: Record<NodeType, string> = {
  story: 'История',
  single_choice: 'Выбор ответа',
  free_text: 'Свободный ответ',
  decision: 'Развилка сюжета',
  terminal: 'Конец',
};

function storyData(node: GraphNode): StoryData {
  return {
    text: (node.data.text as string) ?? '',
    speaker: (node.data.speaker as string) ?? '',
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

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function nodeDisplayLabel(nodes: GraphNode[], nodeId: string): string {
  const index = nodes.findIndex(node => node.id === nodeId);
  const node = nodes[index];
  if (!node) {
    return nodeId;
  }
  return `#${index + 1} ${NODE_LABELS[node.type as NodeType] ?? node.type}`;
}

function createNode(type: NodeType): GraphNode {
  if (type === 'story') {
    return { id: generateId(), type, data: { text: '', speaker: '' } };
  }
  if (type === 'single_choice') {
    return {
      id: generateId(),
      type,
      data: {
        question_text: '',
        options: [
          { option_id: generateId(), text: '', verdict: 'correct', feedback: 'Правильно!' },
          { option_id: generateId(), text: '', verdict: 'incorrect', feedback: 'Неправильно.' },
        ],
      },
    };
  }
  if (type === 'decision') {
    return {
      id: generateId(),
      type,
      data: {
        question_text: '',
        options: [
          { option_id: generateId(), text: '' },
          { option_id: generateId(), text: '' },
        ],
      },
    };
  }
  if (type === 'free_text') {
    return {
      id: generateId(),
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
  return { id: generateId(), type, data: { text: 'Миссия завершена!' } };
}

export default function AdminLessonEditor() {
  const { courseId, lessonId } = useParams<{ courseId: string; lessonId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: draft, loading, error } = useApi<CourseDraft>(
    () => getAdminDraft(courseId!), [courseId],
  );

  const [graph, setGraph] = useState<LessonGraph>({ startNodeId: '', nodes: [], edges: [] });
  const [lessonTitle, setLessonTitle] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const nodes = graph.nodes;
  const edges = graph.edges;
  const startNodeId = graph.startNodeId;

  const moduleId = draft?.content_json?.modules?.find(
    (module: ContentModule) => module.lessons.some((lesson: ContentLesson) => lesson.id === lessonId),
  )?.id;

  useEffect(() => {
    if (!draft || initialized) {
      return;
    }

    setDraftVersion(draft.draft_version);
    for (const module of draft.content_json?.modules ?? []) {
      const lesson = module.lessons.find((item: ContentLesson) => item.id === lessonId);
      if (!lesson) {
        continue;
      }

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
    setInitialized(true);
  }, [draft, initialized, lessonId]);

  const updateGraph = useCallback((updater: (prev: LessonGraph) => LessonGraph) => {
    setGraph(prev => normalizeLessonGraph(updater(prev)));
  }, []);

  const notifyReorder = (clearedEdges: number) => {
    if (clearedEdges > 0) {
      setSaveError(`После переноса блока сброшено переходов: ${clearedEdges}. Проверьте связи веток.`);
    }
  };

  const updateNodeData = (nodeId: string, field: string, value: unknown) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, [field]: value } } : node,
      ),
    }));
  };

  const addNode = (type: NodeType) => {
    const newNode = createNode(type);
    updateGraph(prev => {
      if (type === 'terminal' && prev.nodes.some(node => node.type === 'terminal')) {
        return prev;
      }
      const terminalNode = prev.nodes.find(node => node.type === 'terminal');
      const nextNodes = [...prev.nodes];
      if (type !== 'terminal' && terminalNode) {
        const terminalIndex = nextNodes.findIndex(node => node.id === terminalNode.id);
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
      } else if (type !== 'terminal' && terminalNode && previousContentNode) {
        nextEdges = retargetNodeOutputs(nextEdges, previousContentNode, terminalNode.id, newNode.id);
        nextEdges = connectMissingNodeOutputs(nextEdges, newNode, terminalNode.id);
      } else if (previousContentNode) {
        nextEdges = connectMissingNodeOutputs(nextEdges, previousContentNode, newNode.id);
      }

      const nextStartNodeId = prev.startNodeId && nextNodes.some(node => node.id === prev.startNodeId)
        ? prev.startNodeId
        : (nextNodes[0]?.id ?? '');
      return { ...prev, nodes: nextNodes, edges: nextEdges, startNodeId: nextStartNodeId };
    });
  };

  const deleteNode = (nodeId: string) => {
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
  };

  const moveNodeUp = (index: number) => {
    if (index === 0) return;
    const result = reorderGraphNodes(graph, index, index - 1);
    setGraph(result.graph);
    notifyReorder(result.clearedEdges);
  };

  const moveNodeDown = (index: number) => {
    if (index >= graph.nodes.length - 1) return;
    const result = reorderGraphNodes(graph, index, index + 1);
    setGraph(result.graph);
    notifyReorder(result.clearedEdges);
  };

  const addOption = (nodeId: string, type: 'single_choice' | 'decision') => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = (node.data.options as Array<ChoiceOption | DecisionOption>) ?? [];
        const nextOption = type === 'single_choice'
          ? { option_id: generateId(), text: '', verdict: 'incorrect' as GraphVerdict, feedback: '' }
          : { option_id: generateId(), text: '' };
        return { ...node, data: { ...node.data, options: [...options, nextOption] } };
      }),
    }));
  };

  const removeOption = (nodeId: string, optionId: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = ((node.data.options as Array<ChoiceOption | DecisionOption>) ?? []).filter(option => option.option_id !== optionId);
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
    if (!draft || !courseId || !moduleId || !lessonId) {
      throw new Error('Черновик урока не найден');
    }
    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    setValidationErrors([]);
    try {
      const updatedModules = (draft.content_json?.modules ?? []).map((module: ContentModule) => {
        if (module.id !== moduleId) return module;
        return {
          ...module,
          lessons: module.lessons.map((lesson: ContentLesson) => {
            if (lesson.id !== lessonId) return lesson;
            const backendGraph = graphToBackendFormat(graph);
            return { ...lesson, title: lessonTitle, graph: backendGraph as unknown as LessonGraph };
          }),
        };
      });
      const result = await updateAdminDraft(courseId, {
        draft_version: draftVersion,
        title: draft.title,
        description: draft.description,
        age_min: draft.age_min,
        age_max: draft.age_max,
        cover_asset_id: draft.cover_asset_id,
        content_json: { modules: updatedModules },
      });
      setDraftVersion(result.draft_version);
      setSaveMsg('Сохранено!');
      setTimeout(() => setSaveMsg(''), 2000);
      return result.draft_version;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setSaving(false);
    }
  }, [courseId, draft, draftVersion, graph, lessonId, lessonTitle, moduleId]);

  const [, setPreviewing] = useState(false);
  const previewingRef = useRef(false);
  const handlePreview = useCallback(async () => {
    if (!courseId || !lessonId || previewingRef.current) return;
    previewingRef.current = true;
    const win = window.open('about:blank', '_blank');
    if (!win) {
      previewingRef.current = false;
      setSaveError('Разрешите всплывающие окна для предпросмотра');
      return;
    }
    setPreviewing(true);
    setValidationErrors([]);
    try {
      await handleSave();
      const session = await createAdminPreview(courseId, lessonId, location.pathname);
      win.location.href = `/admin/preview/${session.preview_session_id}?return_to=${encodeURIComponent(location.pathname)}`;
    } catch (err) {
      win.close();
      const message = err instanceof Error ? err.message : 'Ошибка предпросмотра';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
    } finally {
      previewingRef.current = false;
      setPreviewing(false);
    }
  }, [courseId, handleSave, lessonId, location.pathname]);

  if (loading) return <Spinner />;
  if (error) return <div className={styles.page}><div className={styles.error}>{error}</div></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate(`/admin/courses/${courseId}`)} type="button">
            &#8592;
          </button>
          <h1 className={styles.title}>{lessonTitle || 'Урок'}</h1>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={handlePreview} type="button">Превью</Button>
          <Button onClick={() => { void handleSave().catch(() => undefined); }} loading={saving} type="button">
            Сохранить
          </Button>
        </div>
      </div>

      {saveMsg && <div className={styles.saveNotice}>{saveMsg}</div>}
      {saveError && <div className={styles.error}>{saveError}</div>}
      {validationErrors.length > 0 && (
        <div className={styles.error}>
          <div>Что нужно исправить:</div>
          <ul style={{ margin: '8px 0 0 20px' }}>
            {validationErrors.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginBottom: 20 }}>
        <Input label="Название урока" value={lessonTitle} onChange={event => setLessonTitle(event.target.value)} />
      </div>

      <div className={styles.nodeList}>
        {nodes.length === 0 && (
          <EmptyState icon="🧩" title="Нет нод" description="Добавьте ноды для урока" />
        )}

        {nodes.map((node, index) => (
          <div key={node.id} className={styles.nodeCard}>
            <div className={styles.nodeHeader}>
              <div className={styles.nodeType}>
                <span className={styles.nodeTypeIcon}>{NODE_ICONS[node.type as NodeType]}</span>
                <span className={styles.nodeTypeName}>{NODE_LABELS[node.type as NodeType]}</span>
                {node.id === startNodeId && <Badge color="teal">Старт</Badge>}
              </div>
              <div className={styles.nodeActions}>
                <Button size="sm" variant="ghost" onClick={() => moveNodeUp(index)} disabled={index === 0} type="button">
                  &uarr;
                </Button>
                <Button size="sm" variant="ghost" onClick={() => moveNodeDown(index)} disabled={index === nodes.length - 1} type="button">
                  &darr;
                </Button>
                {node.type !== 'terminal' && (
                  <Button size="sm" variant="ghost" onClick={() => deleteNode(node.id)} type="button">
                    Удалить
                  </Button>
                )}
              </div>
            </div>

            <div className={styles.nodeBody}>
              {node.type === 'story' && (
                <>
                  <Input
                    label="Персонаж"
                    value={storyData(node).speaker ?? ''}
                    onChange={event => updateNodeData(node.id, 'speaker', event.target.value)}
                    placeholder="Имя персонажа (необязательно)"
                  />
                  <Textarea
                    label="Текст"
                    value={storyData(node).text}
                    onChange={event => updateNodeData(node.id, 'text', event.target.value)}
                    placeholder="Текст истории..."
                    rows={4}
                  />
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
                </>
              )}

              {node.type === 'single_choice' && (() => {
                const data = choiceData(node);
                return (
                  <>
                    <Textarea
                      label="Вопрос"
                      value={data.question_text}
                      onChange={event => updateNodeData(node.id, 'question_text', event.target.value)}
                      placeholder="Текст вопроса..."
                      rows={2}
                    />
                    <div className={styles.nodeFieldGroup}>
                      <div className={styles.nodeFieldLabel}>Варианты ответа</div>
                      {data.options.map(option => (
                        <div key={option.option_id} className={styles.optionBlock}>
                          <div className={styles.optionRow}>
                            <input
                              className={styles.optionInput}
                              value={option.text}
                              onChange={event => updateChoiceOption(node.id, option.option_id, { text: event.target.value })}
                              placeholder="Вариант ответа"
                            />
                            {data.options.length > 2 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeOption(node.id, option.option_id)}
                                type="button"
                                aria-label="Удалить вариант"
                                title="Удалить вариант"
                              >
                                &times;
                              </Button>
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
                            onChange={event => updateChoiceOption(node.id, option.option_id, { feedback: event.target.value })}
                            placeholder="Что увидит ученик после выбора этого варианта"
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
                      <Button size="sm" variant="secondary" onClick={() => addOption(node.id, 'single_choice')} type="button">
                        + Вариант
                      </Button>
                    </div>
                  </>
                );
              })()}

              {node.type === 'decision' && (() => {
                const data = decisionData(node);
                return (
                  <>
                    <Textarea
                      label="Текст выбора"
                      value={data.question_text}
                      onChange={event => updateNodeData(node.id, 'question_text', event.target.value)}
                      placeholder="Опишите сюжетный выбор..."
                      rows={2}
                    />
                    <div className={styles.nodeFieldGroup}>
                      <div className={styles.nodeFieldLabel}>Варианты сюжетного выбора</div>
                      {data.options.map(option => (
                        <div key={option.option_id} className={styles.optionBlock}>
                          <div className={styles.optionRow}>
                            <input
                              className={styles.optionInput}
                              value={option.text}
                              onChange={event => updateDecisionOption(node.id, option.option_id, { text: event.target.value })}
                              placeholder="Вариант выбора"
                            />
                            {data.options.length > 2 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeOption(node.id, option.option_id)}
                                type="button"
                                aria-label="Удалить вариант"
                                title="Удалить вариант"
                              >
                                &times;
                              </Button>
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
                      <Button size="sm" variant="secondary" onClick={() => addOption(node.id, 'decision')} type="button">
                        + Вариант выбора
                      </Button>
                    </div>
                  </>
                );
              })()}

              {node.type === 'free_text' && (() => {
                const data = freeTextData(node);
                return (
                  <>
                    <Textarea
                      label="Вопрос"
                      value={data.question_text}
                      onChange={event => updateNodeData(node.id, 'question_text', event.target.value)}
                      placeholder="Текст вопроса..."
                      rows={2}
                    />
                    <Input
                      label="Эталонный ответ"
                      value={data.reference_answer}
                      onChange={event => updateNodeData(node.id, 'reference_answer', event.target.value)}
                      placeholder="Правильный ответ"
                    />
                    <div style={{ border: 'var(--border-thin)', borderRadius: 12, padding: '12px 14px', background: 'rgba(13,148,136,0.06)' }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>Как писать критерии оценивания</div>
                      <div style={{ fontSize: '0.92rem', lineHeight: 1.5 }}>
                        Формулируйте наблюдаемые признаки ответа. Для `правильно` перечислите обязательные идеи.
                        Для `почти правильно` опишите, что уже есть, но чего ещё не хватает. Для `неверно`
                        укажите типичные ошибки, отсутствие ключевой мысли или неверный вывод.
                      </div>
                    </div>
                    <Textarea
                      label="Критерии правильного ответа"
                      value={data.criteria_correct}
                      onChange={event => updateNodeData(node.id, 'criteria_correct', event.target.value)}
                      placeholder="Что обязательно должно быть в сильном ответе"
                      rows={2}
                    />
                    <Textarea
                      label="Критерии частично верного ответа"
                      value={data.criteria_partial}
                      onChange={event => updateNodeData(node.id, 'criteria_partial', event.target.value)}
                      placeholder="Что уже неплохо, но ещё не дотягивает до полного ответа"
                      rows={2}
                    />
                    <Textarea
                      label="Критерии неверного ответа"
                      value={data.criteria_incorrect}
                      onChange={event => updateNodeData(node.id, 'criteria_incorrect', event.target.value)}
                      placeholder="Какие ответы считаем неверными или не по делу"
                      rows={2}
                    />
                    <Textarea
                      label="Обратная связь при правильном ответе"
                      value={data.feedback_correct}
                      onChange={event => updateNodeData(node.id, 'feedback_correct', event.target.value)}
                      placeholder="Что увидит ученик при правильном ответе"
                      rows={2}
                    />
                    <Textarea
                      label="Обратная связь при частично верном ответе"
                      value={data.feedback_partial}
                      onChange={event => updateNodeData(node.id, 'feedback_partial', event.target.value)}
                      placeholder="Что увидит ученик при частично верном ответе"
                      rows={2}
                    />
                    <Textarea
                      label="Обратная связь при неправильном ответе"
                      value={data.feedback_incorrect}
                      onChange={event => updateNodeData(node.id, 'feedback_incorrect', event.target.value)}
                      placeholder="Что увидит ученик при неправильном ответе"
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
                  </>
                );
              })()}

              {node.type === 'terminal' && (
                <Textarea
                  label="Текст завершения"
                  value={(node.data.text as string) ?? ''}
                  onChange={event => updateNodeData(node.id, 'text', event.target.value)}
                  placeholder="Сообщение в конце урока"
                  rows={2}
                />
              )}
            </div>

            {describeOutgoingEdges(node).length > 0 && (
              <div className={styles.edgeInfo}>
                {describeOutgoingEdges(node).map(line => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.addNodeBar}>
        <Button size="sm" variant="secondary" onClick={() => addNode('story')} type="button">📖 История</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('single_choice')} type="button">🔘 Выбор ответа</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('decision')} type="button">🧭 Развилка сюжета</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('free_text')} type="button">✏️ Свободный ответ</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('terminal')} type="button">🏁 Конец</Button>
      </div>
    </div>
  );
}
