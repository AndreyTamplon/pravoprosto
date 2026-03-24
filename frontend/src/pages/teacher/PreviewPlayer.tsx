import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { getPreviewSession, previewNext, previewAnswer } from '../../api/client';
import type { PreviewAnswerView, PreviewStepView } from '../../api/types';
import { Button, ComicPanel, ProgressBar, Spinner, Badge } from '../../components/ui';
import s from './PreviewPlayer.module.css';

export default function PreviewPlayer() {
  const { previewSessionId } = useParams<{ previewSessionId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const { data: initialSession, loading, error: loadError } = useApi(
    () => getPreviewSession(previewSessionId!),
    [previewSessionId],
  );

  const [currentStep, setCurrentStep] = useState<PreviewStepView | null>(null);
  const [completed, setCompleted] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [freeTextAnswer, setFreeTextAnswer] = useState('');
  const [answerResult, setAnswerResult] = useState<PreviewAnswerView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialSession) return;
    setCurrentStep(initialSession.step);
    setCompleted(false);
    setAnswerResult(null);
  }, [initialSession]);

  const handleReturnToEditor = useCallback(() => {
    const returnPath = initialSession?.return_path ?? searchParams.get('return_to') ?? undefined;
    if (returnPath) {
      navigate(returnPath);
      return;
    }
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(location.pathname.startsWith('/admin/') ? '/admin' : '/teacher');
  }, [initialSession?.return_path, location.pathname, navigate, searchParams]);

  const resetTransientState = useCallback(() => {
    setAnswerResult(null);
    setSelectedOption(null);
    setFreeTextAnswer('');
  }, []);

  const handleNext = useCallback(async () => {
    if (!currentStep) return;
    if (currentStep.node_kind === 'end') {
      setCompleted(true);
      return;
    }

    setAdvancing(true);
    setError(null);
    resetTransientState();
    try {
      const session = await previewNext(previewSessionId!, currentStep.state_version, currentStep.node_id);
      setCurrentStep(session.step);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setAdvancing(false);
    }
  }, [currentStep, previewSessionId, resetTransientState]);

  const handleAnswer = useCallback(async () => {
    if (!currentStep) return;
    setSubmitting(true);
    setError(null);
    try {
      const answer =
        currentStep.node_kind === 'single_choice'
          ? { option_id: selectedOption }
          : { text: freeTextAnswer };

      const result = await previewAnswer(previewSessionId!, {
        node_id: currentStep.node_id,
        answer,
        state_version: currentStep.state_version,
      });
      setAnswerResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка отправки');
    } finally {
      setSubmitting(false);
    }
  }, [currentStep, freeTextAnswer, previewSessionId, selectedOption]);

  const handleContinueAfterFeedback = useCallback(() => {
    if (answerResult?.next_step) {
      setCurrentStep(answerResult.next_step);
      resetTransientState();
      return;
    }
    setCompleted(true);
    resetTransientState();
  }, [answerResult, resetTransientState]);

  if (loading) return <Spinner />;
  if (loadError) return <div className={s.error}>{loadError}</div>;

  const isStory = currentStep?.node_kind === 'story';
  const isChoice = currentStep?.node_kind === 'single_choice';
  const isFreeText = currentStep?.node_kind === 'free_text';
  const isEnd = currentStep?.node_kind === 'end';
  const progressPct = completed ? 100 : currentStep ? Math.round(currentStep.progress_ratio * 100) : 0;

  const payload = currentStep?.payload ?? {};
  const storyText = (payload.text as string) ?? '';
  const illustrationUrl = (payload.asset_url as string | undefined) ?? undefined;
  const questionText = (payload.prompt ?? payload.question_text) as string | undefined;
  const options = payload.options as Array<{ id: string; text: string }> | undefined;

  return (
    <div className={s.page}>
      <div className={s.banner}>
        <div className={s.bannerLeft}>
          <span className={s.previewBadge}>Предпросмотр</span>
          <span className={s.bannerText}>Режим предпросмотра - данные не сохраняются</span>
        </div>
        <Button variant="outline" size="sm" onClick={handleReturnToEditor}>
          Вернуться в редактор
        </Button>
      </div>

      <div className={s.playerArea}>
        <div className={s.progressWrap}>
          <ProgressBar value={progressPct} height={12} showLabel />
        </div>

        {error && <div className={s.error}>{error}</div>}

        {completed && !answerResult && (
          <ComicPanel>
            <div className={s.completedWrap} data-role="preview-complete">
              <div className={s.completedTitle}>Миссия завершена!</div>
              <div className={s.completedSub}>Предпросмотр этапа завершён</div>
              <div className={s.actionBar}>
                <Button onClick={handleReturnToEditor}>Вернуться в редактор</Button>
              </div>
            </div>
          </ComicPanel>
        )}

        {!completed && currentStep && !answerResult && (
          <ComicPanel>
            <div className={s.stepCard} data-node-kind={currentStep.node_kind} data-role="current-node">
              <Badge variant={isStory ? 'teal' : isChoice ? 'orange' : isEnd ? 'lime' : 'pink'}>
                {isStory ? 'История' : isChoice ? 'Вопрос' : isEnd ? 'Конец этапа' : 'Свободный ответ'}
              </Badge>

              {isStory && (
                <>
                  <div className={s.storyText} data-role="prompt">{storyText}</div>
                  {illustrationUrl && (
                    <img src={illustrationUrl} alt="Иллюстрация" className={s.storyIllustration} />
                  )}
                  <div className={s.actionBar}>
                    <Button onClick={handleNext} disabled={advancing}>
                      {advancing ? 'Загрузка...' : 'Далее'}
                    </Button>
                  </div>
                </>
              )}

              {isChoice && (
                <>
                  <div className={s.questionText} data-role="prompt">{questionText}</div>
                  <div className={s.optionsList}>
                    {options?.map(option => (
                      <button
                        key={option.id}
                        data-role="option"
                        data-option-id={option.id}
                        className={`${s.optionBtn} ${selectedOption === option.id ? s.selected : ''}`}
                        onClick={() => setSelectedOption(option.id)}
                        type="button"
                      >
                        {option.text}
                      </button>
                    ))}
                  </div>
                  <div className={s.actionBar}>
                    <Button onClick={handleAnswer} disabled={submitting || !selectedOption}>
                      {submitting ? 'Проверка...' : 'Ответить'}
                    </Button>
                  </div>
                </>
              )}

              {isFreeText && (
                <>
                  <div className={s.questionText} data-role="prompt">{questionText}</div>
                  <textarea
                    className={s.freeTextInput}
                    value={freeTextAnswer}
                    onChange={event => setFreeTextAnswer(event.target.value)}
                    placeholder="Введите ваш ответ..."
                  />
                  <div className={s.actionBar}>
                    <Button onClick={handleAnswer} disabled={submitting || !freeTextAnswer.trim()}>
                      {submitting ? 'Проверка...' : 'Ответить'}
                    </Button>
                  </div>
                </>
              )}

              {isEnd && (
                <>
                  <div className={s.storyText} data-role="prompt">{storyText || 'Конец этапа'}</div>
                  <div className={s.actionBar}>
                    <Button onClick={handleNext}>Завершить предпросмотр</Button>
                  </div>
                </>
              )}
            </div>
          </ComicPanel>
        )}

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
                data-role="feedback"
                data-verdict={answerResult.verdict}
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
              <div className={s.actionBar}>
                <Button onClick={handleContinueAfterFeedback}>
                  {answerResult.next_step ? 'Далее' : 'Завершить предпросмотр'}
                </Button>
              </div>
            </div>
          </ComicPanel>
        )}
      </div>
    </div>
  );
}
