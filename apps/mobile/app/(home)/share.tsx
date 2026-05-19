import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';

// Shell screen — BLE advertising, ECDH keypair generation, QR rendering,
// and bundle transmission are implemented in T4.3 / T4.4.
export default function ShareScreen() {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      <Text style={styles.body}>{t('share.body')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: '#555',
    textAlign: 'center',
  },
});
