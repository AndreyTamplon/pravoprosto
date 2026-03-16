import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getAdminUsers, getAdminCourses, getModerationQueue } from '../../api/client';
import { Button, Spinner } from '../../components/ui';
import { timeAgo } from '../../utils/format';
import type { AdminUser, AdminCourse, PendingReview } from '../../api/types';
import styles from './AdminDashboard.module.css';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const users = useApi<AdminUser[]>(() => getAdminUsers(), []);
  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);
  const queue = useApi<PendingReview[]>(() => getModerationQueue(), []);

  const stats = useMemo(() => {
    const u = users.data ?? [];
    const c = courses.data ?? [];
    const q = queue.data ?? [];
    return {
      totalUsers: u.length,
      totalCourses: c.length,
      activeStudents: u.filter(x => x.role === 'student' && x.status === 'active').length,
      pendingReviews: q.length,
    };
  }, [users.data, courses.data, queue.data]);

  const recentActivity = useMemo(() => {
    const items: { text: string; time: string; color: string }[] = [];

    for (const u of (users.data ?? []).slice(0, 3)) {
      items.push({
        text: `${u.display_name} (${u.role}) -- зарегистрирован`,
        time: u.created_at,
        color: 'dotTeal',
      });
    }
    for (const r of (queue.data ?? []).slice(0, 3)) {
      items.push({
        text: `"${r.course_title}" -- на модерации от ${r.teacher_name}`,
        time: r.submitted_at,
        color: 'dotOrange',
      });
    }
    for (const c of (courses.data ?? []).slice(0, 3)) {
      items.push({
        text: `Курс "${c.title}" -- ${c.has_published_revision ? 'опубликован' : 'черновик'}`,
        time: c.created_at,
        color: 'dotBlue',
      });
    }

    items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
    return items.slice(0, 8);
  }, [users.data, courses.data, queue.data]);

  const loading = users.loading || courses.loading || queue.loading;
  const error = users.error || courses.error || queue.error;

  if (loading) return <Spinner />;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Панель управления</h1>
        <div className={styles.actions}>
          <Button onClick={() => navigate('/admin/courses?create=1')}>Создать курс</Button>
          <Button variant="secondary" onClick={() => navigate('/admin/moderation')}>
            Модерация
            {stats.pendingReviews > 0 && ` (${stats.pendingReviews})`}
          </Button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>👥</div>
          <div className={styles.statInfo}>
            <div className={styles.statValue}>{stats.totalUsers}</div>
            <div className={styles.statLabel}>Пользователей</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📚</div>
          <div className={styles.statInfo}>
            <div className={styles.statValue}>{stats.totalCourses}</div>
            <div className={styles.statLabel}>Курсов</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>🎓</div>
          <div className={styles.statInfo}>
            <div className={styles.statValue}>{stats.activeStudents}</div>
            <div className={styles.statLabel}>Активных учеников</div>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📋</div>
          <div className={styles.statInfo}>
            <div className={styles.statValue}>{stats.pendingReviews}</div>
            <div className={styles.statLabel}>На модерации</div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Последняя активность</h2>
        <div className={styles.activityList}>
          {recentActivity.length === 0 && (
            <div className={styles.activityItem}>Нет недавней активности</div>
          )}
          {recentActivity.map((item, i) => (
            <div className={styles.activityItem} key={i}>
              <span className={`${styles.activityDot} ${styles[item.color]}`} />
              <span>{item.text}</span>
              <span className={styles.activityTime}>{timeAgo(item.time)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
