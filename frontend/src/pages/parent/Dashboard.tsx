import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  getChildren,
  createLinkInvite,
  getLinkInvites,
  revokeLinkInvite,
} from '../../api/client';
import type { LinkedChild, LinkInvite } from '../../api/types';
import { Button, ComicPanel, Badge, Spinner, Modal, EmptyState } from '../../components/ui';
import { timeAgo, formatDate } from '../../utils/format';
import s from './Dashboard.module.css';

export default function Dashboard() {
  const navigate = useNavigate();
  const { data: children, loading: loadingChildren, error: childrenError } = useApi<LinkedChild[]>(getChildren);
  const { data: invites, loading: loadingInvites, reload: reloadInvites } = useApi<LinkInvite[]>(getLinkInvites);

  const [modalOpen, setModalOpen] = useState(false);
  const [newInvite, setNewInvite] = useState<LinkInvite | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const invite = await createLinkInvite();
      setNewInvite(invite);
      reloadInvites();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка создания приглашения');
    } finally {
      setCreating(false);
    }
  }, [reloadInvites]);

  const handleCopy = useCallback(async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleRevoke = useCallback(async (inviteId: string) => {
    setRevoking(inviteId);
    try {
      await revokeLinkInvite(inviteId);
      reloadInvites();
    } catch { /* ignore */ }
    setRevoking(null);
  }, [reloadInvites]);

  const openModal = () => {
    setModalOpen(true);
    setNewInvite(null);
    setCopied(false);
    setError(null);
  };

  if (loadingChildren) return <Spinner text="Загрузка..." />;
  if (childrenError) return <div className={s.error}>{childrenError}</div>;

  const activeInvites = invites?.filter(i => i.status === 'active') ?? [];
  const initial = (name: string) => name.charAt(0).toUpperCase();

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Мои дети</h1>
        <Button onClick={openModal}>+ Добавить ребёнка</Button>
      </div>

      {children && children.length > 0 ? (
        <div className={s.grid}>
          {children.map(child => (
            <ComicPanel
              key={child.student_id}
              clickable
              onClick={() => navigate(`/parent/children/${child.student_id}`)}
            >
              <div className={s.childCard}>
                <div className={s.childTop}>
                  <div className={s.avatar}>
                    {child.avatar_url ? (
                      <img src={child.avatar_url} alt="" />
                    ) : (
                      initial(child.display_name)
                    )}
                  </div>
                  <span className={s.childName}>{child.display_name}</span>
                </div>
                <div className={s.childStats}>
                  <span className={s.stat}>
                    <span className={s.statIcon}>*</span> {child.xp_total} XP
                  </span>
                  <span className={s.stat}>
                    <span className={s.statIcon}>~</span> {child.current_streak_days} дн
                  </span>
                </div>
                <div className={s.childCourses}>
                  Миссий: {child.courses_in_progress} в процессе, {child.courses_completed} завершено
                </div>
                {child.last_activity_at && (
                  <div className={s.childCourses}>
                    Последняя активность: {timeAgo(child.last_activity_at)}
                  </div>
                )}
              </div>
            </ComicPanel>
          ))}
        </div>
      ) : (
        <ComicPanel>
          <EmptyState
            icon="👨‍👧‍👦"
            title="Пока нет привязанных детей"
            description="Создайте приглашение и отправьте ссылку ребёнку"
          >
            <Button onClick={openModal} style={{ marginTop: 8 }}>+ Добавить ребёнка</Button>
          </EmptyState>
        </ComicPanel>
      )}

      {activeInvites.length > 0 && (
        <div className={s.section}>
          <h2 className={s.sectionTitle}>Активные приглашения</h2>
          {loadingInvites ? (
            <Spinner text="Загрузка..." />
          ) : (
            <div className={s.inviteList}>
              {activeInvites.map(inv => (
                <div key={inv.invite_id} className={s.inviteRow}>
                  <div className={s.inviteInfo}>
                    <Badge color="teal">Активно</Badge>
                    <span className={s.inviteUrl}>
                      {inv.invite_url ?? 'Ссылка недоступна для старого приглашения'}
                    </span>
                    <span>до {formatDate(inv.expires_at)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {inv.invite_url ? (
                      <Button size="sm" variant="outline" onClick={() => handleCopy(inv.invite_url!)}>
                        Копировать
                      </Button>
                    ) : (
                      <Badge color="gray">Создайте новое приглашение</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRevoke(inv.invite_id)}
                      disabled={revoking === inv.invite_id}
                    >
                      {revoking === inv.invite_id ? '...' : 'Отозвать'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Добавить ребёнка">
        <div className={s.modalContent}>
          {!newInvite ? (
            <>
              <p>Создайте ссылку-приглашение и отправьте её ребёнку. Когда ребёнок перейдёт по ссылке, ваши аккаунты будут связаны.</p>
              {error && <div className={s.error}>{error}</div>}
              <Button onClick={handleCreate} disabled={creating} full>
                {creating ? 'Создание...' : 'Создать приглашение'}
              </Button>
            </>
          ) : (
            <>
              <p>Ссылка создана! Скопируйте и отправьте ребёнку:</p>
              <div className={s.inviteLinkBox}>
                <span className={s.inviteLinkText}>{newInvite.invite_url}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button onClick={() => handleCopy(newInvite.invite_url!)}>
                  Копировать ссылку
                </Button>
                {copied && <span className={s.copied}>Скопировано!</span>}
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--dark-light)' }}>
                Действительна до {formatDate(newInvite.expires_at)}
              </p>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
