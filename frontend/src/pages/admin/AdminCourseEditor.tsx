import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getAdminDraft, updateAdminDraft, publishAdminCourse, createAdminPreview,
  deleteAdminCourse,
} from '../../api/client';
import { Button, Badge, Spinner, Modal, Input, EmptyState } from '../../components/ui';
import { graphToBackendFormat, isBackendLessonGraph } from '../../api/types';
import type { CourseDraft, ContentModule, ContentLesson, LessonGraph } from '../../api/types';
import {
  getDraftValidationErrors,
  parseOptionalInteger,
  validateAgeRange,
} from '../../utils/editorErrors';
import styles from './AdminCourseEditor.module.css';

function emptyGraph(): LessonGraph {
  return { startNodeId: 'start', nodes: [{ id: 'start', type: 'story', data: { text: '' } }, { id: 'end', type: 'terminal', data: {} }], edges: [{ from: 'start', to: 'end' }] };
}

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

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

export default function AdminCourseEditor() {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: draft, loading, error, reload } = useApi<CourseDraft>(
    () => getAdminDraft(courseId!), [courseId],
  );

  const [localTitle, setLocalTitle] = useState('');
  const [localDesc, setLocalDesc] = useState('');
  const [localAgeMin, setLocalAgeMin] = useState('');
  const [localAgeMax, setLocalAgeMax] = useState('');
  const [localModules, setLocalModules] = useState<ContentModule[]>([]);
  const [draftVersion, setDraftVersion] = useState<number>(0);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Module/Lesson modals
  const [showAddModule, setShowAddModule] = useState(false);
  const [newModuleTitle, setNewModuleTitle] = useState('');
  const [showAddLesson, setShowAddLesson] = useState<string | null>(null);
  const [newLessonTitle, setNewLessonTitle] = useState('');
  const [showRenameModule, setShowRenameModule] = useState<string | null>(null);
  const [renameModuleTitle, setRenameModuleTitle] = useState('');

  // Preview
  const [previewing, setPreviewing] = useState(false);
  const previewingRef = useRef(false);

  // Delete
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Initialize local state from draft
  useEffect(() => {
    if (draft && !initialized) {
      setLocalTitle(draft.title);
      setLocalDesc(draft.description);
      setLocalAgeMin(draft.age_min?.toString() ?? '');
      setLocalAgeMax(draft.age_max?.toString() ?? '');
      setLocalModules(draft.content_json?.modules ?? []);
      setDraftVersion(draft.draft_version);
      setInitialized(true);
    }
  }, [draft, initialized]);

  const saveCurrentDraft = useCallback(async (showSavedState = false): Promise<number> => {
    if (!courseId) {
      throw new Error('Курс не найден');
    }

    const ageMin = parseOptionalInteger('Возраст от', localAgeMin);
    const ageMax = parseOptionalInteger('Возраст до', localAgeMax);
    validateAgeRange(ageMin, ageMax);

    const res = await updateAdminDraft(courseId, {
      draft_version: draftVersion,
      title: localTitle,
      description: localDesc,
      age_min: ageMin,
      age_max: ageMax,
      cover_asset_id: draft?.cover_asset_id,
      content_json: { modules: serializeModules(localModules) },
    });

    setDraftVersion(res.draft_version);
    if (showSavedState) {
      setSaveMsg('Сохранено!');
      setTimeout(() => setSaveMsg(''), 2000);
    }
    return res.draft_version;
  }, [courseId, draft?.cover_asset_id, draftVersion, localAgeMax, localAgeMin, localDesc, localModules, localTitle]);

  const handleSave = useCallback(async (): Promise<number> => {
    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    setValidationErrors([]);
    try {
      return await saveCurrentDraft(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setSaving(false);
    }
  }, [saveCurrentDraft]);

  const handlePublish = useCallback(async () => {
    if (!courseId) return;
    setPublishing(true);
    setSaveError('');
    setValidationErrors([]);
    try {
      await handleSave();
      await publishAdminCourse(courseId);
      reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка публикации';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
    } finally {
      setPublishing(false);
    }
  }, [courseId, handleSave, reload]);

  const handlePreview = useCallback(async (lessonId: string) => {
    if (!courseId || previewingRef.current) return;
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
  }, [courseId, handleSave, location.pathname]);

  const handleDelete = useCallback(async () => {
    if (!courseId) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteAdminCourse(courseId);
      navigate('/admin/courses');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Ошибка удаления');
    } finally {
      setDeleting(false);
    }
  }, [courseId, navigate]);

  async function handleEditLesson(lessonId: string) {
    if (!courseId) return;

    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    setValidationErrors([]);
    try {
      await saveCurrentDraft();
      navigate(`/admin/courses/${courseId}/lessons/${lessonId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      const details = getDraftValidationErrors(err).map(item => item.message);
      setValidationErrors(details);
      setSaveError(details.length > 0 ? '' : message);
    } finally {
      setSaving(false);
    }
  }

  function addModule() {
    if (!newModuleTitle.trim()) return;
    setLocalModules(prev => [...prev, { id: generateId(), title: newModuleTitle.trim(), lessons: [] }]);
    setNewModuleTitle('');
    setShowAddModule(false);
  }

  function deleteModule(moduleId: string) {
    setLocalModules(prev => prev.filter(m => m.id !== moduleId));
  }

  function renameModule() {
    if (!showRenameModule || !renameModuleTitle.trim()) return;
    setLocalModules(prev => prev.map(m =>
      m.id === showRenameModule ? { ...m, title: renameModuleTitle.trim() } : m
    ));
    setShowRenameModule(null);
    setRenameModuleTitle('');
  }

  function addLesson(moduleId: string) {
    if (!newLessonTitle.trim()) return;
    setLocalModules(prev => prev.map(m =>
      m.id === moduleId
        ? { ...m, lessons: [...m.lessons, { id: generateId(), title: newLessonTitle.trim(), graph: emptyGraph() }] }
        : m
    ));
    setNewLessonTitle('');
    setShowAddLesson(null);
  }

  function deleteLesson(moduleId: string, lessonId: string) {
    setLocalModules(prev => prev.map(m =>
      m.id === moduleId
        ? { ...m, lessons: m.lessons.filter(l => l.id !== lessonId) }
        : m
    ));
  }

  function moveModule(moduleId: string, delta: -1 | 1) {
    setLocalModules(prev => {
      const idx = prev.findIndex(m => m.id === moduleId);
      if (idx < 0) return prev;
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function moveLesson(moduleId: string, lessonId: string, delta: -1 | 1) {
    setLocalModules(prev => prev.map(m => {
      if (m.id !== moduleId) return m;
      const idx = m.lessons.findIndex(l => l.id === lessonId);
      if (idx < 0) return m;
      const target = idx + delta;
      if (target < 0 || target >= m.lessons.length) return m;
      const lessons = [...m.lessons];
      [lessons[idx], lessons[target]] = [lessons[target], lessons[idx]];
      return { ...m, lessons };
    }));
  }

  if (loading) return <Spinner />;
  if (error) return <div className={styles.page}><div className={styles.error}>{error}</div></div>;
  if (!draft) return <div className={styles.page}><EmptyState icon="📄" title="Черновик не найден" /></div>;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/admin/courses')}>&#8592;</button>
          <h1 className={styles.title}>{localTitle || 'Новый курс'}</h1>
          <span className={styles.statusBadge}>
            {draft.workflow_status === 'archived' ? (
              <Badge color="gray">Архив</Badge>
            ) : draft.workflow_status === 'in_review' ? (
              <Badge color="orange">На модерации</Badge>
            ) : draft.has_published_revision ? (
              <Badge color="lime">Опубликован</Badge>
            ) : (
              <Badge color="yellow">Черновик</Badge>
            )}
          </span>
        </div>
        <div className={styles.headerActions}>
          {draft.workflow_status !== 'archived' && (
            <Button variant="danger" onClick={() => setShowDeleteConfirm(true)}>Удалить</Button>
          )}
          <Button variant="secondary" onClick={() => { void handleSave().catch(() => undefined); }} loading={saving}>Сохранить</Button>
          <Button variant="success" onClick={handlePublish} loading={publishing}>Опубликовать</Button>
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
      {draft.last_review_comment && (
        <div className={styles.error}>Комментарий модератора: {draft.last_review_comment}</div>
      )}

      <div className={styles.meta}>
        <div className={styles.metaFull}>
          <Input label="Название курса" value={localTitle} onChange={e => setLocalTitle(e.target.value)} />
        </div>
        <div className={styles.metaFull}>
          <Input label="Описание" value={localDesc} onChange={e => setLocalDesc(e.target.value)} />
        </div>
        <div className={styles.ageRow}>
          <Input label="Возраст от" type="number" value={localAgeMin} onChange={e => setLocalAgeMin(e.target.value)} min={0} step={1} inputMode="numeric" />
          <Input label="Возраст до" type="number" value={localAgeMax} onChange={e => setLocalAgeMax(e.target.value)} min={0} step={1} inputMode="numeric" />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Модули и уроки</h2>
          <Button size="sm" onClick={() => setShowAddModule(true)}>+ Модуль</Button>
        </div>

        {localModules.length === 0 && (
          <EmptyState icon="📦" title="Нет модулей" description="Добавьте первый модуль для курса" />
        )}

        {localModules.map((mod, mIdx) => (
          <div key={mod.id} className={styles.moduleCard}>
            <div className={styles.moduleHeader}>
              <span className={styles.moduleTitle}>{mod.title}</span>
              <div className={styles.moduleActions}>
                <Button size="sm" variant="ghost" onClick={() => moveModule(mod.id, -1)} disabled={mIdx === 0} aria-label="Вверх">↑</Button>
                <Button size="sm" variant="ghost" onClick={() => moveModule(mod.id, 1)} disabled={mIdx === localModules.length - 1} aria-label="Вниз">↓</Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowRenameModule(mod.id); setRenameModuleTitle(mod.title); }}>
                  Переименовать
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddLesson(mod.id)}>
                  + Урок
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteModule(mod.id)}>
                  Удалить
                </Button>
              </div>
            </div>
            <div className={styles.lessonList}>
              {mod.lessons.length === 0 ? (
                <div className={styles.noLessons}>Нет уроков</div>
              ) : (
                mod.lessons.map((lesson, idx) => (
                  <div key={lesson.id} className={styles.lessonItem}>
                    <div>
                      <div className={styles.lessonName}>{idx + 1}. {lesson.title}</div>
                      <div className={styles.lessonMeta}>{lesson.graph.nodes.length} нод</div>
                    </div>
                    <div className={styles.moduleActions}>
                      <Button size="sm" variant="ghost" onClick={() => moveLesson(mod.id, lesson.id, -1)} disabled={idx === 0} aria-label="Вверх">↑</Button>
                      <Button size="sm" variant="ghost" onClick={() => moveLesson(mod.id, lesson.id, 1)} disabled={idx === mod.lessons.length - 1} aria-label="Вниз">↓</Button>
                      <Button size="sm" variant="ghost" onClick={() => { void handleEditLesson(lesson.id); }}>
                        Редактировать
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handlePreview(lesson.id)} disabled={previewing}>
                        Превью
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deleteLesson(mod.id, lesson.id)}>
                        Удалить
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add module modal */}
      <Modal open={showAddModule} onClose={() => setShowAddModule(false)} title="Новый модуль">
        <div className={styles.modalForm}>
          <Input label="Название модуля" value={newModuleTitle} onChange={e => setNewModuleTitle(e.target.value)} autoFocus />
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowAddModule(false)}>Отмена</Button>
            <Button onClick={addModule} disabled={!newModuleTitle.trim()}>Добавить</Button>
          </div>
        </div>
      </Modal>

      {/* Add lesson modal */}
      <Modal open={showAddLesson !== null} onClose={() => setShowAddLesson(null)} title="Новый урок">
        <div className={styles.modalForm}>
          <Input label="Название урока" value={newLessonTitle} onChange={e => setNewLessonTitle(e.target.value)} autoFocus />
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowAddLesson(null)}>Отмена</Button>
            <Button onClick={() => showAddLesson && addLesson(showAddLesson)} disabled={!newLessonTitle.trim()}>Добавить</Button>
          </div>
        </div>
      </Modal>

      {/* Rename module modal */}
      <Modal open={showRenameModule !== null} onClose={() => setShowRenameModule(null)} title="Переименовать модуль">
        <div className={styles.modalForm}>
          <Input label="Новое название" value={renameModuleTitle} onChange={e => setRenameModuleTitle(e.target.value)} autoFocus />
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowRenameModule(null)}>Отмена</Button>
            <Button onClick={renameModule} disabled={!renameModuleTitle.trim()}>Сохранить</Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} title="Удалить курс">
        <div className={styles.modalForm}>
          <p>Вы уверены, что хотите удалить курс <strong>{localTitle}</strong>? Курс будет архивирован и станет недоступен для учеников.</p>
          {deleteError && <div className={styles.error}>{deleteError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>Отмена</Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting}>Удалить</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
