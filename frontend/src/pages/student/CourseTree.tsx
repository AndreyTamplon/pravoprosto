import { useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getCourseTree, createPurchaseRequest, startStudentCheckout, retryLesson, ApiRequestError } from '../../api/client';
import { Button, Badge, Spinner, EmptyState, Input } from '../../components/ui';
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
  const [checkingOut, setCheckingOut] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [emailPrompt, setEmailPrompt] = useState(false);
  const [emailValue, setEmailValue] = useState('');

  const accessState = node.access.access_state;
  const offer = node.access.offer;
  const isCompleted = accessState === 'completed';
  const isActive = accessState === 'free' || accessState === 'granted';
  const hasProgress = node.status === 'in_progress';
  const appearance = getNodeAppearance(accessState, hasProgress);

  const handleStart = () => {
    navigate(`/student/courses/${courseId}/lessons/${node.lesson_id}`);
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await retryLesson(courseId, node.lesson_id);
      navigate(`/student/courses/${courseId}/lessons/${node.lesson_id}`);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Не удалось перезапустить этап');
    } finally {
      setRetrying(false);
    }
  };

  // Only `active` (free/granted) nodes are clickable. Completed nodes use the explicit «Пройти заново»
  // button — clicking the ✓ circle directly would create a new session without an obvious user intent
  // and inflate `lesson_progress.replay_count` (see decisions D-2).
  const handleNodeClick = isActive ? handleStart : undefined;

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

  // Self-checkout: redirect the student to the T-Bank hosted payment page for the platform product.
  // The fiscal receipt needs the buyer's email; if the account has none, the backend returns
  // `email_required` and we ask for one inline, then retry.
  const handleCheckout = async (email?: string) => {
    if (!offer || checkingOut) return;
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      const res = await startStudentCheckout(offer.offer_id, email);
      if (!res.payment_url) {
        setCheckoutError('Не удалось получить ссылку на оплату');
        setCheckingOut(false);
        return;
      }
      window.location.href = res.payment_url;
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.code === 'email_required') {
        setEmailPrompt(true);
        setCheckingOut(false);
        return;
      }
      setCheckoutError(err instanceof Error ? err.message : 'Не удалось перейти к оплате');
      setCheckingOut(false);
    }
  };

  // Resume an abandoned checkout from the "awaiting" state — reuse the existing T-Bank payment URL,
  // or ask the backend for it (it returns the pending order's URL).
  const handleResume = async () => {
    const order = node.access.order;
    if (!order?.offer_id || checkingOut) return;
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      if (order.payment_url) {
        window.location.href = order.payment_url;
        return;
      }
      const res = await startStudentCheckout(order.offer_id);
      if (!res.payment_url) {
        setCheckoutError('Не удалось получить ссылку на оплату');
        setCheckingOut(false);
        return;
      }
      window.location.href = res.payment_url;
    } catch (err: unknown) {
      setCheckoutError(err instanceof Error ? err.message : 'Не удалось вернуться к оплате');
      setCheckingOut(false);
    }
  };

  return (
    <div className={styles.nodeWrap}>
      {!isFirst && (
        <div className={`${styles.connector} ${prevCompleted ? styles.connectorDone : ''}`} />
      )}

      <div
        className={`${styles.node} ${appearance.cls}`}
        onClick={handleNodeClick}
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

      {isCompleted && (
        <div className={styles.nodeAction}>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={retrying}
            data-role="lesson-retry-tree"
          >
            {retrying ? 'Перезапуск...' : 'Пройти заново'}
          </Button>
          {retryError && (
            <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>{retryError}</div>
          )}
        </div>
      )}

      {accessState === 'locked_paid' && offer && (
        <div className={styles.nodeAction}>
          <Badge variant="orange" className={styles.priceBadge}>
            {formatPrice(offer.price_amount_minor, offer.price_currency)}
          </Badge>
          {!emailPrompt ? (
            <>
              <div style={{ marginTop: 8 }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleCheckout()}
                  disabled={checkingOut}
                >
                  {checkingOut ? 'Переход к оплате…' : 'Открыть полный доступ'}
                </Button>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: 6 }}>
                или попроси родителя оплатить
              </div>
              <div style={{ marginTop: 6 }}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePurchase}
                  disabled={requesting || offer.has_open_request}
                >
                  {offer.has_open_request ? 'Заявка отправлена' : 'Оставить заявку'}
                </Button>
              </div>
            </>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: '0.85rem', color: '#374151', marginBottom: 6 }}>
                Укажи e-mail — туда придёт чек об оплате:
              </div>
              <Input
                type="email"
                placeholder="you@example.com"
                value={emailValue}
                onChange={e => setEmailValue(e.target.value)}
                aria-label="E-mail для чека"
              />
              <div style={{ marginTop: 6 }}>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleCheckout(emailValue.trim())}
                  disabled={checkingOut || !emailValue.trim()}
                >
                  {checkingOut ? 'Переход к оплате…' : 'Оплатить'}
                </Button>
              </div>
            </div>
          )}
          {(checkoutError || purchaseError) && (
            <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>{checkoutError ?? purchaseError}</div>
          )}
        </div>
      )}

      {accessState === 'awaiting_payment_confirmation' && (
        <div className={styles.nodeAction}>
          <Badge variant="yellow">Ожидает подтверждения</Badge>
          {node.access.order?.offer_id && (
            <div style={{ marginTop: 6 }}>
              <Button variant="primary" size="sm" onClick={handleResume} disabled={checkingOut}>
                {checkingOut ? 'Переход к оплате…' : 'Продолжить оплату'}
              </Button>
            </div>
          )}
          {checkoutError && (
            <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: 4 }}>{checkoutError}</div>
          )}
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
