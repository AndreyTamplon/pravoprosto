import { useState, useEffect } from 'react';
import { useApi } from '../../hooks/useApi';
import { getAdminProfile, updateAdminProfile } from '../../api/client';
import { Button, Spinner, Input } from '../../components/ui';
import type { AdminProfile as AdminProfileType } from '../../api/types';
import styles from './AdminProfile.module.css';

export default function AdminProfile() {
  const { data, loading, error } = useApi<AdminProfileType>(() => getAdminProfile(), []);
  const [name, setName] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (data && !initialized) {
      setName(data.display_name);
      setInitialized(true);
    }
  }, [data, initialized]);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setSaveError('');
    setSaveMsg('');
    try {
      await updateAdminProfile({ display_name: name.trim() });
      setSaveMsg('Сохранено!');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <div className={styles.page}><div className={styles.error}>{error}</div></div>;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Профиль</h1>

      <div className={styles.card}>
        <div className={styles.avatar}>
          {data?.avatar_url
            ? <img src={data.avatar_url} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
            : '👤'
          }
        </div>

        <Input
          label="Отображаемое имя"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Ваше имя"
        />

        {saveMsg && <div className={styles.saveNotice}>{saveMsg}</div>}
        {saveError && <div className={styles.error}>{saveError}</div>}

        <div className={styles.actions}>
          <Button onClick={handleSave} loading={saving} disabled={!name.trim()}>
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  );
}
