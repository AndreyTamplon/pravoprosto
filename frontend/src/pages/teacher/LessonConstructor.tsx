import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getTeacherDraft,
  updateTeacherDraft,
  createTeacherPreview,
} from '../../api/client';
import type { CourseDraft, ContentModule, GraphNode, GraphEdge, LessonGraph } from '../../api/types';
import { Button, ComicPanel, Badge, Spinner, Textarea, Modal } from '../../components/ui';
import s from './LessonConstructor.module.css';

function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

interface StoryData {
  text: string;
  illustration_url?: string;
}

interface ChoiceOption {
  option_id: string;
  text: string;
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

export default function LessonConstructor() {
  const { courseId, moduleId, lessonId } = useParams<{
    courseId: string;
    moduleId: string;
    lessonId: string;
  }>();
  const navigate = useNavigate();

  const { data: draft, loading, error: loadError } = useApi<CourseDraft>(
    () => getTeacherDraft(courseId!),
    [courseId],
  );

  const [lessonTitle, setLessonTitle] = useState('');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [startNodeId, setStartNodeId] = useState('');

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Find our lesson in the draft
  useEffect(() => {
    if (!draft) return;
    for (const mod of draft.content_json?.modules ?? []) {
      if (mod.id !== moduleId) continue;
      const lesson = mod.lessons.find(l => l.id === lessonId);
      if (lesson) {
        setLessonTitle(lesson.title);
        setNodes(lesson.graph?.nodes ?? []);
        setEdges(lesson.graph?.edges ?? []);
        setStartNodeId(lesson.graph?.startNodeId ?? '');
      }
      break;
    }
  }, [draft, moduleId, lessonId]);

  // Auto-compute edges: simple linear DAG
  const recomputeEdges = useCallback((nodeList: GraphNode[]): GraphEdge[] => {
    const newEdges: GraphEdge[] = [];
    for (let i = 0; i < nodeList.length - 1; i++) {
      const from = nodeList[i];
      const to = nodeList[i + 1];
      if (from.type === 'single_choice') {
        // Conditional edges: correct -> next, incorrect -> next
        newEdges.push({ from: from.id, to: to.id, condition: 'any' });
      } else if (from.type === 'free_text') {
        newEdges.push({ from: from.id, to: to.id, condition: 'any' });
      } else {
        newEdges.push({ from: from.id, to: to.id });
      }
    }
    return newEdges;
  }, []);

  // Update nodes + recompute edges
  const updateNodes = useCallback(
    (updater: (prev: GraphNode[]) => GraphNode[]) => {
      setNodes(prev => {
        const next = updater(prev);
        setEdges(recomputeEdges(next));
        if (next.length > 0 && (!startNodeId || !next.find(n => n.id === startNodeId))) {
          setStartNodeId(next[0].id);
        }
        return next;
      });
    },
    [recomputeEdges, startNodeId],
  );

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
        feedback_incorrect: 'Попробуйте ещё раз',
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
    updateNodes(prev => [...prev, newNode]);
  };

  const removeNode = (nodeId: string) => {
    setConfirmAction({
      message: 'Удалить этот блок?',
      onConfirm: () => { setConfirmAction(null); updateNodes(prev => prev.filter(n => n.id !== nodeId)); },
    });
  };

  const moveNodeUp = (idx: number) => {
    if (idx === 0) return;
    updateNodes(prev => {
      const arr = [...prev];
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      return arr;
    });
  };

  const moveNodeDown = (idx: number) => {
    updateNodes(prev => {
      if (idx >= prev.length - 1) return prev;
      const arr = [...prev];
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      return arr;
    });
  };

  const updateNodeData = (nodeId: string, field: string, value: unknown) => {
    setNodes(prev =>
      prev.map(n => (n.id === nodeId ? { ...n, data: { ...n.data, [field]: value } } : n)),
    );
  };

  // Choice option helpers
  const addOption = (nodeId: string) => {
    setNodes(prev =>
      prev.map(n => {
        if (n.id !== nodeId) return n;
        const opts = (n.data.options as ChoiceOption[]) ?? [];
        return {
          ...n,
          data: {
            ...n.data,
            options: [...opts, { option_id: genId(), text: '' }],
          },
        };
      }),
    );
  };

  const removeOption = (nodeId: string, optionId: string) => {
    setNodes(prev =>
      prev.map(n => {
        if (n.id !== nodeId) return n;
        const opts = ((n.data.options as ChoiceOption[]) ?? []).filter(o => o.option_id !== optionId);
        const correctId = n.data.correct_option_id as string;
        return {
          ...n,
          data: {
            ...n.data,
            options: opts,
            correct_option_id: correctId === optionId ? (opts[0]?.option_id ?? '') : correctId,
          },
        };
      }),
    );
  };

  const updateOptionText = (nodeId: string, optionId: string, text: string) => {
    setNodes(prev =>
      prev.map(n => {
        if (n.id !== nodeId) return n;
        const opts = ((n.data.options as ChoiceOption[]) ?? []).map(o =>
          o.option_id === optionId ? { ...o, text } : o,
        );
        return { ...n, data: { ...n.data, options: opts } };
      }),
    );
  };

  const setCorrectOption = (nodeId: string, optionId: string) => {
    updateNodeData(nodeId, 'correct_option_id', optionId);
  };

  // Save
  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const graph: LessonGraph = {
        startNodeId: startNodeId || (nodes[0]?.id ?? ''),
        nodes,
        edges,
      };

      const updatedModules: ContentModule[] = (draft.content_json?.modules ?? []).map(mod => {
        if (mod.id !== moduleId) return mod;
        return {
          ...mod,
          lessons: mod.lessons.map(l =>
            l.id === lessonId ? { ...l, title: lessonTitle, graph } : l,
          ),
        };
      });

      await updateTeacherDraft(courseId!, {
        content_json: { modules: updatedModules },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }, [draft, courseId, moduleId, lessonId, lessonTitle, nodes, edges, startNodeId]);

  // Preview
  const handlePreview = useCallback(async () => {
    // Save first, then create preview session
    setPreviewing(true);
    try {
      await handleSave();
      const session = await createTeacherPreview(courseId!, lessonId!);
      navigate(`/teacher/preview/${session.session_id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка предпросмотра');
    } finally {
      setPreviewing(false);
    }
  }, [courseId, lessonId, handleSave, navigate]);

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
            <Button onClick={handleSave} disabled={saving} size="sm">
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
                            <div key={opt.option_id} className={s.optionRow}>
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
                                  title="Удалить вариант"
                                >
                                  &times;
                                </button>
                              )}
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
                    </div>
                  );
                })()}

                {/* Terminal node */}
                {node.type === 'terminal' && (
                  <div className={s.terminalContent}>
                    Конец этапа - ученик завершает прохождение
                  </div>
                )}

                {/* Edge info */}
                {edges.filter(e => e.from === node.id).length > 0 && (
                  <div className={s.edgeInfo}>
                    Далее &rarr;{' '}
                    {edges
                      .filter(e => e.from === node.id)
                      .map(e => {
                        const target = nodes.find(n => n.id === e.to);
                        const targetIdx = nodes.indexOf(target!);
                        return `#${targetIdx + 1} ${target ? (nodeTypeLabels[target.type]?.label ?? target.type) : e.to}`;
                      })
                      .join(', ')}
                    {edges.find(e => e.from === node.id)?.condition && (
                      <span> (условие: {edges.find(e => e.from === node.id)!.condition})</span>
                    )}
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
