import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getAdminDraft, updateAdminDraft, publishAdminCourse, createAdminPreview,
} from '../../api/client';
import { Button, Badge, Spinner, Modal, Input, EmptyState } from '../../components/ui';
import { graphToBackendFormat, isBackendLessonGraph } from '../../api/types';
import type { CourseDraft, ContentModule, ContentLesson, LessonGraph } from '../../api/types';
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

  // Module/Lesson modals
  const [showAddModule, setShowAddModule] = useState(false);
  const [newModuleTitle, setNewModuleTitle] = useState('');
  const [showAddLesson, setShowAddLesson] = useState<string | null>(null);
  const [newLessonTitle, setNewLessonTitle] = useState('');
  const [showRenameModule, setShowRenameModule] = useState<string | null>(null);
  const [renameModuleTitle, setRenameModuleTitle] = useState('');

  // Preview
  const [previewing, setPreviewing] = useState(false);

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

    const res = await updateAdminDraft(courseId, {
      draft_version: draftVersion,
      title: localTitle,
      description: localDesc,
      age_min: localAgeMin ? Number(localAgeMin) : undefined,
      age_max: localAgeMax ? Number(localAgeMax) : undefined,
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
    try {
      return await saveCurrentDraft(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка сохранения';
      setSaveError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setSaving(false);
    }
  }, [saveCurrentDraft]);

  const handlePublish = useCallback(async () => {
    if (!courseId) return;
    setPublishing(true);
    setSaveError('');
    try {
      await handleSave();
      await publishAdminCourse(courseId);
      reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Ошибка публикации');
    } finally {
      setPublishing(false);
    }
  }, [courseId, handleSave, reload]);

  const handlePreview = useCallback(async (lessonId: string) => {
    if (!courseId) return;
    setPreviewing(true);
    try {
      await handleSave();
      const session = await createAdminPreview(courseId, lessonId);
      window.open(`/admin/preview/${session.preview_session_id}`, '_blank');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Ошибка предпросмотра');
    } finally {
      setPreviewing(false);
    }
  }, [courseId, handleSave]);

  async function handleEditLesson(lessonId: string) {
    if (!courseId) return;

    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    try {
      await saveCurrentDraft();
      navigate(`/admin/courses/${courseId}/lessons/${lessonId}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Ошибка сохранения');
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
            {draft.workflow_status === 'editing' && <Badge color="yellow">Черновик</Badge>}
            {draft.workflow_status === 'in_review' && <Badge color="orange">На модерации</Badge>}
            {draft.workflow_status === 'archived' && <Badge color="gray">Архив</Badge>}
          </span>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => { void handleSave().catch(() => undefined); }} loading={saving}>Сохранить</Button>
          <Button variant="success" onClick={handlePublish} loading={publishing}>Опубликовать</Button>
        </div>
      </div>

      {saveMsg && <div className={styles.saveNotice}>{saveMsg}</div>}
      {saveError && <div className={styles.error}>{saveError}</div>}
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
          <Input label="Возраст от" type="number" value={localAgeMin} onChange={e => setLocalAgeMin(e.target.value)} min={0} />
          <Input label="Возраст до" type="number" value={localAgeMax} onChange={e => setLocalAgeMax(e.target.value)} min={0} />
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

        {localModules.map(mod => (
          <div key={mod.id} className={styles.moduleCard}>
            <div className={styles.moduleHeader}>
              <span className={styles.moduleTitle}>{mod.title}</span>
              <div className={styles.moduleActions}>
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
                      <Button size="sm" variant="ghost" onClick={() => { void handleEditLesson(lesson.id); }}>
                        Редактировать
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handlePreview(lesson.id)} loading={previewing}>
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
    </div>
  );
}
