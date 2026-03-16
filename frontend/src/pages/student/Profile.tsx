import { useState } from 'react';
import { useApi } from '../../hooks/useApi';
import {
  getStudentProfile,
  getGameState,
  updateStudentProfile,
  getStudentCatalog,
} from '../../api/client';
import {
  Button,
  ComicPanel,
  ProgressBar,
  Spinner,
  EmptyState,
} from '../../components/ui';
import styles from './Profile.module.css';

const BADGE_ICONS: Record<string, string> = {
  first_lesson: '🌟',
  streak_7: '🔥',
  streak_30: '💎',
  perfect_lesson: '💯',
  explorer: '🗺️',
  default: '🏅',
};

export default function Profile() {
  const { data: profile, loading: loadingProfile, reload: reloadProfile } = useApi(getStudentProfile);
  const { data: game, loading: loadingGame } = useApi(getGameState);
  const { data: catalog } = useApi(getStudentCatalog);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (loadingProfile || loadingGame) return <Spinner />;
  if (!profile) return <EmptyState icon="⚠️" title="Не удалось загрузить профиль" />;

  const startEdit = () => {
    setEditName(profile.display_name);
    setEditing(true);
  };

  const saveName = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateStudentProfile({ display_name: editName.trim() });
      setEditing(false);
      reloadProfile();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Ошибка сохранения имени');
    } finally {
      setSaving(false);
    }
  };

  // Courses with progress
  const allCourses = (catalog?.sections ?? []).flatMap((s) => s.items);
  const startedCourses = allCourses.filter((c) => c.progress_percent > 0);

  // Count started courses as a simple metric
  const lessonsCompleted = startedCourses.length;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.avatar}>
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt="Аватар пользователя"
              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : (
            '👤'
          )}
        </div>
        <div className={styles.nameWrap}>
          {editing ? (
            <div className={styles.editNameRow}>
              <input
                className={styles.editInput}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
              <Button variant="teal" size="sm" onClick={saveName} disabled={saving}>
                {saving ? '...' : 'OK'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                ✕
              </Button>
              {saveError && (
                <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4, width: '100%' }}>{saveError}</div>
              )}
            </div>
          ) : (
            <>
              <div className={styles.displayName}>{profile.display_name}</div>
              <Button variant="outline" size="sm" onClick={startEdit} style={{ marginTop: 8 }}>
                Изменить имя
              </Button>
            </>
          )}
          {game && <div className={styles.level}>Уровень {game.level}</div>}
        </div>
      </div>

      {/* Stats */}
      {game && (
        <div className={styles.statsGrid}>
          <ComicPanel className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.xpColor}`}>{game.xp_total}</div>
            <div className={styles.statLabel}>XP</div>
          </ComicPanel>
          <ComicPanel className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.levelColor}`}>{game.level}</div>
            <div className={styles.statLabel}>Уровень</div>
          </ComicPanel>
          <ComicPanel className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.streakColor}`}>{game.current_streak_days}</div>
            <div className={styles.statLabel}>Серия</div>
          </ComicPanel>
          <ComicPanel className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.lessonsColor}`}>{lessonsCompleted}</div>
            <div className={styles.statLabel}>Этапов</div>
          </ComicPanel>
        </div>
      )}

      {/* Badges */}
      {game && game.badges.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Награды</h2>
          <div className={styles.badgesScroll}>
            {game.badges.map((badge) => (
              <ComicPanel key={badge.badge_code} className={styles.badgeItem}>
                <span className={styles.badgeIcon}>
                  {BADGE_ICONS[badge.badge_code] ?? BADGE_ICONS.default}
                </span>
                <span className={styles.badgeCode}>{badge.badge_code}</span>
              </ComicPanel>
            ))}
          </div>
        </div>
      )}

      {/* Courses */}
      {startedCourses.length > 0 && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Миссии</h2>
          <div className={styles.coursesList}>
            {startedCourses.map((c) => {
              const pct = Math.round(c.progress_percent);
              return (
                <ComicPanel key={c.course_id} className={styles.courseItem}>
                  <div className={styles.courseInfo}>
                    <div className={styles.courseName}>{c.title}</div>
                    <div className={styles.courseMeta}>
                      {pct}% пройдено
                    </div>
                  </div>
                  <div className={styles.courseProgress}>
                    <ProgressBar value={pct} height={12} showLabel />
                  </div>
                </ComicPanel>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
