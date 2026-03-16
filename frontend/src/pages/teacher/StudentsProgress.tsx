import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getTeacherStudents } from '../../api/client';
import type { TeacherStudent } from '../../api/types';
import { Button, ComicPanel, ProgressBar, Spinner, EmptyState } from '../../components/ui';
import { timeAgo } from '../../utils/format';
import s from './StudentsProgress.module.css';

export default function StudentsProgress() {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();

  const { data: students, loading, error } = useApi<TeacherStudent[]>(
    () => getTeacherStudents(courseId!),
    [courseId],
  );

  if (loading) return <Spinner text="Загрузка учеников..." />;
  if (error) return <div className={s.error}>{error}</div>;

  const initial = (name: string) => name.charAt(0).toUpperCase();

  return (
    <div className={s.page}>
      <Button
        variant="ghost"
        className={s.backBtn}
        onClick={() => navigate(`/teacher/courses/${courseId}`)}
      >
        &larr; К курсу
      </Button>

      <div className={s.header}>
        <h1 className={s.title}>Прогресс учеников</h1>
      </div>

      {!students || students.length === 0 ? (
        <ComicPanel>
          <EmptyState
            icon="👩‍🎓"
            title="Пока нет учеников"
            description="Поделитесь ссылкой на курс, чтобы привлечь учеников"
          >
            <Button
              style={{ marginTop: 8 }}
              onClick={() => navigate(`/teacher/courses/${courseId}`)}
            >
              К настройкам курса
            </Button>
          </EmptyState>
        </ComicPanel>
      ) : (
        <ComicPanel>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Ученик</th>
                  <th>Прогресс</th>
                  <th>XP</th>
                  <th>Точность</th>
                  <th>Последняя активность</th>
                </tr>
              </thead>
              <tbody>
                {students.map(st => (
                  <tr
                    key={st.student_id}
                    onClick={() => navigate(`/teacher/courses/${courseId}/students/${st.student_id}`)}
                  >
                    <td>
                      <div className={s.studentName}>
                        <div className={s.avatar}>
                          {st.avatar_url ? (
                            <img
                              src={st.avatar_url}
                              alt=""
                              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                            />
                          ) : (
                            initial(st.display_name)
                          )}
                        </div>
                        {st.display_name}
                      </div>
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar value={st.progress_pct} color="teal" size="sm" />
                    </td>
                    <td>{st.xp_earned}</td>
                    <td>{st.accuracy_pct}%</td>
                    <td>{timeAgo(st.last_activity_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ComicPanel>
      )}
    </div>
  );
}
