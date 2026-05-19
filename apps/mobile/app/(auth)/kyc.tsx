import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuthContext } from '../../src/auth/AuthContext';

export default function KycScreen() {
  const { t } = useTranslation();
  const { signIn, jwt } = useAuthContext();

  const handleContinue = async () => {
    // Mark as authenticated (skipping real KYC until T5.1 Smile ID integration)
    if (jwt) await signIn(jwt, true);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>{t('kyc.title')}</Text>
      <Text style={styles.body}>{t('kyc.body')}</Text>
      <TouchableOpacity
        style={styles.button}
        onPress={() => void handleContinue()}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{t('kyc.continue')}</Text>
      </TouchableOpacity>
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
    marginBottom: 16,
    color: '#1a1a2e',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: '#555',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#0066cc',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
