import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

const JWT_STORE_KEY = 'qurovita_jwt';

export type AuthStatus = 'loading' | 'unauthenticated' | 'kyc_pending' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  jwt: string | null;
  userId: string | null;
}

interface AuthContextValue extends AuthState {
  signIn: (token: string, kycVerified: boolean) => Promise<void>;
  signOut: () => Promise<void>;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    // atob is available in React Native 0.64+
    const json = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Check JWT expiry locally from the exp claim — do not wait for a 401 response.
// This prevents the user from getting half-way into a flow before being kicked out.
function jwtIsExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return Date.now() >= payload.exp * 1000;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    jwt: null,
    userId: null,
  });

  useEffect(() => {
    void (async () => {
      try {
        const token = await SecureStore.getItemAsync(JWT_STORE_KEY);
        if (!token || jwtIsExpired(token)) {
          if (token) await SecureStore.deleteItemAsync(JWT_STORE_KEY).catch(() => undefined);
          setState({ status: 'unauthenticated', jwt: null, userId: null });
          return;
        }
        const payload = decodeJwtPayload(token);
        const userId = typeof payload?.sub === 'string' ? payload.sub : null;
        // kyc_status is not encoded in the JWT — treating valid JWT as authenticated.
        // T5.1 (Smile ID) will add a server-side check here.
        setState({ status: 'authenticated', jwt: token, userId });
      } catch {
        // SecureStore unavailable (e.g. native module not yet initialised on first cold start)
        setState({ status: 'unauthenticated', jwt: null, userId: null });
      }
    })();
  }, []);

  const signIn = async (token: string, kycVerified: boolean): Promise<void> => {
    await SecureStore.setItemAsync(JWT_STORE_KEY, token);
    const payload = decodeJwtPayload(token);
    const userId = typeof payload?.sub === 'string' ? payload.sub : null;
    setState({
      status: kycVerified ? 'authenticated' : 'kyc_pending',
      jwt: token,
      userId,
    });
  };

  const signOut = async (): Promise<void> => {
    await SecureStore.deleteItemAsync(JWT_STORE_KEY);
    setState({ status: 'unauthenticated', jwt: null, userId: null });
  };

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}
