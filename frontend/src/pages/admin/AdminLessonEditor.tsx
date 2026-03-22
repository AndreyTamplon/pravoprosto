import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getAdminDraft, updateAdminDraft, createAdminPreview } from '../../api/client';
import { Button, Badge, Spinner, EmptyState, Input, Textarea } from '../../components/ui';
import type { CourseDraft, GraphNode, GraphEdge, ContentModule, ContentLesson, LessonGraph } from '../../api/types';
import { graphToBackendFormat, graphFromBackendFormat, isBackendLessonGraph } from '../../api/types';
import { getDraftValidationErrors } from '../../utils/editorErrors';
import styles from './AdminLessonEditor.module.css';

type NodeType = 'story' | 'single_choice' | 'free_text' | 'terminal';

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

export default function AdminLessonEditor() {
  const { courseId, lessonId } = useParams<{ courseId: string; lessonId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: draft, loading, error } = useApi<CourseDraft>(
    () => getAdminDraft(courseId!), [courseId],
  );

  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [startNodeId, setStartNodeId] = useState('');
  const [lessonTitle, setLessonTitle] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Find moduleId by scanning all modules
  const moduleId = draft?.content_json?.modules?.find(
    (m: ContentModule) => m.lessons.some((l: ContentLesson) => l.id === lessonId),
  )?.id;

  // Initialize from draft
  useEffect(() => {
    if (draft && !initialized) {
      setDraftVersion(draft.draft_version);
      for (const mod of draft.content_json?.modules ?? []) {
        const lesson = mod.lessons.find((l: ContentLesson) => l.id === lessonId);
        if (lesson) {
          // Detect backend format (nodes have 'kind' not 'type') and convert
          const rawGraph = lesson.graph as unknown as Record<string, unknown>;
          if (isBackendLessonGraph(rawGraph)) {
            const converted = graphFromBackendFormat(rawGraph);
            if (isPlaceholderGraph(converted)) {
              setNodes([]);
              setEdges([]);
              setStartNodeId('');
            } else {
              setNodes(converted.nodes);
              setEdges(converted.edges);
              setStartNodeId(converted.startNodeId);
            }
          } else {
            if (isPlaceholderGraph(lesson.graph)) {
              setNodes([]);
              setEdges([]);
              setStartNodeId('');
            } else {
              setNodes(lesson.graph.nodes);
              setEdges(lesson.graph.edges);
              setStartNodeId(lesson.graph.startNodeId);
            }
          }
          setLessonTitle(lesson.title);
          break;
        }
      }
      setInitialized(true);
    }
  }, [draft, initialized, lessonId]);

  const handleSave = useCallback(async (): Promise<number> => {
    if (!draft || !courseId || !moduleId || !lessonId) {
      throw new Error('Черновик урока не найден');
    }
    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    setValidationErrors([]);
    try {
      const updatedModules = (draft.content_json?.modules ?? []).map((m: ContentModule) => {
        if (m.id !== moduleId) return m;
        return {
          ...m,
          lessons: m.lessons.map((l: ContentLesson) => {
            if (l.id !== lessonId) return l;
            const backendGraph = graphToBackendFormat({ startNodeId, nodes, edges });
            return { ...l, title: lessonTitle, graph: backendGraph as unknown as LessonGraph };
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
  }, [courseId, draft, draftVersion, edges, lessonId, lessonTitle, moduleId, nodes, startNodeId]);

  const handlePreview = useCallback(async () => {
    if (!courseId || !lessonId) return;
    setValidationErrors([]);
    try {
      await handleSave();
      const session = await createAdminPreview(courseId, lessonId, location.pathname);
      window.open(`/admin/preview/${session.preview_session_id}?return_to=${encodeURIComponent(location.pathname)}`, '_blank');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка предпросмотра';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
    }
  }, [courseId, handleSave, lessonId, location.pathname]);

  function addNode(type: NodeType) {
    const id = generateId();
    let data: Record<string, unknown> = {};
    if (type === 'story') data = { text: '', speaker: '' };
    if (type === 'single_choice') {
      const firstOptionId = generateId();
      const secondOptionId = generateId();
      data = {
        question_text: '',
        options: [
          { option_id: firstOptionId, text: '' },
          { option_id: secondOptionId, text: '' },
        ],
        correct_option_id: firstOptionId,
        feedback_correct: 'Правильно!',
        feedback_incorrect: 'Попробуйте ещё раз.',
      };
    }
    if (type === 'free_text') data = { question_text: '', reference_answer: '', criteria: '', feedback_text: '' };
    if (type === 'terminal') data = { text: 'Миссия завершена!' };

    const terminalNode = nodes.find(n => n.type === 'terminal');
    if (type === 'terminal') {
      if (terminalNode) return;
      const contentNodes = nodes.filter(n => n.type !== 'terminal');
      const newTerminalNode: GraphNode = { id, type, data };
      const rebuiltEdges = [...edges.filter(e => e.to !== id && e.from !== id)];
      const previousContentNode = contentNodes[contentNodes.length - 1];
      if (previousContentNode) {
        rebuiltEdges.push({ from: previousContentNode.id, to: id });
      }
      setNodes([...contentNodes, newTerminalNode]);
      setEdges(rebuiltEdges);
      if (!startNodeId && contentNodes.length === 0) {
        setStartNodeId(id);
      }
      return;
    }

    const newNode: GraphNode = { id, type, data };
    const newNodes = [...nodes.filter(n => n.type !== 'terminal'), newNode, ...(terminalNode ? [terminalNode] : [])];

    // Auto-wire edge: previous last content node -> new node -> terminal
    const contentNodes = newNodes.filter(n => n.type !== 'terminal');
    const newEdges = [...edges.filter(e => e.to !== id && e.from !== id)];
    if (contentNodes.length >= 2) {
      const prevNode = contentNodes[contentNodes.length - 2];
      // Remove old edge from prev to terminal
      const filtered = newEdges.filter(e => !(e.from === prevNode.id && e.to === terminalNode?.id));
      filtered.push({ from: prevNode.id, to: id });
      if (terminalNode) filtered.push({ from: id, to: terminalNode.id });
      setEdges(filtered);
    } else {
      if (terminalNode) newEdges.push({ from: id, to: terminalNode.id });
      setEdges(newEdges);
    }

    setNodes(newNodes);
    if (!startNodeId || startNodeId === terminalNode?.id) setStartNodeId(id);
  }

  function deleteNode(nodeId: string) {
    setNodes(prev => prev.filter(n => n.id !== nodeId));
    setEdges(prev => {
      // Reconnect edges around the deleted node
      const inEdges = prev.filter(e => e.to === nodeId);
      const outEdges = prev.filter(e => e.from === nodeId);
      const otherEdges = prev.filter(e => e.from !== nodeId && e.to !== nodeId);
      // Connect each predecessor to each successor
      const bridgeEdges: GraphEdge[] = [];
      for (const inE of inEdges) {
        for (const outE of outEdges) {
          bridgeEdges.push({ from: inE.from, to: outE.to });
        }
      }
      return [...otherEdges, ...bridgeEdges];
    });
    if (startNodeId === nodeId) {
      const outEdge = edges.find(e => e.from === nodeId);
      if (outEdge) setStartNodeId(outEdge.to);
    }
  }

  function updateNodeData(nodeId: string, field: string, value: unknown) {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, data: { ...n.data, [field]: value } } : n));
  }

  function addOption(nodeId: string) {
    setNodes(prev => prev.map(n => {
      if (n.id !== nodeId) return n;
      const opts = (n.data.options as Array<{ option_id: string; text: string }>) ?? [];
      return { ...n, data: { ...n.data, options: [...opts, { option_id: generateId(), text: '' }] } };
    }));
  }

  function updateOptionText(nodeId: string, optionId: string, text: string) {
    setNodes(prev => prev.map(n => {
      if (n.id !== nodeId) return n;
      const opts = (n.data.options as Array<{ option_id: string; text: string }>) ?? [];
      return { ...n, data: { ...n.data, options: opts.map(o => o.option_id === optionId ? { ...o, text } : o) } };
    }));
  }

  function removeOption(nodeId: string, optionId: string) {
    setNodes(prev => prev.map(n => {
      if (n.id !== nodeId) return n;
      const opts = (n.data.options as Array<{ option_id: string; text: string }>) ?? [];
      const nextOptions = opts.filter(o => o.option_id !== optionId);
      const correctOptionId = (n.data.correct_option_id as string) ?? '';
      return {
        ...n,
        data: {
          ...n.data,
          options: nextOptions,
          correct_option_id: correctOptionId === optionId ? (nextOptions[0]?.option_id ?? '') : correctOptionId,
        },
      };
    }));
  }

  function setCorrectOption(nodeId: string, optionId: string) {
    updateNodeData(nodeId, 'correct_option_id', optionId);
  }

  function getNextNodeLabel(nodeId: string): string {
    const edge = edges.find(e => e.from === nodeId);
    if (!edge) return '';
    const target = nodes.find(n => n.id === edge.to);
    return target ? `-> ${NODE_LABELS[target.type as NodeType] ?? target.type} (${edge.to})` : '';
  }

  if (loading) return <Spinner />;
  if (error) return <div className={styles.page}><div className={styles.error}>{error}</div></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate(`/admin/courses/${courseId}`)}>&#8592;</button>
          <h1 className={styles.title}>{lessonTitle || 'Урок'}</h1>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={handlePreview}>Превью</Button>
          <Button onClick={() => { void handleSave().catch(() => undefined); }} loading={saving}>Сохранить</Button>
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
        <Input label="Название урока" value={lessonTitle} onChange={e => setLessonTitle(e.target.value)} />
      </div>

      <div className={styles.nodeList}>
        {nodes.length === 0 && (
          <EmptyState icon="🧩" title="Нет нод" description="Добавьте ноды для урока" />
        )}

        {nodes.map(node => (
          <div key={node.id} className={styles.nodeCard}>
            <div className={styles.nodeHeader}>
              <div className={styles.nodeType}>
                <span className={styles.nodeTypeIcon}>{NODE_ICONS[node.type as NodeType]}</span>
                <span className={styles.nodeTypeName}>{NODE_LABELS[node.type as NodeType] ?? node.type}</span>
                {node.id === startNodeId && <Badge color="teal">Старт</Badge>}
              </div>
              <div className={styles.nodeActions}>
                {node.type !== 'terminal' && (
                  <Button size="sm" variant="ghost" onClick={() => deleteNode(node.id)}>Удалить</Button>
                )}
              </div>
            </div>

            <div className={styles.nodeBody}>
              {node.type === 'story' && (
                <>
                  <Input
                    label="Персонаж"
                    value={(node.data.speaker as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'speaker', e.target.value)}
                    placeholder="Имя персонажа (необязательно)"
                  />
                  <Textarea
                    label="Текст"
                    value={(node.data.text as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'text', e.target.value)}
                    placeholder="Текст истории..."
                    rows={4}
                  />
                </>
              )}

              {node.type === 'single_choice' && (
                <>
                  <Textarea
                    label="Вопрос"
                    value={(node.data.question_text as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                    placeholder="Текст вопроса..."
                    rows={2}
                  />
                  <div className={styles.nodeFieldGroup}>
                    <div className={styles.nodeFieldLabel}>Варианты ответа</div>
                    {((node.data.options as Array<{ option_id: string; text: string }>) ?? []).map(opt => (
                      <div key={opt.option_id} className={styles.optionRow}>
                        <button
                          className={`${styles.correctToggle} ${((node.data.correct_option_id as string) ?? '') === opt.option_id ? styles.correctToggleActive : ''}`}
                          onClick={() => setCorrectOption(node.id, opt.option_id)}
                          type="button"
                          title="Отметить правильный вариант"
                        >
                          {((node.data.correct_option_id as string) ?? '') === opt.option_id ? '✓' : ''}
                        </button>
                        <input
                          className={styles.optionInput}
                          value={opt.text}
                          onChange={e => updateOptionText(node.id, opt.option_id, e.target.value)}
                          placeholder="Вариант ответа"
                          style={{ padding: '8px 12px', border: '2px solid #1E293B', borderRadius: 8, fontFamily: 'var(--font-family)', flex: 1 }}
                        />
                        <Button size="sm" variant="ghost" onClick={() => removeOption(node.id, opt.option_id)}>
                          &times;
                        </Button>
                      </div>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => addOption(node.id)}>+ Вариант</Button>
                  </div>
                  <Textarea
                    label="Обратная связь (правильно)"
                    value={(node.data.feedback_correct as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'feedback_correct', e.target.value)}
                    placeholder="Что увидит ученик при правильном ответе"
                    rows={2}
                  />
                  <Textarea
                    label="Обратная связь (неправильно)"
                    value={(node.data.feedback_incorrect as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'feedback_incorrect', e.target.value)}
                    placeholder="Что увидит ученик при неправильном ответе"
                    rows={2}
                  />
                </>
              )}

              {node.type === 'free_text' && (
                <>
                  <Textarea
                    label="Вопрос"
                    value={(node.data.question_text as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'question_text', e.target.value)}
                    placeholder="Текст вопроса..."
                    rows={2}
                  />
                  <Input
                    label="Эталонный ответ"
                    value={((node.data.reference_answer ?? node.data.expected_answer) as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'reference_answer', e.target.value)}
                    placeholder="Правильный ответ"
                  />
                  <Textarea
                    label="Критерии оценивания"
                    value={(node.data.criteria as string) ?? ''}
                    onChange={e => updateNodeData(node.id, 'criteria', e.target.value)}
                    placeholder="На что ориентироваться при оценке ответа"
                    rows={2}
                  />
                </>
              )}

              {node.type === 'terminal' && (
                <Textarea
                  label="Текст завершения"
                  value={(node.data.text as string) ?? ''}
                  onChange={e => updateNodeData(node.id, 'text', e.target.value)}
                  placeholder="Сообщение в конце урока"
                  rows={2}
                />
              )}
            </div>

            {node.type !== 'terminal' && (
              <div className={styles.edgeInfo}>
                {getNextNodeLabel(node.id)}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.addNodeBar}>
        <Button size="sm" variant="secondary" onClick={() => addNode('story')}>📖 История</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('single_choice')}>🔘 Выбор ответа</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('free_text')}>✏️ Свободный ответ</Button>
        <Button size="sm" variant="secondary" onClick={() => addNode('terminal')}>🏁 Конец</Button>
      </div>
    </div>
  );
}
