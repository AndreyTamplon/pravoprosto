import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getTeacherDraft,
  updateTeacherDraft,
  submitTeacherReview,
  getTeacherReviewStatus,
  createTeacherAccessLink,
  getTeacherAccessLinks,
  revokeTeacherAccessLink,
  archiveTeacherCourse,
} from '../../api/client';
import { graphToBackendFormat, isBackendLessonGraph } from '../../api/types';
import type { CourseDraft, ContentModule, ContentLesson, ReviewStatus, AccessLink } from '../../api/types';
import { Button, ComicPanel, Badge, Spinner, Modal, Input, Textarea } from '../../components/ui';
import { getDraftValidationErrors, parseOptionalInteger, validateAgeRange } from '../../utils/editorErrors';
import s from './CourseConstructor.module.css';

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const emptyGraph = () => ({
  startNodeId: 'start',
  nodes: [
    { id: 'start', type: 'story' as const, data: { text: '' } },
    { id: 'end', type: 'terminal' as const, data: { text: 'Миссия завершена!' } },
  ],
  edges: [{ from: 'start', to: 'end' }],
});

function serializeModules(modules: ContentModule[]): ContentModule[] {
  return modules.map(module => ({
    ...module,
    lessons: module.lessons.map(lesson => {
      const rawGraph = lesson.graph as unknown as Record<string, unknown>;
      return {
        ...lesson,
        graph: (isBackendLessonGraph(rawGraph) ? rawGraph : graphToBackendFormat(lesson.graph)) as unknown as ContentLesson['graph'],
      };
    }),
  }));
}

const workflowBadge: Record<string, { label: string; color: 'yellow' | 'blue' | 'red' | 'lime' | 'gray' }> = {
  editing: { label: 'Редактирование', color: 'yellow' },
  in_review: { label: 'На проверке', color: 'blue' },
  changes_requested: { label: 'Нужны правки', color: 'red' },
  published: { label: 'Опубликован', color: 'lime' },
  archived: { label: 'В архиве', color: 'gray' },
};

