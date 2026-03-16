import { useState, useCallback } from 'react';
import { useApi } from '../../hooks/useApi';
import { getModerationQueue, approveReview, rejectReview, createAdminPreview } from '../../api/client';
import { Button, Badge, Spinner, Modal, EmptyState } from '../../components/ui';
import { formatDateTime } from '../../utils/format';
import type { PendingReview } from '../../api/types';
import styles from './Moderation.module.css';

export default function Moderation() {
  const { data, loading, error, reload } = useApi<PendingReview[]>(() => getModerationQueue(), []);
  const [selected, setSelected] = useState<PendingReview | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const handleApprove = useCallback(async (review: PendingReview) => {
    setActionLoading(true);
    setActionError('');
    try {
      await approveReview(review.review_id);
      setSelected(null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(false);
    }
  }, [reload]);

  const handleReject = useCallback(async (review: PendingReview) => {
    if (!rejectComment.trim()) return;
    setActionLoading(true);
    setActionError('');
    try {
      await rejectReview(review.review_id, rejectComment.trim());
      setSelected(null);
      setShowReject(false);
      setRejectComment('');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(false);
    }
  }, [rejectComment, reload]);

  const handlePreview = useCallback(async (review: PendingReview) => {
    try {
      // Preview the first lesson of the course
      const session = await createAdminPreview(review.course_id, 'first');
      window.open(`/admin/preview/${session.session_id}`, '_blank');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка предпросмотра');
    }
  }, []);

  if (loading) return <Spinner />;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Модерация курсов</h1>
        <Badge color="orange">{data?.length ?? 0} в очереди</Badge>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="📋" title="Очередь пуста" description="Нет курсов на модерации" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Курс</th>
              <th>Учитель</th>
              <th>Отправлен</th>
              <th>Версия</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => (
              <tr key={r.review_id} onClick={() => { setSelected(r); setShowReject(false); setRejectComment(''); setActionError(''); }}>
                <td className={styles.courseTitle}>{r.course_title}</td>
                <td>{r.teacher_name}</td>
                <td>{formatDateTime(r.submitted_at)}</td>
                <td><Badge color="gray">v{r.draft_version}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={selected !== null}
        onClose={() => { setSelected(null); setShowReject(false); setActionError(''); }}
        title="Проверка курса"
      >
        {selected && (
          <div className={styles.reviewDetail}>
            <div className={styles.reviewInfo}>
              <span className={styles.infoLabel}>Курс</span>
              <span className={styles.infoValue}>{selected.course_title}</span>

              <span className={styles.infoLabel}>Учитель</span>
              <span className={styles.infoValue}>{selected.teacher_name}</span>

              <span className={styles.infoLabel}>Отправлен</span>
              <span className={styles.infoValue}>{formatDateTime(selected.submitted_at)}</span>

              <span className={styles.infoLabel}>Версия черновика</span>
              <span className={styles.infoValue}>{selected.draft_version}</span>

              <span className={styles.infoLabel}>ID курса</span>
              <span className={styles.infoValue}>{selected.course_id}</span>
            </div>

            {actionError && <div className={styles.error}>{actionError}</div>}

            <div className={styles.reviewActions}>
              <Button variant="secondary" onClick={() => handlePreview(selected)}>
                Предпросмотр
              </Button>
              <Button variant="success" onClick={() => handleApprove(selected)} loading={actionLoading && !showReject}>
                Одобрить
              </Button>
              <Button variant="danger" onClick={() => setShowReject(!showReject)}>
                Отклонить
              </Button>
            </div>

            {showReject && (
              <div className={styles.rejectSection}>
                <div className={styles.rejectLabel}>Причина отклонения</div>
                <textarea
                  className={styles.rejectTextarea}
                  value={rejectComment}
                  onChange={e => setRejectComment(e.target.value)}
                  placeholder="Укажите причину отклонения..."
                  rows={3}
                />
                <Button
                  variant="danger"
                  onClick={() => handleReject(selected)}
                  loading={actionLoading}
                  disabled={!rejectComment.trim()}
                >
                  Подтвердить отклонение
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
