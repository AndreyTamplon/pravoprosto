import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { updateTeacherProfile } from '../../api/client';
import { Button, ComicPanel, Input } from '../../components/ui';
import styles from './TeacherOnboarding.module.css';

export default function TeacherOnboarding() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSaving(true);
    setError('');
    try {
      await updateTeacherProfile({
        display_name: displayName.trim(),
        organization_name: orgName.trim() || undefined,
      });
      navigate('/teacher');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <ComicPanel className={styles.card}>
        <span className={styles.icon}>📚</span>
        <h1 className={styles.title}>Добро пожаловать!</h1>
        <p className={styles.sub}>
          Расскажите немного о себе, чтобы начать создавать миссии для учеников
        </p>

        <form className={styles.form} onSubmit={handleSubmit}>
          <Input
            label="Как вас зовут"
            placeholder="Иван Петрович"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
          <Input
            label="Организация (необязательно)"
            placeholder="Школа №42"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />

          {error && <p className={styles.error}>{error}</p>}

          <Button
            variant="primary"
            type="submit"
            fullWidth
            disabled={saving || !displayName.trim()}
          >
            {saving ? 'Сохраняем...' : 'Продолжить'}
          </Button>
        </form>
      </ComicPanel>
    </div>
  );
}
