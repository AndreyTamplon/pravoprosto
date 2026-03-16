import { Outlet } from 'react-router-dom';
import styles from './LessonLayout.module.css';

export default function LessonLayout() {
  return (
    <div className={styles.layout}>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
