import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionDto, UserDto } from '@voxstudio/contracts';
import { api, setCsrfToken } from '../api/client';

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  workspaceId: string;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  const accept = (s: SessionDto) => {
    setCsrfToken(s.csrfToken);
    setUser(s.user);
  };

  const reload = useCallback(async () => {
    try {
      const s = await api<SessionDto | null>('/auth/session');
      if (s) accept(s);
      else setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch(() => setLoading(false));
  }, [reload]);

  // Rotate the session periodically while the app is open.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(
      () =>
        void api<SessionDto>('/auth/refresh', { method: 'POST' })
          .then(accept)
          .catch(() => undefined),
      6 * 3600_000,
    );
    return () => clearInterval(t);
  }, [user]);

  const value: AuthState = {
    user,
    loading,
    workspaceId: user?.workspaces[0]?.id ?? '',
    signIn: async (email, password) =>
      accept(await api<SessionDto>('/auth/login', { method: 'POST', body: { email, password } })),
    register: async (email, password, displayName) =>
      accept(
        await api<SessionDto>('/auth/register', { method: 'POST', body: { email, password, displayName } }),
      ),
    signOut: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      setUser(null);
    },
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
