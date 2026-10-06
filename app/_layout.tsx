import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useState } from 'react';
import 'react-native-gesture-handler';
import 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import AppLockGate from '@/components/AppLockGate';
import { AppThemeProvider, useAppTheme } from '@/hooks/useAppTheme';
import { useBlurInputOnKeyboardHide } from '@/hooks/useBlurInputOnKeyboardHide';
import { SummaryModeProvider } from '@/hooks/useSummaryMode';
import { getDBConnection } from '@/database/dbService';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Open on the tab stack, so it sits at the bottom of the navigation stack.
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useBlurInputOnKeyboardHide();

  useEffect(() => {
    const initDB = async () => {
      try {
        await getDBConnection();
      } catch (error) {
        console.error('Database error:', error);
      }
    };

    initDB();
  }, []);

  const [loaded, error] = useFonts({
    ...FontAwesome.font,
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  if (!loaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppThemeProvider>
        <SummaryModeProvider>
          <RootLayoutNav />
        </SummaryModeProvider>
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutNav() {
  const { loading, theme } = useAppTheme();
  const [lockGateReady, setLockGateReady] = useState(false);
  const handleLockGateReady = useCallback(() => setLockGateReady(true), []);

  useEffect(() => {
    if (!loading && lockGateReady) {
      SplashScreen.hideAsync();
    }
  }, [loading, lockGateReady]);

  if (loading) {
    return null;
  }

  return (
    <ThemeProvider value={theme === 'dark' ? DarkTheme : DefaultTheme}>
      <AppLockGate onReady={handleLockGateReady}>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
      </AppLockGate>
    </ThemeProvider>
  );
}
