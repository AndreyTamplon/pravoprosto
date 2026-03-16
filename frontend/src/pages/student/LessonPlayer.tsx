import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  startLesson,
  getLessonSession,
  nextStep,
  submitAnswer,
  getGameState,
} from '../../api/client';
import { generateIdempotencyKey, formatMinutesTimer } from '../../utils/format';
import { HudBar, Button, SpeechBubble, ComicBurst } from '../../components/ui';
import type {
  StepView,
  AnswerOutcome,
  GameState,
} from '../../api/types';
import styles from './LessonPlayer.module.css';

/* ===== Types for internal state machine ===== */
type PlayerScreen =
  | { kind: 'loading' }
  | { kind: 'story'; step: StepView }
  | { kind: 'single_choice'; step: StepView }
  | { kind: 'free_text'; step: StepView }
  | { kind: 'checking' }
  | { kind: 'feedback'; result: AnswerOutcome }
  | { kind: 'complete'; completion: Record<string, unknown> | null }
  | { kind: 'hearts_empty'; recoveryAt?: string | null }
  | { kind: 'error'; message: string };

/* ===== Confetti helper ===== */
const CONFETTI_COLORS = ['#F97316', '#0D9488', '#EC4899', '#3B82F6', '#84CC16', '#EAB308'];

function Confetti() {
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 2}s`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    rotation: Math.random() * 360,
    size: 8 + Math.random() * 10,
  }));

  return (
    <div className={styles.confettiWrap}>
      {pieces.map((p) => (
        <div
          key={p.id}
          className={styles.confetti}
          style={{
            left: p.left,
            animationDelay: p.delay,
            backgroundColor: p.color,
            width: p.size,
            height: p.size,
            transform: `rotate(${p.rotation}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/* ===== Recovery Timer ===== */
function RecoveryTimer({ recoveryAt }: { recoveryAt?: string | null }) {
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!recoveryAt) return;
    const target = new Date(recoveryAt).getTime();

    const tick = () => {
      const diff = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setSecondsLeft(diff);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [recoveryAt]);

  if (!recoveryAt || secondsLeft <= 0) return null;

  return (
    <div className={styles.recoveryTimer}>
      {formatMinutesTimer(secondsLeft)}
    </div>
  );
}

