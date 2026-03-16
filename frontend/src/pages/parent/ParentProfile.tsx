import { useState, useEffect } from 'react';
import { useApi } from '../../hooks/useApi';
import { getParentProfile, updateParentProfile } from '../../api/client';
import type { ParentProfile as ParentProfileType } from '../../api/types';
import { Button, ComicPanel, Input, Spinner } from '../../components/ui';
import s from './ParentProfile.module.css';

export default function ParentProfile() {
  const { data, loading, error: loadError } = useApi<ParentProfileType>(getParentProfile);

  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setDisplayName(data.display_name);
    }
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateParentProfile({ display_name: displayName });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner text="Загрузка профиля..." />;
  if (loadError) return <div className={s.error}>{loadError}</div>;

  const initial = displayName ? displayName.charAt(0).toUpperCase() : '?';

  return (
    <div className={s.page}>
      <h1 className={s.title}>Досье героя</h1>

      <ComicPanel>
        <div className={s.avatar}>{initial}</div>
        <div className={s.form}>
          <Input
            label="Отображаемое имя"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Ваше имя"
          />

          {error && <div className={s.error}>{error}</div>}

          <div className={s.actions}>
            <Button onClick={handleSave} disabled={saving || !displayName.trim()}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </Button>
            {saved && <span className={s.saved}>Сохранено!</span>}
          </div>
        </div>
      </ComicPanel>
    </div>
  );
}
