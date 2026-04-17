import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getModerationQueue,
  approveReview,
  rejectReview,
  createModerationPreview,
  getModerationReviewDraft,
} from '../../api/client';
import { Button, Badge, Spinner, Modal, EmptyState, Select } from '../../components/ui';
import { formatDateTime } from '../../utils/format';
import type { PendingReview } from '../../api/types';
import styles from './Moderation.module.css';

interface PreviewLessonOption {
  lessonId: string;
  label: string;
}

export default function Moderation() {
  const location = useLocation();
  const { data, loading, error, reload } = useApi<PendingReview[]>(() => getModerationQueue(), []);
  const [selected, setSelected] = useState<PendingReview | null>(null);
  const [showReject, setShowReject] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [previewLessons, setPreviewLessons] = useState<PreviewLessonOption[]>([]);
  const [previewLessonId, setPreviewLessonId] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadLessons = async () => {
      if (!selected) {
        setPreviewLessons([]);
        setPreviewLessonId('');
        return;
      }

      setPreviewLoading(true);
      setActionError('');
      try {
        const draft = await getModerationReviewDraft(selected.review_id);
        const lessons = (draft.content_json.modules ?? []).flatMap(module =>
          module.lessons.map((lesson, index) => ({
            lessonId: lesson.id,
            label: `${module.title} / ${index + 1}. ${lesson.title}`,
          })),
        );
        if (!cancelled) {
          setPreviewLessons(lessons);
          setPreviewLessonId(lessons[0]?.lessonId ?? '');
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewLessons([]);
          setPreviewLessonId('');
          setActionError(err instanceof Error ? err.message : 'Не удалось загрузить уроки');
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void loadLessons();
    return () => {
      cancelled = true;
    };
  }, [selected]);

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

  const previewingRef = useRef(false);
  const handlePreview = useCallback(async (review: PendingReview) => {
    if (!previewLessonId) {
      setActionError('Выберите урок для предпросмотра');
      return;
    }
    if (previewingRef.current) return;
    previewingRef.current = true;
    const win = window.open('about:blank', '_blank');
    if (!win) {
      previewingRef.current = false;
      setActionError('Разрешите всплывающие окна для предпросмотра');
      return;
    }
    try {
      const session = await createModerationPreview(review.review_id, previewLessonId, location.pathname);
      win.location.href = `/admin/preview/${session.preview_session_id}?return_to=${encodeURIComponent(location.pathname)}`;
    } catch (err) {
      win.close();
      setActionError(err instanceof Error ? err.message : 'Ошибка предпросмотра');
    } finally {
      previewingRef.current = false;
    }
  }, [location.pathname, previewLessonId]);

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
            {data.map(review => (
              <tr
                key={review.review_id}
                onClick={() => {
                  setSelected(review);
                  setShowReject(false);
                  setRejectComment('');
                  setActionError('');
                }}
              >
                <td className={styles.courseTitle}>{review.course_title}</td>
                <td>{review.teacher_name}</td>
                <td>{formatDateTime(review.submitted_at)}</td>
                <td><Badge color="gray">v{review.draft_version}</Badge></td>
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

            {previewLoading ? (
              <Spinner text="Загрузка уроков..." />
            ) : (
              <Select
                label="Урок для предпросмотра"
                value={previewLessonId}
                onChange={event => setPreviewLessonId(event.target.value)}
              >
                {previewLessons.length === 0 ? (
                  <option value="">Нет уроков для предпросмотра</option>
                ) : (
                  previewLessons.map(lesson => (
                    <option key={lesson.lessonId} value={lesson.lessonId}>
                      {lesson.label}
                    </option>
                  ))
                )}
              </Select>
            )}

            {actionError && <div className={styles.error}>{actionError}</div>}

            <div className={styles.reviewActions}>
              <Button
                variant="secondary"
                onClick={() => handlePreview(selected)}
                disabled={previewLoading || !previewLessonId}
              >
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
