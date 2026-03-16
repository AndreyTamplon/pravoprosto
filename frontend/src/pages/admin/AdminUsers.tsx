import { useState, useMemo, useCallback } from 'react';
import { useApi } from '../../hooks/useApi';
import { getAdminUsers, blockUser, unblockUser } from '../../api/client';
import { Button, Badge, Spinner, Modal, EmptyState } from '../../components/ui';
import { formatDate, timeAgo } from '../../utils/format';
import type { AdminUser, Role } from '../../api/types';
import styles from './AdminUsers.module.css';

type TabFilter = 'all' | 'student' | 'parent' | 'teacher' | 'admin';

const TAB_LABELS: Record<TabFilter, string> = {
  all: 'Все',
  student: 'Ученики',
  parent: 'Родители',
  teacher: 'Учителя',
  admin: 'Админы',
};

const ROLE_COLORS: Record<string, 'teal' | 'blue' | 'orange' | 'pink' | 'gray'> = {
  student: 'teal',
  parent: 'blue',
  teacher: 'orange',
  admin: 'pink',
  unselected: 'gray',
};

export default function AdminUsers() {
  const { data, loading, error, reload } = useApi<AdminUser[]>(() => getAdminUsers(), []);
  const [tab, setTab] = useState<TabFilter>('all');
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const filtered = useMemo(() => {
    if (!data) return [];
    if (tab === 'all') return data;
    return data.filter(u => u.role === tab);
  }, [data, tab]);

  const handleBlock = useCallback(async (user: AdminUser) => {
    setActionLoading(true);
    setActionError('');
    try {
      await blockUser(user.account_id);
      setSelectedUser(prev => prev ? { ...prev, status: 'blocked' } : null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(false);
    }
  }, [reload]);

  const handleUnblock = useCallback(async (user: AdminUser) => {
    setActionLoading(true);
    setActionError('');
    try {
      await unblockUser(user.account_id);
      setSelectedUser(prev => prev ? { ...prev, status: 'active' } : null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(false);
    }
  }, [reload]);

  function roleBadge(role: Role) {
    return <Badge color={ROLE_COLORS[role] ?? 'gray'}>{role}</Badge>;
  }

  function statusBadge(status: string) {
    return status === 'active'
      ? <Badge color="lime">Активен</Badge>
      : <Badge color="red">Заблокирован</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Пользователи</h1>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.tabs}>
        {(Object.keys(TAB_LABELS) as TabFilter[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
            {data && t !== 'all' && ` (${data.filter(u => u.role === t).length})`}
            {data && t === 'all' && ` (${data.length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="👥" title="Нет пользователей" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Имя</th>
              <th>Роль</th>
              <th>Статус</th>
              <th>Email</th>
              <th>Регистрация</th>
              <th>Последняя активность</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.account_id} onClick={() => setSelectedUser(u)}>
                <td className={styles.userName}>{u.display_name}</td>
                <td>{roleBadge(u.role)}</td>
                <td>{statusBadge(u.status)}</td>
                <td>{u.email ?? '---'}</td>
                <td>{formatDate(u.created_at)}</td>
                <td>{u.last_activity_at ? timeAgo(u.last_activity_at) : '---'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={selectedUser !== null}
        onClose={() => { setSelectedUser(null); setActionError(''); }}
        title="Пользователь"
      >
        {selectedUser && (
          <div>
            <div className={styles.detailGrid}>
              <div className={styles.detailLabel}>Имя</div>
              <div className={styles.detailValue}>{selectedUser.display_name}</div>

              <div className={styles.detailLabel}>ID</div>
              <div className={styles.detailValue}>{selectedUser.account_id}</div>

              <div className={styles.detailLabel}>Роль</div>
              <div className={styles.detailValue}>{roleBadge(selectedUser.role)}</div>

              <div className={styles.detailLabel}>Статус</div>
              <div className={styles.detailValue}>{statusBadge(selectedUser.status)}</div>

              <div className={styles.detailLabel}>Email</div>
              <div className={styles.detailValue}>{selectedUser.email ?? '---'}</div>

              <div className={styles.detailLabel}>Регистрация</div>
              <div className={styles.detailValue}>{formatDate(selectedUser.created_at)}</div>

              <div className={styles.detailLabel}>Последняя активность</div>
              <div className={styles.detailValue}>
                {selectedUser.last_activity_at ? timeAgo(selectedUser.last_activity_at) : '---'}
              </div>

              {selectedUser.xp_total !== undefined && (
                <>
                  <div className={styles.detailLabel}>XP</div>
                  <div className={styles.detailValue}>{selectedUser.xp_total}</div>
                </>
              )}
            </div>

            {actionError && <div className={styles.error}>{actionError}</div>}

            <div className={styles.detailActions}>
              {selectedUser.status === 'active' ? (
                <Button
                  variant="danger"
                  onClick={() => handleBlock(selectedUser)}
                  loading={actionLoading}
                >
                  Заблокировать
                </Button>
              ) : (
                <Button
                  variant="success"
                  onClick={() => handleUnblock(selectedUser)}
                  loading={actionLoading}
                >
                  Разблокировать
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
