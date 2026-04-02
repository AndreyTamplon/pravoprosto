import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getChildProgress, getParentPaidOffers, startParentCheckout } from '../../api/client';
import type { ChildProgress as ChildProgressType, ChildCourseProgress, ParentPaidOffer } from '../../api/types';
import { Button, ComicPanel, Badge, ProgressBar, Spinner } from '../../components/ui';
import { formatPrice, timeAgo } from '../../utils/format';
import s from './ChildProgress.module.css';

const statusMap: Record<string, { label: string; color: 'teal' | 'orange' | 'lime' | 'gray' }> = {
  in_progress: { label: 'В процессе', color: 'orange' },
  completed: { label: 'Завершено', color: 'lime' },
  abandoned: { label: 'Заброшено', color: 'gray' },
};

export default function ChildProgress() {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = useApi<ChildProgressType>(
    () => getChildProgress(studentId!),
    [studentId],
  );
  const {
    data: paidOffers,
    loading: loadingPaidOffers,
    error: paidOffersError,
    reload: reloadPaidOffers,
  } = useApi<ParentPaidOffer[]>(
    () => getParentPaidOffers(studentId!),
    [studentId],
  );

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [payingOfferID, setPayingOfferID] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  const toggle = (courseId: string) =>
    setExpanded(prev => ({ ...prev, [courseId]: !prev[courseId] }));

  const handlePayOffer = async (offer: ParentPaidOffer) => {
    if (!studentId) return;
    setPayingOfferID(offer.offer_id);
    setPayError(null);
    try {
      let paymentURL = offer.payment_url;
      if (!paymentURL) {
        const checkout = await startParentCheckout(studentId, offer.offer_id);
        paymentURL = checkout.payment_url;
      }
      await reloadPaidOffers();
      if (paymentURL) {
        window.location.href = paymentURL;
      }
    } catch (err: unknown) {
      setPayError(err instanceof Error ? err.message : 'Не удалось начать оплату');
    } finally {
      setPayingOfferID(null);
    }
  };

  if (loading) return <Spinner text="Загрузка прогресса..." />;
  if (error) return <div className={s.error}>{error}</div>;
  if (!data) return null;

  const initial = data.display_name.charAt(0).toUpperCase();

  return (
    <div className={s.page}>
      <Button variant="ghost" className={s.backBtn} onClick={() => navigate('/parent')}>
        &larr; Назад
      </Button>

      <div className={s.childHeader}>
        <div className={s.avatar}>{initial}</div>
        <h1 className={s.childName}>{data.display_name}</h1>
      </div>

      <div className={s.statsGrid}>
        <ComicPanel size="sm" accent="teal" className={s.statCard}>
          <div className={s.statValue}>{data.xp_total}</div>
          <div className={s.statLabel}>Очки опыта (XP)</div>
        </ComicPanel>
        <ComicPanel size="sm" accent="orange" className={s.statCard}>
          <div className={s.statValue} style={{ color: 'var(--orange)' }}>{data.current_streak_days}</div>
          <div className={s.statLabel}>Дней подряд</div>
        </ComicPanel>
        <ComicPanel size="sm" accent="blue" className={s.statCard}>
          <div className={s.statValue} style={{ color: 'var(--blue)' }}>{data.accuracy_pct}%</div>
          <div className={s.statLabel}>Точность ответов</div>
        </ComicPanel>
        <ComicPanel size="sm" className={s.statCard}>
          <div className={s.statValue} style={{ color: 'var(--lime)' }}>
            {data.courses.filter(c => c.status === 'completed').length}/{data.courses.length}
          </div>
          <div className={s.statLabel}>Миссий завершено</div>
        </ComicPanel>
      </div>

      <h2 className={s.sectionTitle}>Миссии</h2>

      {data.courses.length === 0 ? (
        <ComicPanel>
          <p style={{ textAlign: 'center', color: 'var(--dark-light)', padding: 20 }}>
            Ребёнок пока не начал ни одной миссии
          </p>
        </ComicPanel>
      ) : (
        <div className={s.courseList}>
          {data.courses.map((course: ChildCourseProgress) => {
            const st = statusMap[course.status] ?? statusMap.in_progress;
            const isExpanded = expanded[course.course_id];
            return (
              <ComicPanel
                key={course.course_id}
                className={s.courseCard}
                onClick={() => toggle(course.course_id)}
              >
                <div className={s.courseHeader}>
                  <span className={s.courseTitle}>{course.title}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge color={st.color} className={s.courseStatus}>{st.label}</Badge>
                    <span className={`${s.expandIcon} ${isExpanded ? s.expandIconOpen : ''}`}>
                      &#9654;
                    </span>
                  </div>
                </div>
                <ProgressBar
                  value={course.completed_lessons}
                  max={course.total_lessons}
                  color="teal"
                  showPct
                  label={`${course.completed_lessons} / ${course.total_lessons} этапов`}
                />
                <div className={s.courseMeta}>
                  <span>Верно: {course.correct_answers}</span>
                  <span>Частично: {course.partial_answers}</span>
                  <span>Неверно: {course.incorrect_answers}</span>
                  <span>Активность: {timeAgo(course.last_activity_at)}</span>
                </div>
                {isExpanded && (
                  <div className={s.lessonList}>
                    <div className={s.lessonRow}>
                      <span className={s.lessonTitle} style={{ fontWeight: 700 }}>Этап</span>
                      <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>Прогресс</span>
                    </div>
                    {/* The API returns course-level data; lessons would come from course tree */}
                    <div className={s.lessonRow}>
                      <span className={s.lessonTitle}>
                        Пройдено {course.completed_lessons} из {course.total_lessons} этапов
                      </span>
                      <Badge color={course.completed_lessons === course.total_lessons ? 'lime' : 'orange'}>
                        {course.completed_lessons === course.total_lessons ? 'Завершено' : 'В процессе'}
                      </Badge>
                    </div>
                  </div>
                )}
              </ComicPanel>
            );
          })}
        </div>
      )}

      <h2 className={s.sectionTitle} style={{ marginTop: 28 }}>Платные уроки</h2>
      {loadingPaidOffers && <Spinner text="Загрузка офферов..." />}
      {paidOffersError && <div className={s.error}>{paidOffersError}</div>}
      {payError && <div className={s.error}>{payError}</div>}
      {!loadingPaidOffers && !paidOffersError && (!paidOffers || paidOffers.length === 0) && (
        <ComicPanel>
          <p style={{ textAlign: 'center', color: 'var(--dark-light)', padding: 20 }}>
            Сейчас нет активных платных уроков
          </p>
        </ComicPanel>
      )}
      {paidOffers && paidOffers.length > 0 && (
        <div className={s.paywallList}>
          {paidOffers.map((offer) => (
            <ComicPanel key={offer.offer_id}>
              <div className={s.paywallRow}>
                <div>
                  <div className={s.paywallTitle}>{offer.title}</div>
                  <div className={s.paywallMeta}>
                    {offer.course_title ?? 'Курс платформы'}
                    {offer.lesson_title ? ` / ${offer.lesson_title}` : ''}
                  </div>
                  <div className={s.paywallPrice}>{formatPrice(offer.price_amount_minor, offer.price_currency)}</div>
                </div>
                <div className={s.paywallActions}>
                  {offer.access_state === 'granted' && <Badge color="lime">Оплачено</Badge>}
                  {offer.access_state === 'awaiting_payment_confirmation' && (
                    <>
                      <Badge color="orange">Ожидает подтверждения</Badge>
                      <Button
                        size="sm"
                        onClick={() => handlePayOffer(offer)}
                        loading={payingOfferID === offer.offer_id}
                      >
                        {offer.payment_url ? 'Продолжить оплату' : 'Оплатить'}
                      </Button>
                    </>
                  )}
                  {offer.access_state === 'locked_paid' && (
                    <Button
                      size="sm"
                      onClick={() => handlePayOffer(offer)}
                      loading={payingOfferID === offer.offer_id}
                    >
                      Оплатить
                    </Button>
                  )}
                </div>
              </div>
            </ComicPanel>
          ))}
        </div>
      )}
    </div>
  );
}
