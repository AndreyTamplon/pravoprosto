import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getSessionById, previewNext, previewAnswer } from '../../api/client';
import type {
  StepView,
  AnswerOutcome,
} from '../../api/types';
import { Button, ComicPanel, ProgressBar, Spinner, Badge } from '../../components/ui';
import s from './PreviewPlayer.module.css';

export default function PreviewPlayer() {
  const { previewSessionId: sessionId } = useParams<{ previewSessionId: string }>();
  const navigate = useNavigate();

  const { data: initialStep, loading, error: loadError } = useApi<StepView>(
    () => getSessionById(sessionId!),
    [sessionId],
  );

  const [currentStep, setCurrentStep] = useState<StepView | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>('in_progress');

  // Answer state
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeTextAnswer, setFreeTextAnswer] = useState('');
  const [answerResult, setAnswerResult] = useState<AnswerOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialStep) {
      setCurrentStep(initialStep);
    }
  }, [initialStep]);

  const handleNext = useCallback(async () => {
    if (!currentStep) return;
    setAdvancing(true);
    setError(null);
    setAnswerResult(null);
    setSelectedOption(null);
    setFreeTextAnswer('');
    try {
      const result = await previewNext(sessionId!, currentStep.state_version, currentStep.node_id);
      setCurrentStep(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setAdvancing(false);
    }
  }, [sessionId, currentStep]);

  const handleAnswer = useCallback(async () => {
    if (!currentStep) return;
    setSubmitting(true);
    setError(null);
    try {
      let answer: unknown;
      if (currentStep.node_kind === 'single_choice') {
        answer = { option_id: selectedOption };
      } else if (currentStep.node_kind === 'free_text') {
        answer = { text: freeTextAnswer };
      }

      const result = await previewAnswer(sessionId!, {
        node_id: currentStep.node_id,
        answer,
        state_version: currentStep.state_version,
      });

      setAnswerResult(result);

      if (result.next_action === 'lesson_completed' || result.next_action === 'completed') {
        setSessionStatus('completed');
      } else if (result.next_step) {
        // Don't advance yet -- show feedback first
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSubmitting(false);
    }
  }, [sessionId, currentStep, selectedOption, freeTextAnswer]);

  const handleContinueAfterFeedback = useCallback(() => {
    if (answerResult?.next_step) {
      setCurrentStep(answerResult.next_step);
      setAnswerResult(null);
      setSelectedOption(null);
      setFreeTextAnswer('');
    } else if (answerResult?.next_action === 'lesson_completed' || answerResult?.next_action === 'completed') {
      setSessionStatus('completed');
      setAnswerResult(null);
    } else {
      handleNext();
    }
  }, [answerResult, handleNext]);

  if (loading) return <Spinner />;
  if (loadError) return <div className={s.error}>{loadError}</div>;

  const isStory = currentStep?.node_kind === 'story';
  const isChoice = currentStep?.node_kind === 'single_choice';
  const isFreeText = currentStep?.node_kind === 'free_text';
  const progressPct = currentStep ? Math.round(currentStep.progress_ratio * 100) : 0;

  // Payload helpers
  const payload = currentStep?.payload ?? {};
  const storyText = payload.text as string | undefined;
  const storySpeaker = payload.speaker as string | undefined;
  const illustrationUrl = payload.illustration_url as string | undefined;
  const questionText = (payload.prompt ?? payload.question_text) as string | undefined;
  const options = payload.options as Array<{ id: string; text: string }> | undefined;

  return (
    <div className={s.page}>
      {/* Preview banner */}
      <div className={s.banner}>
        <div className={s.bannerLeft}>
          <span className={s.previewBadge}>Предпросмотр</span>
          <span className={s.bannerText}>Режим предпросмотра - данные не сохраняются</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          Вернуться в редактор
        </Button>
      </div>

      <div className={s.playerArea}>
        {/* Progress */}
        <div className={s.progressWrap}>
          <ProgressBar value={progressPct} height={12} showLabel />
        </div>

        {error && <div className={s.error}>{error}</div>}

        {/* Completed state */}
        {(sessionStatus === 'completed' || sessionStatus === 'lesson_completed') && !answerResult && (
          <ComicPanel>
            <div className={s.completedWrap}>
              <div className={s.completedTitle}>Миссия завершена!</div>
              <div className={s.completedSub}>
                Предпросмотр этапа завершён
              </div>
              <div className={s.actionBar}>
                <Button onClick={() => navigate(-1)}>
                  Вернуться в редактор
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {/* Active step */}
        {sessionStatus !== 'completed' && currentStep && !answerResult && (
          <ComicPanel>
            <div className={s.stepCard}>
              <Badge variant={isStory ? 'teal' : isChoice ? 'orange' : 'pink'}>
                {isStory ? 'История' : isChoice ? 'Вопрос' : 'Свободный ответ'}
              </Badge>

              {/* Story */}
              {isStory && (
                <>
                  {storySpeaker && (
                    <div className={s.speaker}>{storySpeaker}:</div>
                  )}
                  <div className={s.storyText}>{storyText}</div>
                  {illustrationUrl && (
                    <img
                      src={illustrationUrl}
                      alt="Иллюстрация"
                      className={s.storyIllustration}
                    />
                  )}
                  <div className={s.actionBar}>
                    <Button onClick={handleNext} disabled={advancing}>
                      {advancing ? 'Загрузка...' : 'Далее'}
                    </Button>
                  </div>
                </>
              )}

              {/* Single choice */}
              {isChoice && (
                <>
                  <div className={s.questionText}>{questionText}</div>
                  {illustrationUrl && (
                    <img src={illustrationUrl} alt="Иллюстрация" className={s.storyIllustration} />
                  )}
                  <div className={s.optionsList}>
                    {options?.map(opt => (
                      <button
                        key={opt.id}
                        className={`${s.optionBtn} ${selectedOption === opt.id ? s.selected : ''}`}
                        onClick={() => setSelectedOption(opt.id)}
                      >
                        {opt.text}
                      </button>
                    ))}
                  </div>
                  <div className={s.actionBar}>
                    <Button
                      onClick={handleAnswer}
                      disabled={submitting || !selectedOption}
                    >
                      {submitting ? 'Проверка...' : 'Ответить'}
                    </Button>
                  </div>
                </>
              )}

              {/* Free text */}
              {isFreeText && (
                <>
                  <div className={s.questionText}>{questionText}</div>
                  <textarea
                    className={s.freeTextInput}
                    value={freeTextAnswer}
                    onChange={e => setFreeTextAnswer(e.target.value)}
                    placeholder="Введите ваш ответ..."
                  />
                  <div className={s.actionBar}>
                    <Button
                      onClick={handleAnswer}
                      disabled={submitting || !freeTextAnswer.trim()}
                    >
                      {submitting ? 'Проверка...' : 'Ответить'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </ComicPanel>
        )}

        {/* Feedback after answer */}
        {answerResult && (
          <ComicPanel>
            <div className={s.stepCard}>
              <div
                className={`${s.feedback} ${
                  answerResult.verdict === 'correct'
                    ? s.feedbackCorrect
                    : answerResult.verdict === 'partial'
                    ? s.feedbackPartial
                    : s.feedbackIncorrect
                }`}
              >
                <div className={s.feedbackVerdict}>
                  {answerResult.verdict === 'correct'
                    ? 'Правильно!'
                    : answerResult.verdict === 'partial'
                    ? 'Частично верно'
                    : 'Неправильно'}
                </div>
                <div>{answerResult.feedback_text}</div>
              </div>
              <div style={{ fontSize: '0.9rem', color: 'var(--dark-light)' }}>
                XP: {answerResult.xp_delta > 0 ? '+' : ''}{answerResult.xp_delta}
              </div>
              <div className={s.actionBar}>
                <Button onClick={handleContinueAfterFeedback}>
                  {answerResult.next_action === 'lesson_completed' || answerResult.next_action === 'completed' ? 'Завершить' : 'Далее'}
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}
      </div>
    </div>
  );
}
