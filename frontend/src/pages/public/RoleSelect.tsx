import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ComicPanel } from '../../components/ui';
import type { Role } from '../../api/types';
import styles from './RoleSelect.module.css';

const ROLES: { role: Role; icon: string; label: string }[] = [
  { role: 'student', icon: '🎒', label: 'Ученик' },
  { role: 'parent', icon: '👨\u200D👩\u200D👧', label: 'Родитель' },
  { role: 'teacher', icon: '📚', label: 'Учитель' },
];

const REDIRECTS: Record<string, string> = {
  student: '/student-onboarding',
  parent: '/parent',
  teacher: '/teacher-onboarding',
};

export default function RoleSelect() {
  const { selectRole } = useAuth();
  const navigate = useNavigate();
  const [selecting, setSelecting] = useState(false);

  const handleSelect = async (role: Role) => {
    setSelecting(true);
    try {
      await selectRole(role);
      navigate(REDIRECTS[role] ?? '/');
    } catch {
      setSelecting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={`${styles.wrap} ${selecting ? styles.selecting : ''}`}>
        <h1 className={styles.title}>Кто вы?</h1>
        <p className={styles.sub}>Выберите свою роль, чтобы продолжить</p>

        <div className={styles.cards}>
          {ROLES.map((r) => (
            <ComicPanel
              key={r.role}
              hoverable
              className={styles.roleCard}
              onClick={() => handleSelect(r.role)}
            >
              <span className={styles.roleIcon}>{r.icon}</span>
              <div className={styles.roleName}>{r.label}</div>
            </ComicPanel>
          ))}
        </div>
      </div>
    </div>
  );
}
