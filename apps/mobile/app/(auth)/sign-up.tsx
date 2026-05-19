import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../src/auth/useAuth';
import {
  setLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from '../../src/i18n';
import {
  POPIA_CONSENT_TEXT,
  POPIA_CONSENT_SHA256,
  POPIA_CONSENT_VERSION,
} from '../../src/popia/consentText';

type Step = 'language' | 'consent' | 'otp';

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  zu: 'isiZulu',
  st: 'Sesotho',
};

// Validates a South African mobile number: +27xxxxxxxxx or 0xxxxxxxxx (9 digits after prefix)
const SA_PHONE_RE = /^(\+27|0)[6-8][0-9]{8}$/;

export default function SignUpScreen() {
  const { t } = useTranslation();
  const { requestOtp, verifyOtp } = useAuth();

  const [step, setStep] = useState<Step>('language');
  const [language, setSelectedLanguage] = useState<SupportedLanguage>('en');
  const [consentChecked, setConsentChecked] = useState(false);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLanguageSelect = async (lang: SupportedLanguage) => {
    setSelectedLanguage(lang);
    await setLanguage(lang);
    setStep('consent');
  };

  const handleConsentContinue = () => {
    if (!consentChecked) return;
    setStep('otp');
  };

  const handleSendOtp = async () => {
    setError(null);
    const trimmed = phone.trim();
    if (!SA_PHONE_RE.test(trimmed)) {
      setError(t('auth.invalidPhone'));
      return;
    }
    setLoading(true);
    try {
      await requestOtp(trimmed);
      setOtpSent(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(msg || t('auth.errorNetwork'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    setError(null);
    if (!/^\d{6}$/.test(otp.trim())) {
      setError(t('auth.invalidOtp'));
      return;
    }
    setLoading(true);
    try {
      await verifyOtp(
        phone.trim(),
        otp.trim(),
        POPIA_CONSENT_SHA256,
        POPIA_CONSENT_VERSION,
        language,
      );
      // Navigation is handled by the AuthGuard in _layout.tsx
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(msg || t('auth.errorUnknown'));
    } finally {
      setLoading(false);
    }
  };

  if (step === 'language') {
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>{t('auth.selectLanguage')}</Text>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <TouchableOpacity
            key={lang}
            style={styles.langButton}
            onPress={() => void handleLanguageSelect(lang)}
            accessibilityRole="button"
          >
            <Text style={styles.langButtonText}>{LANGUAGE_LABELS[lang]}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }

  if (step === 'consent') {
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>{t('auth.privacyTitle')}</Text>
        <ScrollView style={styles.consentScroll}>
          <Text style={styles.consentText}>{POPIA_CONSENT_TEXT}</Text>
        </ScrollView>
        <TouchableOpacity
          style={styles.checkRow}
          onPress={() => setConsentChecked((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: consentChecked }}
        >
          <View style={[styles.checkbox, consentChecked && styles.checkboxChecked]} />
          <Text style={styles.checkLabel}>{t('auth.privacyAgree')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryButton, !consentChecked && styles.buttonDisabled]}
          onPress={handleConsentContinue}
          disabled={!consentChecked}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>{t('auth.continue')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setStep('language')} style={styles.backButton}>
          <Text style={styles.backText}>{t('auth.back')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // step === 'otp'
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>QuroVita</Text>

      {!otpSent ? (
        <>
          <Text style={styles.label}>{t('auth.phoneLabel')}</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder={t('auth.phonePlaceholder')}
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <TouchableOpacity
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
            onPress={() => void handleSendOtp()}
            disabled={loading}
            accessibilityRole="button"
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>{t('auth.sendCode')}</Text>
            )}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.hint}>{t('auth.otpSent', { phone: phone.trim() })}</Text>
          <Text style={styles.label}>{t('auth.otpLabel')}</Text>
          <TextInput
            style={styles.input}
            value={otp}
            onChangeText={setOtp}
            placeholder={t('auth.otpPlaceholder')}
            keyboardType="number-pad"
            maxLength={6}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <TouchableOpacity
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
            onPress={() => void handleVerifyOtp()}
            disabled={loading}
            accessibilityRole="button"
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>{t('auth.verify')}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { setOtpSent(false); setOtp(''); setError(null); }}
            style={styles.backButton}
          >
            <Text style={styles.backText}>{t('auth.back')}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 32,
    color: '#1a1a2e',
  },
  langButton: {
    backgroundColor: '#0066cc',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  langButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  consentScroll: {
    flex: 1,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
  },
  consentText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#333',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 12,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: '#0066cc',
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  checkboxChecked: {
    backgroundColor: '#0066cc',
  },
  checkLabel: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    marginBottom: 16,
    color: '#1a1a2e',
  },
  hint: {
    fontSize: 13,
    color: '#555',
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: '#0066cc',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  backButton: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  backText: {
    color: '#0066cc',
    fontSize: 14,
  },
  errorText: {
    color: '#cc0000',
    fontSize: 13,
    marginBottom: 12,
  },
});
