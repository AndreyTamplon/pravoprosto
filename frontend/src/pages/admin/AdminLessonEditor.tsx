import { useState, useCallback, useEffect } from 'react';
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
import { getDraftValidationErrors } from '../../utils/editorErrors';
import styles from './AdminLessonEditor.module.css';

type NodeType = 'story' | 'single_choice' | 'free_text' | 'terminal';

type StoryData = {
  text: string;
  speaker?: string;
};

type SingleChoiceData = {
  question_text: string;
  options: ChoiceOption[];
  correct_option_id: string;
  feedback_correct: string;
  feedback_incorrect: string;
};

type FreeTextData = {
  question_text: string;
  reference_answer: string;
  criteria: string;
  feedback_text: string;
};

const NODE_ICONS: Record<NodeType, string> = {
  story: '📖',
  single_choice: '🔘',
  free_text: '✏️',
  terminal: '🏁',
};

const NODE_LABELS: Record<NodeType, string> = {
  story: 'История',
  single_choice: 'Выбор ответа',
  free_text: 'Свободный ответ',
  terminal: 'Конец',
};

function storyData(node: GraphNode): StoryData {
  return {
    text: (node.data.text as string) ?? '',
    speaker: (node.data.speaker as string) ?? '',
  };
}

function choiceData(node: GraphNode): SingleChoiceData {
  return {
    question_text: (node.data.question_text as string) ?? '',
    options: (node.data.options as ChoiceOption[]) ?? [],
    correct_option_id: (node.data.correct_option_id as string) ?? '',
    feedback_correct: (node.data.feedback_correct as string) ?? '',
    feedback_incorrect: (node.data.feedback_incorrect as string) ?? '',
  };
}

function freeTextData(node: GraphNode): FreeTextData {
  return {
    question_text: (node.data.question_text as string) ?? '',
    reference_answer: (node.data.reference_answer as string) ?? '',
    criteria: (node.data.criteria as string) ?? '',
    feedback_text: (node.data.feedback_text as string) ?? '',
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
  return `#${index + 1} ${NODE_LABELS[node.type] ?? node.type}`;
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

  const updateNodeData = (nodeId: string, field: string, value: unknown) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, [field]: value } } : node,
      ),
    }));
  };

  const addNode = (type: NodeType) => {
    const newNode: GraphNode = { id: generateId(), type, data: {} };
    if (type === 'story') {
      newNode.data = { text: '', speaker: '' };
    } else if (type === 'single_choice') {
      const firstOptionId = generateId();
      const secondOptionId = generateId();
      newNode.data = {
        question_text: '',
        options: [
          { option_id: firstOptionId, text: '' },
          { option_id: secondOptionId, text: '' },
        ],
        correct_option_id: firstOptionId,
        feedback_correct: 'Правильно!',
        feedback_incorrect: 'Неправильно.',
      };
    } else if (type === 'free_text') {
      newNode.data = { question_text: '', reference_answer: '', criteria: '', feedback_text: '' };
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

  const addOption = (nodeId: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = (node.data.options as ChoiceOption[]) ?? [];
        return {
          ...node,
          data: {
            ...node.data,
            options: [...options, { option_id: generateId(), text: '' }],
          },
        };
      }),
    }));
  };

  const updateOptionText = (nodeId: string, optionId: string, text: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = ((node.data.options as ChoiceOption[]) ?? []).map(option =>
          option.option_id === optionId ? { ...option, text } : option,
        );
        return { ...node, data: { ...node.data, options } };
      }),
    }));
  };

  const removeOption = (nodeId: string, optionId: string) => {
    updateGraph(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => {
        if (node.id !== nodeId) return node;
        const options = ((node.data.options as ChoiceOption[]) ?? []).filter(option => option.option_id !== optionId);
        const correctId = (node.data.correct_option_id as string) ?? '';
        return {
          ...node,
          data: {
            ...node.data,
            options,
            correct_option_id: correctId === optionId ? (options[0]?.option_id ?? '') : correctId,
          },
        };
      }),
      edges: prev.edges.filter(edge => !(
        edge.from === nodeId
        && edge.condition === optionEdgeCondition(optionId)
      )),
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
      return choiceData(node).options.flatMap(option => {
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

  const handlePreview = useCallback(async () => {
    if (!courseId || !lessonId) return;
    setValidationErrors([]);
    try {
      await handleSave();
      const session = await createAdminPreview(courseId, lessonId, location.pathname);
      window.open(
        `/admin/preview/${session.preview_session_id}?return_to=${encodeURIComponent(location.pathname)}`,
        '_blank',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка предпросмотра';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
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

        {nodes.map(node => (
          <div key={node.id} className={styles.nodeCard}>
            <div className={styles.nodeHeader}>
              <div className={styles.nodeType}>
                <span className={styles.nodeTypeIcon}>{NODE_ICONS[node.type]}</span>
                <span className={styles.nodeTypeName}>{NODE_LABELS[node.type]}</span>
                {node.id === startNodeId && <Badge color="teal">Старт</Badge>}
              </div>
              <div className={styles.nodeActions}>
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
                            <button
                              className={`${styles.correctToggle} ${data.correct_option_id === option.option_id ? styles.correctToggleActive : ''}`}
                              onClick={() => setCorrectOption(node.id, option.option_id)}
                              type="button"
                              title="Отметить правильный вариант"
                            >
                              {data.correct_option_id === option.option_id ? '✓' : ''}
                            </button>
                            <input
                              className={styles.optionInput}
                              value={option.text}
                              onChange={event => updateOptionText(node.id, option.option_id, event.target.value)}
                              placeholder="Вариант ответа"
                            />
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
                          </div>
                          <Select
                            label="Переход после этого ответа"
                            value={getGraphEdgeTargetWithFallback(edges, node.id, optionEdgeCondition(option.option_id))}
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
                      <Button size="sm" variant="secondary" onClick={() => addOption(node.id)} type="button">
                        + Вариант
                      </Button>
                    </div>
                    <Textarea
                      label="Обратная связь (правильно)"
                      value={data.feedback_correct}
                      onChange={event => updateNodeData(node.id, 'feedback_correct', event.target.value)}
                      placeholder="Что увидит ученик при правильном ответе"
                      rows={2}
                    />
                    <Textarea
                      label="Обратная связь (неправильно)"
                      value={data.feedback_incorrect}
                      onChange={event => updateNodeData(node.id, 'feedback_incorrect', event.target.value)}
                      placeholder="Что увидит ученик при неправильном ответе"
                      rows={2}
                    />
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
                    <Textarea
                      label="Критерии оценивания"
                      value={data.criteria}
                      onChange={event => updateNodeData(node.id, 'criteria', event.target.value)}
                      placeholder="На что ориентироваться при оценке ответа"
                      rows={2}
                    />
                    <Textarea
                      label="Обратная связь"
                      value={data.feedback_text}
                      onChange={event => updateNodeData(node.id, 'feedback_text', event.target.value)}
                      placeholder="Текст обратной связи"
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
        <Button size="sm" variant="secondary" onClick={() => addNode('free_text')} type="button">✏️ Свободный ответ</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('terminal')} type="button">🏁 Конец</Button>
      </div>
    </div>
  );
}
