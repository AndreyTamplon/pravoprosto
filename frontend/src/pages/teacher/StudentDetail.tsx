import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getTeacherStudentDetail } from '../../api/client';
import type { TeacherStudentDetail as StudentDetailType } from '../../api/types';
import { Button, ComicPanel, Badge, Spinner } from '../../components/ui';
import { timeAgo } from '../../utils/format';
import s from './StudentDetail.module.css';

const verdictBadge: Record<string, { label: string; color: 'lime' | 'orange' | 'red' | 'gray' }> = {
  correct: { label: 'Верно', color: 'lime' },
  partial: { label: 'Частично', color: 'orange' },
  incorrect: { label: 'Неверно', color: 'red' },
};

const statusLabels: Record<string, string> = {
  not_started: 'Не начат',
  in_progress: 'В процессе',
  completed: 'Завершён',
};

export default function StudentDetail() {
  const { courseId, studentId } = useParams<{ courseId: string; studentId: string }>();
  const navigate = useNavigate();

  const { data, loading, error } = useApi<StudentDetailType>(
    () => getTeacherStudentDetail(courseId!, studentId!),
    [courseId, studentId],
  );

  if (loading) return <Spinner text="Загрузка..." />;
  if (error) return <div className={s.error}>{error}</div>;
  if (!data) return null;

  const initial = data.student.display_name.charAt(0).toUpperCase();

  return (
    <div className={s.page}>
      <Button
        variant="ghost"
        className={s.backBtn}
        onClick={() => navigate(`/teacher/courses/${courseId}/students`)}
      >
        &larr; Назад к списку
      </Button>

      <div className={s.studentHeader}>
        <div className={s.avatar}>{initial}</div>
        <div>
          <h1 className={s.studentName}>{data.student.display_name}</h1>
          <div style={{ color: 'var(--dark-light)', marginTop: 4 }}>
            Прогресс: {data.summary.progress_percent}% · XP: {data.summary.xp_total} · Точность: {data.summary.correctness_percent}%
          </div>
        </div>
      </div>

      <h2 className={s.sectionTitle}>Этапы</h2>

      <ComicPanel>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Этап</th>
                <th>Статус</th>
                <th>Лучший результат</th>
                <th>Попыток</th>
                <th>Последняя активность</th>
              </tr>
            </thead>
            <tbody>
              {data.lessons.map(lesson => {
                const vb = lesson.best_verdict ? verdictBadge[lesson.best_verdict] : null;
                return (
                  <tr key={lesson.lesson_id}>
                    <td style={{ fontWeight: 600 }}>{lesson.title}</td>
                    <td>{statusLabels[lesson.status] ?? lesson.status}</td>
                    <td>
                      {vb ? (
                        <Badge color={vb.color}>{vb.label}</Badge>
                      ) : (
                        <span style={{ color: 'var(--gray-400)' }}>&mdash;</span>
                      )}
                    </td>
                    <td>{lesson.attempts_count}</td>
                    <td>{lesson.last_activity_at ? timeAgo(lesson.last_activity_at) : <span style={{ color: 'var(--gray-400)' }}>&mdash;</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ComicPanel>
    </div>
  );
}
