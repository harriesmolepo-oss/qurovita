import '../src/i18n'; // initialise i18next before any component renders
import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { AuthProvider, useAuthContext } from '../src/auth/AuthContext';
import { loadPersistedLanguage } from '../src/i18n';

function AuthGuard() {
  const { status } = useAuthContext();
  const segments = useSegments();
  const router = useRouter();

  // Load the user's persisted language preference on first mount
  useEffect(() => {
    void loadPersistedLanguage();
  }, []);

  useEffect(() => {
    if (status === 'loading') return;

    // Cast to string[] — expo-router types segments as a typed tuple based on
    // the static route tree, but we need runtime index access.
    const segs = segments as string[];
    const inAuth = segs[0] === '(auth)';
    const inHome = segs[0] === '(home)';

    if (status === 'unauthenticated' && !inAuth) {
      router.replace('/(auth)/sign-up');
    } else if (status === 'kyc_pending' && segs[1] !== 'kyc') {
      router.replace('/(auth)/kyc');
    } else if (status === 'authenticated' && inAuth) {
      router.replace('/(home)/');
    } else if (status === 'authenticated' && !inHome) {
      router.replace('/(home)/');
    }
  }, [status, segments, router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(home)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthGuard />
    </AuthProvider>
  );
}
