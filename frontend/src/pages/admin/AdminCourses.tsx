import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getAdminCourses, createAdminCourse } from '../../api/client';
import { Button, Badge, Spinner, Modal, Input, Textarea, EmptyState } from '../../components/ui';
import { formatDate } from '../../utils/format';
import type { AdminCourse } from '../../api/types';
import styles from './AdminCourses.module.css';

type Filter = 'all' | 'platform' | 'teacher';

export default function AdminCourses() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, loading, error, reload } = useApi<AdminCourse[]>(() => getAdminCourses(), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    if (searchParams.get('create') === '1') setShowCreate(true);
  }, [searchParams]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data;
    return data.filter(c => c.owner_kind === filter);
  }, [data, filter]);

  async function handleCreate() {
    if (!createTitle.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await createAdminCourse({ title: createTitle.trim(), description: createDesc.trim() });
      setShowCreate(false);
      setCreateTitle('');
      setCreateDesc('');
      navigate(`/admin/courses/${res.course_id}/edit`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Ошибка создания');
    } finally {
      setCreating(false);
    }
  }

  function ownerBadge(kind: string) {
    return kind === 'platform'
      ? <Badge color="teal">Платформа</Badge>
      : <Badge color="orange">Учитель</Badge>;
  }

  function statusBadge(course: AdminCourse) {
    if (course.has_published_revision) return <Badge color="lime">Опубликован</Badge>;
    if (course.status === 'archived') return <Badge color="gray">Архив</Badge>;
    return <Badge color="yellow">Черновик</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Курсы</h1>
        <Button onClick={() => setShowCreate(true)}>Создать курс</Button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.toolbar}>
        {(['all', 'platform', 'teacher'] as Filter[]).map(f => (
          <button
            key={f}
            className={`${styles.filterBtn} ${filter === f ? styles.filterActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Все' : f === 'platform' ? 'Платформа' : 'Учителя'}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="📚" title="Нет курсов" description="Создайте первый курс" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Статус</th>
              <th>Уроков</th>
              <th>Учеников</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.course_id} onClick={() => navigate(`/admin/courses/${c.course_id}/edit`)}>
                <td className={styles.courseTitle}>{c.title}</td>
                <td>{ownerBadge(c.owner_kind)}</td>
                <td>{statusBadge(c)}</td>
                <td>{c.lesson_count}</td>
                <td>{c.student_count}</td>
                <td>{formatDate(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Создать курс">
        <div className={styles.modalForm}>
          <Input
            label="Название"
            value={createTitle}
            onChange={e => setCreateTitle(e.target.value)}
            placeholder="Введите название курса"
            autoFocus
          />
          <Textarea
            label="Описание"
            value={createDesc}
            onChange={e => setCreateDesc(e.target.value)}
            placeholder="Краткое описание курса"
            rows={3}
          />
          {createError && <div className={styles.error}>{createError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Отмена</Button>
            <Button onClick={handleCreate} loading={creating} disabled={!createTitle.trim()}>
              Создать
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
