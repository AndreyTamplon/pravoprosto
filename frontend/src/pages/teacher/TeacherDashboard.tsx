import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getTeacherCourses, createTeacherCourse } from '../../api/client';
import type { TeacherCourse } from '../../api/types';
import { Button, ComicPanel, Badge, Spinner, Modal, EmptyState, Input, Textarea } from '../../components/ui';
import { timeAgo } from '../../utils/format';
import s from './TeacherDashboard.module.css';

const workflowBadge: Record<string, { label: string; color: 'yellow' | 'blue' | 'red' | 'lime' | 'gray' }> = {
  editing: { label: 'Редактирование', color: 'yellow' },
  in_review: { label: 'На проверке', color: 'blue' },
  changes_requested: { label: 'Нужны правки', color: 'red' },
  published: { label: 'Опубликован', color: 'lime' },
  archived: { label: 'В архиве', color: 'gray' },
};

export default function TeacherDashboard() {
  const navigate = useNavigate();
  const { data: courses, loading, error: loadError, reload } = useApi<TeacherCourse[]>(getTeacherCourses);

  const [modalOpen, setModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { course_id } = await createTeacherCourse({
        title: newTitle.trim(),
        description: newDesc.trim(),
      });
      setModalOpen(false);
      setNewTitle('');
      setNewDesc('');
      reload();
      navigate(`/teacher/courses/${course_id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка создания курса');
    } finally {
      setCreating(false);
    }
  }, [newTitle, newDesc, reload, navigate]);

  if (loading) return <Spinner text="Загрузка курсов..." />;
  if (loadError) return <div className={s.error}>{loadError}</div>;

  const activeCourses = courses?.filter(c => c.status !== 'archived') ?? [];
  const archivedCourses = courses?.filter(c => c.status === 'archived') ?? [];

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Мои курсы</h1>
        <Button onClick={() => setModalOpen(true)}>+ Создать курс</Button>
      </div>

      {activeCourses.length > 0 ? (
        <div className={s.grid}>
          {activeCourses.map(course => {
            const ws = workflowBadge[course.workflow_status] ?? workflowBadge.editing;
            return (
              <ComicPanel
                key={course.course_id}
                clickable
                onClick={() => navigate(`/teacher/courses/${course.course_id}`)}
              >
                <div className={s.courseCard}>
                  <div className={s.courseMeta}>
                    <Badge color={ws.color}>{ws.label}</Badge>
                    {course.has_published_revision && (
                      <Badge color="lime">Опубликован</Badge>
                    )}
                  </div>
                  <span className={s.courseTitle}>{course.title}</span>
                  <div className={s.courseFooter}>
                    <span className={s.courseInfo}>
                      {course.student_count} учеников
                    </span>
                    <span className={s.courseInfo}>
                      {timeAgo(course.updated_at)}
                    </span>
                  </div>
                </div>
              </ComicPanel>
            );
          })}
        </div>
      ) : (
        <ComicPanel>
          <EmptyState
            icon="📚"
            title="Пока нет курсов"
            description="Создайте свою первую миссию для учеников"
          >
            <Button onClick={() => setModalOpen(true)} style={{ marginTop: 8 }}>+ Создать курс</Button>
          </EmptyState>
        </ComicPanel>
      )}

      {archivedCourses.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: 16 }}>Архив</h2>
          <div className={s.grid}>
            {archivedCourses.map(course => (
              <ComicPanel
                key={course.course_id}
                clickable
                onClick={() => navigate(`/teacher/courses/${course.course_id}`)}
              >
                <div className={s.courseCard}>
                  <Badge color="gray">В архиве</Badge>
                  <span className={s.courseTitle}>{course.title}</span>
                  <span className={s.courseInfo}>{course.student_count} учеников</span>
                </div>
              </ComicPanel>
            ))}
          </div>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Создать курс">
        <div className={s.modalForm}>
          <Input
            label="Название миссии"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="Например: Основы права"
          />
          <Textarea
            label="Описание"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="Кратко опишите курс..."
            rows={3}
          />
          {error && <div className={s.error}>{error}</div>}
          <Button onClick={handleCreate} disabled={creating || !newTitle.trim()} full>
            {creating ? 'Создание...' : 'Создать'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
