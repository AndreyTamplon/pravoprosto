import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { ApiRequestError, claimCourseLink, claimGuardianLink } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button, ComicPanel, Spinner } from '../../components/ui';
import styles from './ClaimLink.module.css';

type ClaimState = 'loading' | 'success' | 'error';

export default function ClaimLink() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { loading, session } = useAuth();

  // Backend generates URLs with hash fragment: /claim/course-link#token=...
  // Hash fragments aren't in searchParams, so check both
  const hashToken = location.hash.startsWith('#token=') ? location.hash.slice(7) : '';
  const token = searchParams.get('token') || hashToken;
  const isGuardian = location.pathname.includes('guardian');

  const [state, setState] = useState<ClaimState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const claimedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (loading || !session?.authenticated) {
      return;
    }

    if (session.onboarding.role_selection_required) {
      navigate(`/role-select?return_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`, {
        replace: true,
      });
      return;
    }

    if (session.user?.role !== 'student') {
      setState('error');
      setErrorMsg('Ссылку может активировать только ученик.');
      return;
    }

    if (!token) {
      setState('error');
      setErrorMsg('Ссылка недействительна: отсутствует токен');
      return;
    }

    const claimKey = `${isGuardian ? 'guardian' : 'course'}:${token}`;
    if (claimedKeyRef.current === claimKey) {
      return;
    }
    claimedKeyRef.current = claimKey;

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
        if (err instanceof ApiRequestError && err.status === 403) {
          setErrorMsg('Ссылку может активировать только ученик.');
          return;
        }
        setErrorMsg(err instanceof Error ? err.message : 'Не удалось активировать ссылку');
      }
    };

    claim();
  }, [isGuardian, loading, location.hash, location.pathname, location.search, navigate, session, token]);

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
