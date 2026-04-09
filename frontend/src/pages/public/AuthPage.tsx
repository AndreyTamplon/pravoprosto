import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ComicPanel, BrandLogo } from '../../components/ui';
import styles from './AuthPage.module.css';

export default function AuthPage() {
  const { login } = useAuth();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('return_to') ?? undefined;

  return (
    <div className={styles.page}>
      <ComicPanel className={styles.card}>
        <BrandLogo size="md" className={styles.logo} />
        <p className={styles.sub}>
          Войдите, чтобы продолжить обучение в SmartGo School
        </p>

        <button
          type="button"
          className={styles.yandexBtn}
          onClick={() => login('yandex', returnTo)}
        >
          Войти через Яндекс
        </button>

        <p className={styles.hint}>
          Нет аккаунта? Он создастся автоматически при первом входе
        </p>
      </ComicPanel>
    </div>
  );
}
