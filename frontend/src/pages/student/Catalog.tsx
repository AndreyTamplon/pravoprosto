import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getStudentCatalog } from '../../api/client';
import { ComicPanel, Badge, ProgressBar, Spinner, EmptyState } from '../../components/ui';
import type { CatalogCourse, CatalogSection } from '../../api/types';
import styles from './Catalog.module.css';

function CourseCard({ course, onClick }: { course: CatalogCourse; onClick: () => void }) {
  const pct = Math.round(course.progress_percent);

  return (
    <ComicPanel hoverable className={styles.card} onClick={onClick}>
      <div className={styles.cardTop}>
        <h3 className={styles.cardTitle}>{course.title}</h3>
        {course.is_new && <Badge variant="orange">Новая!</Badge>}
        {pct >= 100 && <Badge variant="lime">Миссия выполнена</Badge>}
      </div>
      <p className={styles.cardDesc}>{course.description}</p>
      {pct > 0 && pct < 100 && (
        <div className={styles.cardProgress}>
          <ProgressBar value={pct} height={12} showLabel />
        </div>
      )}
      <div className={styles.cardMeta}>
        {course.badges.map((b) => (
          <Badge key={b} variant="teal">{b}</Badge>
        ))}
      </div>
    </ComicPanel>
  );
}

const SECTION_ICONS: Record<string, string> = {
  platform_catalog: '🎯',
  teacher_access: '📎',
};

export default function Catalog() {
  const navigate = useNavigate();
  const { data, loading, error } = useApi(getStudentCatalog);

  if (loading) return <Spinner />;
  if (error) return <EmptyState icon="⚠️" title="Ошибка загрузки" description={error} />;

  const sections: CatalogSection[] = data?.sections ?? [];
  const hasItems = sections.some((s) => s.items.length > 0);

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Штаб героя</h1>
      <p className={styles.pageSub}>Выбери миссию и отправляйся в путь</p>

      {sections.map((sec) =>
        sec.items.length > 0 ? (
          <div key={sec.section} className={styles.section}>
            <h2 className={styles.sectionTitle}>
              <span className={styles.sectionIcon}>{SECTION_ICONS[sec.section] ?? '📚'}</span>
              {sec.title}
            </h2>
            <div className={styles.grid}>
              {sec.items.map((c) => (
                <CourseCard
                  key={c.course_id}
                  course={c}
                  onClick={() => navigate(`/student/courses/${c.course_id}`)}
                />
              ))}
            </div>
          </div>
        ) : null,
      )}

      {!hasItems && (
        <EmptyState
          icon="📭"
          title="Пока нет миссий"
          description="Миссии скоро появятся. Загляни позже!"
        />
      )}
    </div>
  );
}
