import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { stopImpersonation } from '../../api/client';

export function ImpersonationBanner() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);

  if (!session?.impersonated) return null;

  async function handleStop() {
    setLoading(true);
    try {
      const result = await stopImpersonation();
      window.location.href = result.redirect_url;
    } catch {
      setLoading(false);
    }
  }

  return (
    <div style={{
      background: '#FEF3C7',
      borderBottom: '2px solid #F59E0B',
      padding: '8px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: '0.88rem',
      fontWeight: 600,
      zIndex: 100,
    }}>
      <span>
        Вы вошли как <b>{session.user?.role === 'student' ? 'ученик' : session.user?.role === 'parent' ? 'родитель' : 'учитель'}</b> (режим имперсонации)
      </span>
      <button
        onClick={handleStop}
        disabled={loading}
        style={{
          background: '#F59E0B',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          padding: '6px 14px',
          fontWeight: 700,
          fontSize: '0.82rem',
          cursor: loading ? 'wait' : 'pointer',
          fontFamily: 'var(--font-family)',
        }}
      >
        {loading ? 'Возврат…' : 'Вернуться к админке'}
      </button>
    </div>
  );
}
