import { useAuth } from '../../contexts/AuthContext';
import { ComicPanel } from '../../components/ui';
import styles from './AuthPage.module.css';

export default function AuthPage() {
  const { login } = useAuth();

  return (
    <div className={styles.page}>
      <ComicPanel className={styles.card}>
        <span className={styles.mascot}>🛡️🤖</span>
        <div className={styles.logo}>Право Просто</div>
        <p className={styles.sub}>
          Войди, чтобы начать свои миссии по правовой грамотности
        </p>

        <button
          type="button"
          className={styles.yandexBtn}
          onClick={() => login('yandex')}
        >
          Войти через Яндекс
        </button>

        <p className={styles.hint}>
          Нет аккаунта? Войдите — он создастся автоматически
        </p>
      </ComicPanel>
    </div>
  );
}
