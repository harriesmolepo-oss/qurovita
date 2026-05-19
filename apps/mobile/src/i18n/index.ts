import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as SecureStore from 'expo-secure-store';

import en from './en.json';
import zu from './zu.json';
import st from './st.json';

export const SUPPORTED_LANGUAGES = ['en', 'zu', 'st'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANG_STORE_KEY = 'qurovita_language';

// Initialise synchronously with English default.
// loadPersistedLanguage() should be called once at app startup (_layout.tsx)
// to switch to the user's stored preference before first render.
i18n.use(initReactI18next).init({
  compatibilityJSON: 'v4',
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: { translation: en },
    zu: { translation: zu },
    st: { translation: st },
  },
  interpolation: { escapeValue: false },
});

export async function loadPersistedLanguage(): Promise<void> {
  const stored = await SecureStore.getItemAsync(LANG_STORE_KEY);
  if (stored && (SUPPORTED_LANGUAGES as readonly string[]).includes(stored)) {
    await i18n.changeLanguage(stored);
  }
}

export async function setLanguage(lang: SupportedLanguage): Promise<void> {
  await SecureStore.setItemAsync(LANG_STORE_KEY, lang);
  await i18n.changeLanguage(lang);
}

export default i18n;
