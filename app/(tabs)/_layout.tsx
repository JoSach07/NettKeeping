import { Stack, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import BottomNav from '@/components/BottomNav';
import { useAppTheme } from '@/hooks/useAppTheme';

export default function MainLayout() {
  const { createTransactionAsStartupScreen } = useAppTheme();
  const pathname = usePathname();
  const router = useRouter();
  const startupNavigationChecked = useRef(false);

  useEffect(() => {
    if (startupNavigationChecked.current) {
      return;
    }

    startupNavigationChecked.current = true;

    if (createTransactionAsStartupScreen && pathname === '/') {
      router.replace('/createTransaction');
    }
  }, [createTransactionAsStartupScreen, pathname, router]);

  return (
    <View style={styles.container}>
      <View style={styles.screen}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="accountTransactions" />
          <Stack.Screen name="accounts" />
          <Stack.Screen name="appSettings" />
          <Stack.Screen name="categoryBreakdown" />
          <Stack.Screen name="createTransaction" />
          <Stack.Screen name="investmentQuantityHistory" />
          <Stack.Screen name="investmentValueHistory" />
          <Stack.Screen name="investments" />
          <Stack.Screen name="manageAccounts" />
          <Stack.Screen name="manageCategories" />
          <Stack.Screen name="manageInvestments" />
          <Stack.Screen name="manageInvestmentCategories" />
          <Stack.Screen name="selectInvestmentCategory" />
          <Stack.Screen name="selectTransactionField" />
        </Stack>
      </View>
      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
});
