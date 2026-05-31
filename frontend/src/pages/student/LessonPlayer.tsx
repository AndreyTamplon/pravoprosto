import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  startLesson,
  getLessonSession,
  nextStep,
  submitAnswer,
  chooseDecision,
  goBackInLesson,
  retryLesson,
  abandonLessonSession,
  ApiRequestError,
} from '../../api/client';
import { generateIdempotencyKey } from '../../utils/format';
import { Button, ComicPanel, Badge, ProgressBar, Modal, Spinner } from '../../components/ui';
import type { StepView, AnswerOutcome } from '../../api/types';
import styles from './LessonPlayer.module.css';

/* ===== Types for internal state machine ===== */
type PlayerScreen =
  | { kind: 'loading' }
  | { kind: 'story'; step: StepView }
  | { kind: 'single_choice'; step: StepView }
  | { kind: 'decision'; step: StepView }
  | { kind: 'free_text'; step: StepView }
  | { kind: 'end'; step: StepView }
  | { kind: 'checking' }
  | { kind: 'feedback'; result: AnswerOutcome }
  | { kind: 'complete'; completion: Record<string, unknown> | null }
  | { kind: 'paywall' }
  | { kind: 'error'; message: string };

/* ===== Main Component ===== */
export default function LessonPlayer() {
  const { courseId, lessonId } = useParams<{ courseId: string; lessonId: string }>();
  const navigate = useNavigate();

  // Session state
  const [currentStep, setCurrentStep] = useState<StepView | null>(null);
  const [screen, setScreen] = useState<PlayerScreen>({ kind: 'loading' });

  // Answer state
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeTextValue, setFreeTextValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Exit confirmation
  const [confirmExitOpen, setConfirmExitOpen] = useState(false);

  // Idempotency
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());

  // Initialize session
  const initSession = useCallback(async () => {
    if (!courseId || !lessonId) return;
    setScreen({ kind: 'loading' });
    try {
      // Try to resume existing session first
      let step: StepView;
      try {
        step = await getLessonSession(courseId, lessonId);
      } catch {
        step = await startLesson(courseId, lessonId);
      }
      setCurrentStep(step);
      transitionToStep(step);
    } catch (err) {
      // Locked behind the platform paywall — show a dedicated screen instead of a generic error.
      if (err instanceof ApiRequestError && err.code === 'content_locked_paid') {
        setScreen({ kind: 'paywall' });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to start lesson';
      setScreen({ kind: 'error', message });
    }
  }, [courseId, lessonId]);

  useEffect(() => {
    initSession();
  }, [initSession]);

  // Transition to the correct screen based on node_kind
  const transitionToStep = (step: StepView) => {
    setSelectedOption(null);
    setFreeTextValue('');
    idempotencyKeyRef.current = generateIdempotencyKey();

    switch (step.node_kind) {
      case 'story':
        setScreen({ kind: 'story', step });
        break;
      case 'single_choice':
        setScreen({ kind: 'single_choice', step });
        break;
      case 'decision':
        setScreen({ kind: 'decision', step });
        break;
      case 'free_text':
        setScreen({ kind: 'free_text', step });
        break;
      case 'end':
        setScreen({ kind: 'end', step });
        break;
      default:
        setScreen({ kind: 'error', message: `Unknown step type: ${step.node_kind}` });
    }
  };

  // Handle "Next" for story nodes
  const handleStoryNext = async () => {
    if (!currentStep) return;
    setSubmitting(true);
    try {
      const updated = await nextStep(currentStep.session_id, currentStep.state_version, currentStep.node_id);
      setCurrentStep(updated);
      transitionToStep(updated);
    } catch (err) {
      setScreen({ kind: 'error', message: err instanceof Error ? err.message : 'Error' });
    } finally {
      setSubmitting(false);
    }
  };

  // Submit answer for question nodes
  const handleSubmitAnswer = async () => {
    if (!currentStep) return;
    const step = screen.kind === 'single_choice' || screen.kind === 'free_text' ? screen : null;
    if (!step) return;

    let answer: unknown;
    if (step.kind === 'single_choice') {
      if (!selectedOption) return;
      answer = { option_id: selectedOption };
    } else {
      if (!freeTextValue.trim()) return;
      answer = { text: freeTextValue.trim() };
    }

    setScreen({ kind: 'checking' });
    setSubmitting(true);

    try {
      const result = await submitAnswer(
        currentStep.session_id,
        {
          node_id: currentStep.node_id,
          answer,
          state_version: currentStep.state_version,
        },
        idempotencyKeyRef.current,
      );

      // Update current step if next_step is present
      if (result.next_step) {
        setCurrentStep(result.next_step);
      }

      // Show feedback
      setScreen({ kind: 'feedback', result });
    } catch (err) {
      setScreen({ kind: 'error', message: err instanceof Error ? err.message : 'Error submitting answer' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecision = async () => {
    if (!currentStep || !selectedOption) return;
    setSubmitting(true);
    try {
      const updated = await chooseDecision(currentStep.session_id, {
        node_id: currentStep.node_id,
        option_id: selectedOption,
        state_version: currentStep.state_version,
      });
      setCurrentStep(updated);
      transitionToStep(updated);
    } catch (err) {
      setScreen({ kind: 'error', message: err instanceof Error ? err.message : 'Ошибка выбора' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoBack = async () => {
    if (!currentStep) return;
    setSubmitting(true);
    try {
      const updated = await goBackInLesson(currentStep.session_id, currentStep.state_version);
      setCurrentStep(updated);
      transitionToStep(updated);
    } catch (err) {
      setScreen({ kind: 'error', message: err instanceof Error ? err.message : 'Ошибка возврата' });
    } finally {
      setSubmitting(false);
    }
  };

  // Handle "Next" after feedback
  const handleFeedbackNext = () => {
    if (screen.kind !== 'feedback') return;
    const { result } = screen;

    if (result.next_action === 'lesson_completed' || result.next_action === 'completed') {
      setScreen({ kind: 'complete', completion: result.lesson_completion });
    } else if (result.next_step) {
      setCurrentStep(result.next_step);
      transitionToStep(result.next_step);
    } else {
      setScreen({ kind: 'error', message: 'No next step available' });
    }
  };

  const handleEndComplete = () => {
    setScreen({ kind: 'complete', completion: null });
  };

  // Navigate away from the player without abandoning (used after confirm or on terminal screens)
  const navigateAway = () => {
    if (courseId) {
      window.location.assign(`/student/courses/${courseId}`);
      return;
    }
    navigate('/student/courses');
  };

  // Close / exit — opens confirm modal on active screens, navigates directly on terminal ones
  const handleClose = () => {
    if (submitting) return;
    if (screen.kind === 'complete' || screen.kind === 'error') {
      navigateAway();
      return;
    }
    setConfirmExitOpen(true);
  };

  const handleCancelExit = () => setConfirmExitOpen(false);

  const handleConfirmExit = async () => {
    setConfirmExitOpen(false);
    if (currentStep?.session_id) {
      try {
        await abandonLessonSession(currentStep.session_id);
      } catch (err) {
        console.warn('Failed to abandon lesson session:', err);
      }
    }
    navigateAway();
  };

  // Retry the lesson from the complete screen
  const handleRetry = async () => {
    if (!courseId || !lessonId) return;
    setSubmitting(true);
    try {
      const step = await retryLesson(courseId, lessonId);
      setCurrentStep(step);
      transitionToStep(step);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось перезапустить этап';
      setScreen({ kind: 'error', message });
    } finally {
      setSubmitting(false);
    }
  };

  const progress = currentStep ? Math.round(currentStep.progress_ratio * 100) : 0;

  // Extract payload helpers
  const payload = (screen.kind === 'story' || screen.kind === 'single_choice' || screen.kind === 'decision' || screen.kind === 'free_text' || screen.kind === 'end')
    ? screen.step.payload
    : {};

  const storyText = (payload as Record<string, unknown>).text as string | undefined;
  const storySpeaker = (payload as Record<string, unknown>).speaker as string | undefined;
  const illustrationUrl = (payload as Record<string, unknown>).illustration_url as string | undefined;
  const questionText = ((payload as Record<string, unknown>).prompt ?? (payload as Record<string, unknown>).question_text) as string | undefined;
  const options = (payload as Record<string, unknown>).options as Array<{ id: string; text: string }> | undefined;
  const canGoBack = Boolean(
    (screen.kind === 'story' || screen.kind === 'decision' || screen.kind === 'end')
      ? screen.step.navigation?.can_go_back
      : currentStep?.navigation?.can_go_back,
  );

  const completion = screen.kind === 'complete' ? screen.completion : null;
  const endText = typeof completion?.end_text === 'string' ? (completion.end_text as string) : '';

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <button
          className={styles.closeBtn}
          onClick={handleClose}
          aria-label="Close"
          data-role="hud-close"
          type="button"
          disabled={submitting}
        >
          ✕
        </button>
        <div className={styles.progressWrap}>
          <ProgressBar value={progress} height={12} showLabel />
        </div>
      </div>

      <div className={styles.playerArea}>
        {/* Loading */}
        {screen.kind === 'loading' && (
          <ComicPanel>
            <div className={styles.centerState}>
              <Spinner />
              <div className={styles.centerStateText}>Загружаем миссию...</div>
            </div>
          </ComicPanel>
        )}

        {/* Checking (LLM evaluation) */}
        {screen.kind === 'checking' && (
          <ComicPanel>
            <div className={styles.centerState}>
              <Spinner />
              <div className={styles.centerStateText}>Проверяем ответ...</div>
            </div>
          </ComicPanel>
        )}

        {/* Story */}
        {screen.kind === 'story' && (
          <ComicPanel>
            <div className={styles.stepCard} data-node-kind="story" data-role="current-node">
              <Badge variant="teal">История</Badge>
              {illustrationUrl && (
                <img src={illustrationUrl} alt="Иллюстрация" className={styles.illustration} />
              )}
              {storySpeaker && <div className={styles.speaker}>{storySpeaker}</div>}
              <div className={styles.storyText} data-role="prompt">{storyText}</div>
              <div className={styles.actionBar}>
                {canGoBack && (
                  <Button variant="outline" onClick={handleGoBack} disabled={submitting}>
                    Назад к выбору
                  </Button>
                )}
                <Button variant="primary" onClick={handleStoryNext} disabled={submitting}>
                  {submitting ? 'Загрузка...' : 'Далее'}
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Single Choice */}
        {screen.kind === 'single_choice' && (
          <ComicPanel>
            <div className={styles.stepCard} data-node-kind="single_choice" data-role="current-node">
              <Badge variant="orange">Вопрос</Badge>
              {illustrationUrl && (
                <img src={illustrationUrl} alt="Иллюстрация" className={styles.illustration} />
              )}
              <div className={styles.questionText} data-role="prompt">{questionText}</div>
              <div className={styles.optionsList}>
                {(options ?? []).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-role="option"
                    data-option-id={opt.id}
                    className={`${styles.optionBtn} ${selectedOption === opt.id ? styles.optionSelected : ''}`}
                    onClick={() => !submitting && setSelectedOption(opt.id)}
                    disabled={submitting}
                  >
                    {opt.text}
                  </button>
                ))}
              </div>
              <div className={styles.actionBar}>
                <Button variant="primary" onClick={handleSubmitAnswer} disabled={!selectedOption || submitting}>
                  Проверить
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Decision */}
        {screen.kind === 'decision' && (
          <ComicPanel>
            <div className={styles.stepCard} data-node-kind="decision" data-role="current-node">
              <Badge variant="teal">Развилка</Badge>
              <div className={styles.questionText} data-role="prompt">{questionText}</div>
              <div className={styles.optionsList}>
                {(options ?? []).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    data-role="option"
                    data-option-id={opt.id}
                    className={`${styles.optionBtn} ${selectedOption === opt.id ? styles.optionSelected : ''}`}
                    onClick={() => !submitting && setSelectedOption(opt.id)}
                    disabled={submitting}
                  >
                    {opt.text}
                  </button>
                ))}
              </div>
              <div className={styles.actionBar}>
                {canGoBack && (
                  <Button variant="outline" onClick={handleGoBack} disabled={submitting}>
                    Назад к выбору
                  </Button>
                )}
                <Button variant="primary" onClick={handleDecision} disabled={!selectedOption || submitting}>
                  Выбрать
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Free Text */}
        {screen.kind === 'free_text' && (
          <ComicPanel>
            <div className={styles.stepCard} data-node-kind="free_text" data-role="current-node">
              <Badge variant="pink">Свободный ответ</Badge>
              {illustrationUrl && (
                <img src={illustrationUrl} alt="Иллюстрация" className={styles.illustration} />
              )}
              <div className={styles.questionText} data-role="prompt">{questionText}</div>
              <textarea
                className={styles.freeTextInput}
                placeholder="Напиши свой ответ..."
                value={freeTextValue}
                onChange={(e) => setFreeTextValue(e.target.value)}
                disabled={submitting}
              />
              <div className={styles.actionBar}>
                <Button variant="primary" onClick={handleSubmitAnswer} disabled={!freeTextValue.trim() || submitting}>
                  Проверить
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Terminal node */}
        {screen.kind === 'end' && (
          <ComicPanel>
            <div className={styles.stepCard} data-node-kind="end" data-role="current-node">
              <Badge variant="lime">Финал</Badge>
              <div className={styles.storyText} data-role="prompt">{storyText || 'Миссия завершена!'}</div>
              <div className={styles.actionBar}>
                {canGoBack && (
                  <Button variant="outline" onClick={handleGoBack} disabled={submitting}>
                    Назад к выбору
                  </Button>
                )}
                <Button variant="primary" onClick={handleEndComplete} disabled={submitting}>
                  Завершить миссию
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Feedback */}
        {screen.kind === 'feedback' && (
          <ComicPanel>
            <div className={styles.stepCard}>
              <div
                className={`${styles.feedback} ${
                  screen.result.verdict === 'correct'
                    ? styles.feedbackCorrect
                    : screen.result.verdict === 'partial'
                    ? styles.feedbackPartial
                    : styles.feedbackIncorrect
                }`}
                data-role="feedback"
                data-verdict={screen.result.verdict}
              >
                <div className={styles.feedbackVerdict}>
                  {screen.result.verdict === 'correct'
                    ? 'ВЕРНО!'
                    : screen.result.verdict === 'partial'
                    ? 'ПОЧТИ!'
                    : 'ПРОМАХ!'}
                </div>
                <div className={styles.feedbackText}>{screen.result.feedback_text}</div>
                {screen.result.xp_delta > 0 && (
                  <div className={styles.feedbackXp}>+{screen.result.xp_delta} XP ⭐</div>
                )}
              </div>
              <div className={styles.actionBar}>
                <Button variant={screen.result.verdict === 'correct' ? 'teal' : 'primary'} onClick={handleFeedbackNext}>
                  Далее
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Lesson Complete */}
        {screen.kind === 'complete' && (
          <ComicPanel>
            <div className={styles.completeWrap} data-role="lesson-complete">
              <div className={styles.completeMascot}>🎉</div>
              <div className={styles.completeTitle}>Миссия выполнена!</div>
              {endText.trim() !== '' && <div className={styles.completeSummary}>{endText}</div>}
              <div className={styles.actionBar}>
                <Button variant="primary" onClick={handleRetry} disabled={submitting} data-role="lesson-retry">
                  Пройти заново
                </Button>
                <Button variant="outline" onClick={handleClose} disabled={submitting}>
                  К миссии
                </Button>
                <Button variant="outline" onClick={() => navigate('/student/courses')} disabled={submitting}>
                  Штаб героя
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Paywall */}
        {screen.kind === 'paywall' && (
          <ComicPanel>
            <div className={styles.centerState}>
              <div className={styles.errorIcon}>💎</div>
              <div className={styles.centerStateText}>Этот этап входит в полный доступ</div>
              <div className={styles.errorMessage}>
                Первый модуль бесплатный. Чтобы открыть все этапы, оформи полный доступ — или попроси родителя.
              </div>
              <div className={styles.actionBar}>
                <Button variant="primary" onClick={() => navigate(`/student/courses/${courseId}`)}>
                  Открыть полный доступ
                </Button>
                <Button variant="outline" onClick={handleClose}>Назад</Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Error */}
        {screen.kind === 'error' && (
          <ComicPanel>
            <div className={styles.centerState}>
              <div className={styles.errorIcon}>⚠️</div>
              <div className={styles.centerStateText}>Что-то пошло не так</div>
              <div className={styles.errorMessage}>{screen.message}</div>
              <div className={styles.actionBar}>
                <Button variant="outline" onClick={initSession}>Попробовать снова</Button>
                <Button variant="outline" onClick={handleClose}>Назад</Button>
              </div>
            </div>
          </ComicPanel>
        )}
      </div>

      <Modal
        open={confirmExitOpen}
        onClose={handleCancelExit}
        title="Выйти из этапа?"
        footer={
          <>
            <Button variant="outline" autoFocus onClick={handleCancelExit} data-role="confirm-stay">
              Остаться
            </Button>
            <Button variant="primary" onClick={handleConfirmExit} data-role="confirm-exit">
              Выйти
            </Button>
          </>
        }
      >
        Прогресс этого этапа будет потерян, и в следующий раз он начнётся с первого шага.
      </Modal>
    </div>
  );
}
