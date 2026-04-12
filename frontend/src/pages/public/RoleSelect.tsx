import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ComicPanel, BrandLogo } from '../../components/ui';
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
  const { loading, session, selectRole } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selecting, setSelecting] = useState(false);
  const returnTo = searchParams.get('return_to');

  useEffect(() => {
    if (loading || selecting || !session?.authenticated || session.onboarding.role_selection_required) {
      return;
    }

    if (returnTo && session.user?.role === 'student') {
      navigate(returnTo, { replace: true });
      return;
    }

    switch (session.user?.role) {
      case 'student':
        navigate('/student/courses', { replace: true });
        return;
      case 'parent':
        navigate('/parent', { replace: true });
        return;
      case 'teacher':
        navigate('/teacher-onboarding', { replace: true });
        return;
      case 'admin':
        navigate('/admin', { replace: true });
        return;
      default:
        return;
    }
  }, [loading, navigate, returnTo, selecting, session]);

  const handleSelect = async (role: Role) => {
    setSelecting(true);
    try {
      await selectRole(role);
      const destination = REDIRECTS[role] ?? '/';
      if (returnTo && role === 'student') {
        navigate(`${destination}?return_to=${encodeURIComponent(returnTo)}`);
        return;
      }
      navigate(destination);
    } catch {
      setSelecting(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={`${styles.wrap} ${selecting ? styles.selecting : ''}`}>
        <BrandLogo size="md" className={styles.brand} />
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
