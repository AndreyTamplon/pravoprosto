import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getSession, setCsrfToken, logout as apiLogout, selectRole as apiSelectRole } from '../api/client';
import type { SessionInfo, Role } from '../api/types';

interface AuthState {
  loading: boolean;
  session: SessionInfo | null;
  error: string | null;
}

interface AuthContextType extends AuthState {
  refresh: () => Promise<void>;
  login: (provider?: string) => void;
  logout: () => Promise<void>;
  selectRole: (role: Role) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ loading: true, session: null, error: null });

  const refresh = useCallback(async () => {
    try {
      const session = await getSession();
      if (session.csrf_token) {
        setCsrfToken(session.csrf_token);
      }
      setState({ loading: false, session, error: null });
    } catch {
      setState({ loading: false, session: { authenticated: false, user: null, onboarding: { role_selection_required: false, teacher_profile_required: false } }, error: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback((provider = 'yandex') => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/api/v1/auth/sso/${provider}/start?return_to=${encodeURIComponent(returnTo)}`;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch { /* ignore */ }
    setState({ loading: false, session: { authenticated: false, user: null, onboarding: { role_selection_required: false, teacher_profile_required: false } }, error: null });
    setCsrfToken('');
  }, []);

  const selectRole = useCallback(async (role: Role) => {
    await apiSelectRole(role);
    await refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ ...state, refresh, login, logout, selectRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
