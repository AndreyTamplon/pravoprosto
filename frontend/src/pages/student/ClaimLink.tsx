import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { claimCourseLink, claimGuardianLink } from '../../api/client';
import { Button, ComicPanel, Spinner } from '../../components/ui';
import styles from './ClaimLink.module.css';

type ClaimState = 'loading' | 'success' | 'error';

export default function ClaimLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const token = searchParams.get('token') ?? '';
  const isGuardian = location.pathname.includes('guardian');

  const [state, setState] = useState<ClaimState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorMsg('Ссылка недействительна: отсутствует токен');
      return;
    }

    const claim = async () => {
      try {
        if (isGuardian) {
          await claimGuardianLink(token);
        } else {
          await claimCourseLink(token);
        }
        setState('success');
      } catch (err) {
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Не удалось активировать ссылку');
      }
    };

    claim();
  }, [token, isGuardian]);

  const handleContinue = () => {
    if (isGuardian) {
      navigate('/student/profile');
    } else {
      navigate('/student/courses');
    }
  };

  return (
    <div className={styles.page}>
      <ComicPanel className={styles.card}>
        {state === 'loading' && (
          <>
            <Spinner />
            <div style={{ marginTop: 16, fontWeight: 600, color: 'var(--dark-light)' }}>
              Активируем ссылку...
            </div>
          </>
        )}

        {state === 'success' && (
          <>
            <span className={styles.icon}>✅</span>
            <h1 className={styles.title}>Готово!</h1>
            <p className={`${styles.desc} ${styles.success}`}>
              {isGuardian
                ? 'Связь с родителем установлена'
                : 'Курс успешно добавлен'}
            </p>
            <Button variant="primary" onClick={handleContinue}>
              Продолжить
            </Button>
          </>
        )}

        {state === 'error' && (
          <>
            <span className={styles.icon}>❌</span>
            <h1 className={styles.title}>Ошибка</h1>
            <p className={`${styles.desc} ${styles.error}`}>{errorMsg}</p>
            <Button variant="outline" onClick={() => navigate('/')}>
              На главную
            </Button>
          </>
        )}
      </ComicPanel>
    </div>
  );
}