/* ===== Main Component ===== */
export default function LessonPlayer() {
  const { courseId, lessonId } = useParams<{ courseId: string; lessonId: string }>();
  const navigate = useNavigate();

  // Session state
  const [currentStep, setCurrentStep] = useState<StepView | null>(null);
  const [screen, setScreen] = useState<PlayerScreen>({ kind: 'loading' });
  const [gameState, setGameState] = useState<GameState | null>(null);

  // Accumulated XP for this session
  const [sessionXp, setSessionXp] = useState(0);

  // Answer state
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeTextValue, setFreeTextValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Idempotency
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());

  // Timer
  const startTimeRef = useRef<number>(Date.now());

  // Load game state
  useEffect(() => {
    getGameState().then(setGameState).catch((err) => {
      console.error('Failed to load game state:', err);
    });
  }, []);

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
      startTimeRef.current = Date.now();
      transitionToStep(step);
    } catch (err) {
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
      case 'free_text':
        setScreen({ kind: 'free_text', step });
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
    if (!step || step.kind === 'loading') return;

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

      // Track XP
      setSessionXp((x) => x + result.xp_delta);

      // Update hearts from the answer outcome game_state
      const newHearts = result.game_state.hearts_current;
      setGameState((gs) => gs ? { ...gs, hearts_current: newHearts, hearts_restore_at: result.game_state.hearts_restore_at } : gs);

      // Check if hearts are depleted
      if (newHearts <= 0) {
        setScreen({ kind: 'hearts_empty', recoveryAt: result.game_state.hearts_restore_at });
        setSubmitting(false);
        return;
      }

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

  // Handle "Next" after feedback
  const handleFeedbackNext = () => {
    if (screen.kind !== 'feedback') return;
    const { result } = screen;

    if (result.next_action === 'lesson_completed' || result.next_action === 'completed') {
      setScreen({ kind: 'complete', completion: result.lesson_completion });
    } else if (result.next_step) {
      transitionToStep(result.next_step);
    } else {
      setScreen({ kind: 'error', message: 'No next step available' });
    }
  };

  // Close / exit
  const handleClose = () => {
    navigate(`/student/courses/${courseId}`);
  };

  // Compute elapsed time
  const elapsedSeconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  // Render HudBar
  const hearts = currentStep?.game_state?.hearts_current ?? gameState?.hearts_current ?? 5;
  const heartsMax = currentStep?.game_state?.hearts_max ?? gameState?.hearts_max ?? 5;
  const xp = (currentStep?.game_state?.xp_total ?? gameState?.xp_total ?? 0) + sessionXp;
  const streak = gameState?.current_streak_days ?? 0;
  const progress = currentStep ? Math.round(currentStep.progress_ratio * 100) : 0;

  // Extract payload helpers
  const payload = (screen.kind === 'story' || screen.kind === 'single_choice' || screen.kind === 'free_text')
    ? screen.step.payload
    : {};

  const storyText = (payload as Record<string, unknown>).text as string | undefined;
  const storySpeaker = (payload as Record<string, unknown>).speaker as string | undefined;
  const illustrationUrl = (payload as Record<string, unknown>).illustration_url as string | undefined;
  const questionText = ((payload as Record<string, unknown>).prompt ?? (payload as Record<string, unknown>).question_text) as string | undefined;
  const options = (payload as Record<string, unknown>).options as Array<{ id: string; text: string }> | undefined;

  return (
    <div className={styles.playerLayout}>
      <HudBar
        onClose={handleClose}
        progress={progress}
        hearts={hearts}
        heartsMax={heartsMax}
        xp={xp}
        streak={streak}
      />

      <div className={styles.body}>
        {/* Loading */}
        {screen.kind === 'loading' && (
          <div className={styles.loadingScreen}>
            <div className={styles.loadingShield}>🛡️</div>
            <div className={styles.loadingText}>Загружаем миссию...</div>
          </div>
        )}

        {/* Story */}
        {screen.kind === 'story' && (
          <div className={styles.storyScreen}>
            {illustrationUrl && (
              <div className={styles.storyIllustration}>
                <img
                  src={illustrationUrl}
                  alt="Иллюстрация"
                  style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }}
                />
              </div>
            )}
            {!illustrationUrl && (
              <div className={styles.storyIllustration}>📖</div>
            )}

            <SpeechBubble direction="bottom">
              {storySpeaker && (
                <div className={styles.storySpeaker}>{storySpeaker}</div>
              )}
              <div className={styles.storyText}>{storyText}</div>
            </SpeechBubble>

            <div className={styles.storyActions}>
              <Button
                variant="primary"
                onClick={handleStoryNext}
                disabled={submitting}
              >
                {submitting ? 'Загрузка...' : 'Далее'}
              </Button>
            </div>
          </div>
        )}

        {/* Single Choice */}
        {screen.kind === 'single_choice' && (
          <div className={styles.questionScreen}>
            {illustrationUrl && (
              <div className={styles.questionIllustration}>
                <img src={illustrationUrl} alt="Иллюстрация" style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />
              </div>
            )}

            <div className={styles.questionText}>
              {questionText}
            </div>

            <div className={styles.options}>
              {(options ?? []).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={[
                    styles.option,
                    selectedOption === opt.id ? styles.optionSelected : '',
                    submitting ? styles.optionDisabled : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => !submitting && setSelectedOption(opt.id)}
                >
                  {opt.text}
                </button>
              ))}
            </div>

            <div className={styles.submitRow}>
              <Button
                variant="primary"
                onClick={handleSubmitAnswer}
                disabled={!selectedOption || submitting}
              >
                Проверить
              </Button>
            </div>
          </div>
        )}

        {/* Free Text */}
        {screen.kind === 'free_text' && (
          <div className={styles.questionScreen}>
            {illustrationUrl && (
              <div className={styles.questionIllustration}>
                <img src={illustrationUrl} alt="Иллюстрация" style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />
              </div>
            )}

            <div className={styles.questionText}>
              {questionText}
            </div>

            <textarea
              className={styles.freeTextArea}
              placeholder="Напиши свой ответ..."
              value={freeTextValue}
              onChange={(e) => setFreeTextValue(e.target.value)}
              disabled={submitting}
            />

            <div className={styles.submitRow}>
              <Button
                variant="primary"
                onClick={handleSubmitAnswer}
                disabled={!freeTextValue.trim() || submitting}
              >
                Проверить
              </Button>
            </div>
          </div>
        )}

        {/* Checking (LLM evaluation) */}
        {screen.kind === 'checking' && (
          <div className={styles.loadingScreen}>
            <div className={styles.loadingShield}>🛡️</div>
            <div className={styles.loadingText}>Проверяем ответ...</div>
          </div>
        )}

        {/* Hearts Empty */}
        {screen.kind === 'hearts_empty' && (
          <div className={styles.heartsEmptyScreen}>
            <div className={styles.heartsEmptyMascot}>😢</div>
            <div className={styles.heartsEmptyTitle}>Жизни закончились 💔</div>
            <div className={styles.heartsEmptyDesc}>
              Подожди, пока жизни восстановятся, или повтори пройденные уроки
            </div>
            <RecoveryTimer recoveryAt={screen.recoveryAt} />
            <Button variant="outline" onClick={handleClose}>
              К пройденным урокам
            </Button>
          </div>
        )}

        {/* Lesson Complete */}
        {screen.kind === 'complete' && (
          <>
            <Confetti />
            <div className={styles.completeScreen}>
              <div className={styles.completeMascot}>🎉🤖🏆</div>
              <div className={styles.completeTitle}>Миссия выполнена!</div>

              <div className={styles.completeStats}>
                <div className={styles.completeStat}>
                  <div className={styles.completeStatValue} style={{ color: 'var(--teal)' }}>
                    +{sessionXp}
                  </div>
                  <div className={styles.completeStatLabel}>XP</div>
                </div>
                <div className={styles.completeStat}>
                  <div className={styles.completeStatValue} style={{ color: 'var(--orange)' }}>
                    {elapsedMinutes}м
                  </div>
                  <div className={styles.completeStatLabel}>Время</div>
                </div>
              </div>

              <div className={styles.completeActions}>
                <Button variant="primary" onClick={handleClose}>
                  К миссии
                </Button>
                <Button variant="outline" onClick={() => navigate('/student/courses')}>
                  Штаб героя
                </Button>
              </div>
            </div>
          </>
        )}

        {/* Error */}
        {screen.kind === 'error' && (
          <div className={styles.errorScreen}>
            <div style={{ fontSize: '3rem' }}>⚠️</div>
            <div style={{ fontWeight: 700 }}>Что-то пошло не так</div>
            <div style={{ color: 'var(--dark-light)', fontSize: '0.9rem' }}>{screen.message}</div>
            <Button variant="outline" onClick={initSession}>
              Попробовать снова
            </Button>
            <Button variant="outline" onClick={handleClose}>
              Назад
            </Button>
          </div>
        )}
      </div>

      {/* Feedback Overlay */}
      {screen.kind === 'feedback' && (
        <div className={styles.feedbackOverlay}>
          <div
            className={[
              styles.feedbackPanel,
              screen.result.verdict === 'correct'
                ? styles.feedbackCorrect
                : screen.result.verdict === 'partial'
                ? styles.feedbackPartial
                : styles.feedbackIncorrect,
            ].join(' ')}
          >
            <div className={styles.feedbackBurst}>
              <ComicBurst>
                {screen.result.verdict === 'correct'
                  ? 'ВЕРНО!'
                  : screen.result.verdict === 'partial'
                  ? 'ПОЧТИ!'
                  : 'ПРОМАХ!'}
              </ComicBurst>
            </div>

            <div className={styles.feedbackText}>{screen.result.feedback_text}</div>

            {screen.result.xp_delta > 0 && (
              <div className={styles.feedbackXp}>+{screen.result.xp_delta} XP ⭐</div>
            )}

            {screen.result.hearts_delta < 0 && (
              <div className={styles.feedbackHearts}>{screen.result.hearts_delta} ❤️</div>
            )}

            <div className={styles.feedbackAction}>
              <Button
                variant={screen.result.verdict === 'correct' ? 'teal' : 'primary'}
                onClick={handleFeedbackNext}
              >
                Далее
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
