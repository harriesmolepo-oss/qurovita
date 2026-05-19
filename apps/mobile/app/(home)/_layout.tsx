import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

export default function HomeLayout() {
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: '#0066cc',
        tabBarInactiveTintColor: '#888',
        tabBarStyle: { backgroundColor: '#fff' },
        headerStyle: { backgroundColor: '#0066cc' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabs.records'), tabBarLabel: t('tabs.records') }}
      />
      <Tabs.Screen
        name="share"
        options={{ title: t('tabs.share'), tabBarLabel: t('tabs.share') }}
      />
      <Tabs.Screen
        name="assistant"
        options={{ title: t('tabs.assistant'), tabBarLabel: t('tabs.assistant') }}
      />
    </Tabs>
  );
}
