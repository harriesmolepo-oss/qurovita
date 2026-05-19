import Constants from 'expo-constants';

const PLACEHOLDER = 'http://REPLACE_WITH_LAN_IP:3000';

function resolveApiBaseUrl(): string {
  const raw = Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;
  if (!raw || raw === PLACEHOLDER) {
    throw new Error(
      'API_BASE_URL is not configured. Open apps/mobile/app.json and set ' +
        'extra.apiBaseUrl to your laptop\'s LAN IP (find it with ipconfig on ' +
        'Windows). The A36 cannot reach localhost.',
    );
  }
  return raw.replace(/\/$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();
