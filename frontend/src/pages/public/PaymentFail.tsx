import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ComicPanel, Button } from '../../components/ui';
import styles from './PaymentResult.module.css';

export default function PaymentFail() {
  const navigate = useNavigate();
  const { session } = useAuth();

  const goHome = () => {
    if (!session?.authenticated) {
      navigate('/');
      return;
    }
    switch (session.user?.role) {
      case 'parent': navigate('/parent'); break;
      case 'student': navigate('/student/courses'); break;
      default: navigate('/');
    }
  };

  return (
    <div className={styles.page}>
      <ComicPanel className={styles.card}>
        <span className={styles.icon}>😔</span>
        <h1 className={styles.title}>Оплата не прошла</h1>
        <p className={styles.desc}>
          Что-то пошло не так. Попробуйте ещё раз или обратитесь к администратору.
        </p>
        <Button variant="primary" onClick={goHome}>
          Вернуться
        </Button>
      </ComicPanel>
    </div>
  );
}