export default function CourseConstructor() {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();

  const { data: draft, loading, error: loadError, reload } = useApi<CourseDraft>(
    () => getTeacherDraft(courseId!),
    [courseId],
  );
  const { data: reviewStatus, reload: reloadReview } = useApi<ReviewStatus>(
    () => getTeacherReviewStatus(courseId!),
    [courseId],
  );
  const { data: accessLinks, reload: reloadLinks } = useApi<AccessLink[]>(
    () => getTeacherAccessLinks(courseId!),
    [courseId],
  );

  // Local editable state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [modules, setModules] = useState<ContentModule[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [draftVersion, setDraftVersion] = useState<number>(0);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [confirmAction, setConfirmAction] = useState<{ type: string; message: string; onConfirm: () => void } | null>(null);

  // Share modal
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  const [copied, setCopied] = useState(false);

  // Initialize form state from draft
  useEffect(() => {
    if (draft) {
      setTitle(draft.title);
      setDescription(draft.description);
      setAgeMin(draft.age_min?.toString() ?? '');
      setAgeMax(draft.age_max?.toString() ?? '');
      setModules(draft.content_json?.modules ?? []);
      setDraftVersion(draft.draft_version);
    }
  }, [draft]);

  const saveCurrentDraft = useCallback(async (showSavedState = false): Promise<number> => {
    if (!courseId) {
      throw new Error('Курс не найден');
    }

    const parsedAgeMin = parseOptionalInteger('Возраст от', ageMin);
    const parsedAgeMax = parseOptionalInteger('Возраст до', ageMax);
    validateAgeRange(parsedAgeMin, parsedAgeMax);

    const res = await updateTeacherDraft(courseId, {
      draft_version: draftVersion,
      title,
      description,
      age_min: parsedAgeMin,
      age_max: parsedAgeMax,
      cover_asset_id: draft?.cover_asset_id,
      content_json: { modules: serializeModules(modules) },
    });

    setDraftVersion(res.draft_version);
    if (showSavedState) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
    return res.draft_version;
  }, [ageMax, ageMin, courseId, description, draft?.cover_asset_id, draftVersion, modules, title]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setValidationErrors([]);
    try {
      await saveCurrentDraft(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setError(details.length > 0 ? null : message);
    } finally {
      setSaving(false);
    }
  }, [saveCurrentDraft]);

  const doSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setValidationErrors([]);
    try {
      await saveCurrentDraft();
      await submitTeacherReview(courseId!);
      reload();
      reloadReview();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ошибка отправки';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setError(details.length > 0 ? null : message);
    } finally {
      setSubmitting(false);
    }
  }, [courseId, reload, reloadReview, saveCurrentDraft]);

  const handleSubmit = useCallback(() => {
    setConfirmAction({
      type: 'submit',
      message: 'Отправить курс на проверку?',
      onConfirm: () => { setConfirmAction(null); doSubmit(); },
    });
  }, [doSubmit]);

  const doArchive = useCallback(async () => {
    setArchiving(true);
    setValidationErrors([]);
    try {
      await archiveTeacherCourse(courseId!);
      navigate('/teacher');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка архивации');
    } finally {
      setArchiving(false);
    }
  }, [courseId, navigate]);

  const handleArchive = useCallback(() => {
    setConfirmAction({
      type: 'archive',
      message: 'Архивировать курс? Это действие нельзя отменить.',
      onConfirm: () => { setConfirmAction(null); doArchive(); },
    });
  }, [doArchive]);

  // Module operations
  const addModule = () => {
    const newMod: ContentModule = {
      id: generateId(),
      title: `Модуль ${modules.length + 1}`,
      lessons: [],
    };
    setModules([...modules, newMod]);
    setExpanded(prev => ({ ...prev, [newMod.id]: true }));
  };

  const updateModuleTitle = (modId: string, newTitle: string) => {
    setModules(modules.map(m => (m.id === modId ? { ...m, title: newTitle } : m)));
  };

  const removeModule = (modId: string) => {
    setConfirmAction({
      type: 'removeModule',
      message: 'Удалить модуль и все его этапы?',
      onConfirm: () => { setConfirmAction(null); setModules(modules.filter(m => m.id !== modId)); },
    });
  };

  const toggleModule = (modId: string) => {
    setExpanded(prev => ({ ...prev, [modId]: !prev[modId] }));
  };

  const moveModuleUp = (modIdx: number) => {
    if (modIdx <= 0) return;
    setModules(prev => {
      const arr = [...prev];
      [arr[modIdx - 1], arr[modIdx]] = [arr[modIdx], arr[modIdx - 1]];
      return arr;
    });
  };

  const moveModuleDown = (modIdx: number) => {
    setModules(prev => {
      if (modIdx >= prev.length - 1) return prev;
      const arr = [...prev];
      [arr[modIdx], arr[modIdx + 1]] = [arr[modIdx + 1], arr[modIdx]];
      return arr;
    });
  };

  // Lesson operations within a module
  const addLesson = (modId: string) => {
    setModules(
      modules.map(m => {
        if (m.id !== modId) return m;
        const newLesson: ContentLesson = {
          id: generateId(),
          title: `Этап ${m.lessons.length + 1}`,
          graph: emptyGraph(),
        };
        return { ...m, lessons: [...m.lessons, newLesson] };
      }),
    );
  };

  const removeLesson = (modId: string, lessonId: string) => {
    setModules(
      modules.map(m => {
        if (m.id !== modId) return m;
        return { ...m, lessons: m.lessons.filter(l => l.id !== lessonId) };
      }),
    );
  };

  const moveLessonUp = (modId: string, lessonIdx: number) => {
    if (lessonIdx === 0) return;
    setModules(
      modules.map(m => {
        if (m.id !== modId) return m;
        const arr = [...m.lessons];
        [arr[lessonIdx - 1], arr[lessonIdx]] = [arr[lessonIdx], arr[lessonIdx - 1]];
        return { ...m, lessons: arr };
      }),
    );
  };

  const moveLessonDown = (modId: string, lessonIdx: number) => {
    setModules(
      modules.map(m => {
        if (m.id !== modId) return m;
        if (lessonIdx >= m.lessons.length - 1) return m;
        const arr = [...m.lessons];
        [arr[lessonIdx], arr[lessonIdx + 1]] = [arr[lessonIdx + 1], arr[lessonIdx]];
        return { ...m, lessons: arr };
      }),
    );
  };

  // Access links
  const handleCreateLink = useCallback(async () => {
    setCreatingLink(true);
    setError(null);
    setValidationErrors([]);
    try {
      await createTeacherAccessLink(courseId!);
      reloadLinks();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка создания ссылки');
    } finally {
      setCreatingLink(false);
    }
  }, [courseId, reloadLinks]);

  const handleRevokeLink = useCallback(async (linkId: string) => {
    await revokeTeacherAccessLink(linkId);
    reloadLinks();
  }, [reloadLinks]);

  const handleCopy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) return <Spinner text="Загрузка курса..." />;
  if (loadError) return <div className={s.error}>{loadError}</div>;
  if (!draft) return null;

  const ws = draft.workflow_status === 'editing' && draft.has_published_revision
    ? workflowBadge.published
    : (workflowBadge[draft.workflow_status] ?? workflowBadge.editing);
  const isEditable = draft.workflow_status === 'editing' || draft.workflow_status === 'changes_requested';
  const activeLinks = accessLinks?.filter(l => l.status === 'active') ?? [];

  const handleEditLesson = async (lessonId: string) => {
    if (!courseId) return;

    setError(null);
    if (!isEditable) {
      navigate(`/teacher/courses/${courseId}/lessons/${lessonId}`);
      return;
    }

    setSaving(true);
    setSaved(false);
    setValidationErrors([]);
    try {
      await saveCurrentDraft();
      navigate(`/teacher/courses/${courseId}/lessons/${lessonId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
      setValidationErrors(getDraftValidationErrors(err).map(item => item.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.page}>
      <Button variant="ghost" className={s.backBtn} onClick={() => navigate('/teacher')}>
        &larr; К списку курсов
      </Button>

      {/* Header */}
      <ComicPanel className={s.headerPanel}>
        <div className={s.headerTop}>
          <div className={s.titleRow}>
            <input
              className={s.titleInput}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Название миссии..."
              disabled={!isEditable}
            />
          </div>
          <div className={s.headerActions}>
            <Button onClick={handleSave} disabled={saving || !isEditable} size="sm">
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
            {isEditable && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Отправка...' : 'На проверку'}
              </Button>
            )}
            {draft.has_published_revision !== false && (
              <Button variant="ghost" size="sm" onClick={() => setShareModalOpen(true)}>
                Поделиться
              </Button>
            )}
            {saved && <span className={s.saved}>Сохранено!</span>}
          </div>
        </div>

        <div className={s.statusRow}>
          <Badge color={ws.color}>{ws.label}</Badge>
          {reviewStatus?.status === 'pending' && <Badge color="blue">Ожидает проверки</Badge>}
        </div>

        {draft.workflow_status === 'changes_requested' && draft.last_review_comment && (
          <div className={s.reviewAlert}>
            <div className={s.reviewAlertTitle}>Комментарий модератора:</div>
            {draft.last_review_comment}
          </div>
        )}
      </ComicPanel>

      {error && <div className={s.error} style={{ marginBottom: 16 }}>{error}</div>}
      {validationErrors.length > 0 && (
        <div className={s.error} style={{ marginBottom: 16 }}>
          <div>Что нужно исправить:</div>
          <ul style={{ margin: '8px 0 0 20px' }}>
            {validationErrors.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Metadata */}
      <ComicPanel size="sm" className={s.metaSection}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Textarea
            label="Описание"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Описание курса..."
            disabled={!isEditable}
            rows={3}
          />
          <div className={s.metaRow}>
            <div className={s.metaField}>
              <Input
                label="Возраст от"
                type="number"
                value={ageMin}
                onChange={e => setAgeMin(e.target.value === '' ? '' : e.target.value)}
                placeholder="6"
                min={1}
                max={99}
                step={1}
                inputMode="numeric"
                disabled={!isEditable}
              />
            </div>
            <div className={s.metaField}>
              <Input
                label="Возраст до"
                type="number"
                value={ageMax}
                onChange={e => setAgeMax(e.target.value === '' ? '' : e.target.value)}
                placeholder="18"
                min={1}
                max={99}
                step={1}
                inputMode="numeric"
                disabled={!isEditable}
              />
            </div>
          </div>
        </div>
      </ComicPanel>

      {/* Modules & Lessons */}
      <div className={s.modulesSection}>
        <div className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>Модули и этапы</h2>
          {isEditable && (
            <Button size="sm" onClick={addModule}>+ Модуль</Button>
          )}
        </div>

        {modules.length === 0 ? (
          <ComicPanel flat>
            <p style={{ textAlign: 'center', color: 'var(--dark-light)', padding: 20 }}>
              Добавьте модуль, чтобы начать строить курс
            </p>
          </ComicPanel>
        ) : (
          modules.map((mod, modIdx) => {
            const isOpen = expanded[mod.id] ?? true;
            return (
              <ComicPanel key={mod.id} className={s.moduleCard}>
                <div className={s.moduleHeader} onClick={() => toggleModule(mod.id)}>
                  <div className={s.moduleLeft}>
                    <div className={s.moduleIndex}>{modIdx + 1}</div>
                    <input
                      className={s.moduleTitleInput}
                      value={mod.title}
                      onChange={e => {
                        e.stopPropagation();
                        updateModuleTitle(mod.id, e.target.value);
                      }}
                      onClick={e => e.stopPropagation()}
                      disabled={!isEditable}
                      placeholder="Название модуля..."
                    />
                  </div>
                  <div className={s.moduleActions}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--dark-light)' }}>
                      {mod.lessons.length} этап{mod.lessons.length === 1 ? '' : 'ов'}
                    </span>
                    {isEditable && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={e => { e.stopPropagation(); moveModuleUp(modIdx); }}
                          disabled={modIdx === 0}
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          aria-label="Вверх"
                        >
                          &uarr;
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={e => { e.stopPropagation(); moveModuleDown(modIdx); }}
                          disabled={modIdx === modules.length - 1}
                          style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                          aria-label="Вниз"
                        >
                          &darr;
                        </Button>
                        <button
                          className={s.deleteBtn}
                          onClick={e => { e.stopPropagation(); removeModule(mod.id); }}
                          title="Удалить модуль"
                        >
                          &times;
                        </button>
                      </>
                    )}
                    <span className={`${s.expandIcon} ${isOpen ? s.expandIconOpen : ''}`}>
                      &#9654;
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div className={s.lessonList}>
                    {mod.lessons.map((lesson, lessonIdx) => (
                      <div key={lesson.id} className={s.lessonCard}>
                        <span
                          className={s.lessonTitle}
                          onClick={() => { void handleEditLesson(lesson.id); }}
                        >
                          {lessonIdx + 1}. {lesson.title}
                        </span>
                        <div className={s.lessonActions}>
                          {isEditable && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => moveLessonUp(mod.id, lessonIdx)}
                                disabled={lessonIdx === 0}
                                style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                              >
                                &uarr;
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => moveLessonDown(mod.id, lessonIdx)}
                                disabled={lessonIdx === mod.lessons.length - 1}
                                style={{ padding: '2px 6px', fontSize: '0.75rem' }}
                              >
                                &darr;
                              </Button>
                              <button
                                className={s.deleteBtn}
                                onClick={() => removeLesson(mod.id, lesson.id)}
                                title="Удалить этап"
                              >
                                &times;
                              </button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { void handleEditLesson(lesson.id); }}
                          >
                            Редактировать
                          </Button>
                        </div>
                      </div>
                    ))}
                    {isEditable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={s.addLessonBtn}
                        onClick={() => addLesson(mod.id)}
                      >
                        + Добавить этап
                      </Button>
                    )}
                  </div>
                )}
              </ComicPanel>
            );
          })
        )}
      </div>

      {/* Student link / progress */}
      <div style={{ marginTop: 16 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/teacher/courses/${courseId}/students`)}
        >
          Прогресс учеников &rarr;
        </Button>
      </div>

      {/* Bottom actions */}
      <div className={s.bottomActions}>
        <Button variant="danger" onClick={handleArchive} disabled={archiving} size="sm">
          {archiving ? 'Архивация...' : 'Архивировать курс'}
        </Button>
      </div>

      {/* Confirm Action Modal */}
      <Modal
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title="Подтверждение"
      >
        <div className={s.modalContent}>
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

      {/* Share Modal */}
      <Modal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        title="Поделиться курсом"
      >
        <div className={s.modalContent}>
          <p>Создайте ссылку для приглашения учеников в курс.</p>

          <Button onClick={handleCreateLink} disabled={creatingLink} size="sm">
            {creatingLink ? 'Создание...' : '+ Создать ссылку'}
          </Button>

          {activeLinks.length > 0 && (
            <div className={s.linkList}>
              {activeLinks.map(link => (
                <div key={link.link_id} className={s.linkRow}>
                  <span className={s.linkUrl}>{link.invite_url ?? 'Ссылка недоступна для старого приглашения'}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {link.invite_url ? (
                      <Button size="sm" variant="ghost" onClick={() => handleCopy(link.invite_url!)}>
                        Копировать
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" onClick={() => handleRevokeLink(link.link_id)}>
                      Отозвать
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {copied && <span className={s.copied}>Скопировано!</span>}
        </div>
      </Modal>
    </div>
  );
}
