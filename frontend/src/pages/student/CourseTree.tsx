import { useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getCourseTree, createPurchaseRequest } from '../../api/client';
import { Button, Badge, Spinner, EmptyState } from '../../components/ui';
import { formatPrice } from '../../utils/format';
import type { LessonNode, LessonAccessState } from '../../api/types';
import styles from './CourseTree.module.css';

function getNodeAppearance(access: LessonAccessState, hasProgress: boolean): {
  cls: string;
  icon: string;
} {
  if (access === 'completed') return { cls: styles.nodeCompleted, icon: '✓' };
  if (access === 'free' || access === 'granted') {
    return hasProgress
      ? { cls: styles.nodeActive, icon: '▶' }
      : { cls: styles.nodeActive, icon: '▶' };
  }
  if (access === 'locked_paid') return { cls: styles.nodePaid, icon: '💎' };
  if (access === 'awaiting_payment_confirmation') return { cls: styles.nodeAwaiting, icon: '⏳' };
  return { cls: styles.nodeLocked, icon: '🔒' };
}

function LessonNodeItem({
  node,
  isFirst,
  prevCompleted,
  courseId,
  onReload,
}: {
  node: LessonNode;
  isFirst: boolean;
  prevCompleted: boolean;
  courseId: string;
  onReload: () => void;
}) {
  const navigate = useNavigate();
  const [requesting, setRequesting] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const accessState = node.access.access_state;
  const offer = node.access.offer;
  const isCompleted = accessState === 'completed';
  const isActive = accessState === 'free' || accessState === 'granted';
  const hasProgress = node.status === 'in_progress';
  const appearance = getNodeAppearance(accessState, hasProgress);

  const handleStart = () => {
    navigate(`/student/courses/${courseId}/lessons/${node.lesson_id}`);
  };

  const handlePurchase = async () => {
    if (!offer || requesting) return;
    setRequesting(true);
    setPurchaseError(null);
    try {
      await createPurchaseRequest(offer.offer_id);
      onReload();
    } catch (err: unknown) {
      setPurchaseError(err instanceof Error ? err.message : 'Ошибка отправки заявки');
      setRequesting(false);
    }
  };

  return (
    <div className={styles.nodeWrap}>
      {!isFirst && (
        <div className={`${styles.connector} ${prevCompleted ? styles.connectorDone : ''}`} />
      )}

      <div
        className={`${styles.node} ${appearance.cls}`}
        onClick={isActive ? handleStart : undefined}
        role={isActive ? 'button' : undefined}
        tabIndex={isActive ? 0 : undefined}
      >
        {appearance.icon}
      </div>

      <div className={styles.nodeLabel}>
        <div className={styles.nodeName}>{node.title}</div>
      </div>

      {isActive && (
        <div className={styles.nodeAction}>
          <Button variant="primary" size="sm" onClick={handleStart}>
            {hasProgress ? 'Продолжить' : 'Начать миссию'}
          </Button>
        </div>
      )}

      {accessState === 'locked_paid' && offer && (
        <div className={styles.nodeAction}>
          <Badge variant="orange" className={styles.priceBadge}>
            {formatPrice(offer.price_amount_minor, offer.price_currency)}
          </Badge>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handlePurchase}
              disabled={requesting || offer.has_open_request}
            >
              {offer.has_open_request ? 'Заявка отправлена' : 'Оставить заявку'}
            </Button>
          </div>
          {purchaseError && (
            <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>{purchaseError}</div>
          )}
        </div>
      )}

      {accessState === 'awaiting_payment_confirmation' && (
        <div className={styles.nodeAction}>
          <Badge variant="yellow">Ожидает подтверждения</Badge>
        </div>
      )}
    </div>
  );
}

export default function CourseTree() {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: tree, loading, error, reload } = useApi(
    () => getCourseTree(courseId!),
    [courseId, location.key],
  );

  if (loading) return <Spinner />;
  if (error || !tree) {
    return <EmptyState icon="⚠️" title="Ошибка загрузки" description={error ?? 'Курс не найден'} />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button
          className={styles.backBtn}
          onClick={() => navigate('/student/courses')}
          type="button"
        >
          ←
        </button>
        <div>
          <h1 className={styles.courseTitle}>{tree.title}</h1>
          {tree.progress && (
            <div className={styles.courseSub}>
              {tree.progress.completed_lessons}/{tree.progress.total_lessons} этапов пройдено
            </div>
          )}
        </div>
      </div>

      <div className={styles.tree}>
        {tree.modules.map((mod) => (
          <div key={mod.module_id} className={styles.module}>
            <div className={styles.moduleTitle}>{mod.title}</div>
            {mod.lessons.map((lesson, i) => {
              const prevLesson = i > 0 ? mod.lessons[i - 1] : null;
              const prevCompleted = prevLesson?.access.access_state === 'completed';
              return (
                <LessonNodeItem
                  key={lesson.lesson_id}
                  node={lesson}
                  isFirst={i === 0}
                  prevCompleted={prevCompleted}
                  courseId={courseId!}
                  onReload={reload}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
