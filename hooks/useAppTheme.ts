import { createContext, createElement, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import {
  AppThemeSetting,
  defaultAppSettings,
  getAppSettings,
  updateCreateTransactionAsStartupScreen,
  updateAppTheme,
  updateLeftHandedMode,
} from '@/database/tables/appSettings';
import { InsertOrUpdateResult } from '@/database/dbService';

export type AppTheme = keyof typeof Colors;

type AppThemeContextValue = {
  colors: typeof Colors[AppTheme];
  createTransactionAsStartupScreen: boolean;
  leftHandedMode: boolean;
  loading: boolean;
  refreshSettings: () => Promise<void>;
  setCreateTransactionAsStartupScreen: (createTransactionAsStartupScreen: boolean) => Promise<InsertOrUpdateResult>;
  setLeftHandedMode: (leftHandedMode: boolean) => Promise<InsertOrUpdateResult>;
  setThemeSetting: (themeSetting: AppThemeSetting) => Promise<InsertOrUpdateResult>;
  theme: AppTheme;
  themeSetting: AppThemeSetting;
};

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

const getResolvedTheme = (themeSetting: AppThemeSetting, deviceTheme: AppTheme): AppTheme =>
  themeSetting === 'device' ? deviceTheme : themeSetting;

export function AppThemeProvider({ children }: PropsWithChildren) {
  const deviceTheme: AppTheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [themeSetting, setThemeSettingState] = useState<AppThemeSetting>(defaultAppSettings.Theme);
  const [leftHandedMode, setLeftHandedModeState] = useState(defaultAppSettings.LeftHandedMode);
  const [createTransactionAsStartupScreen, setCreateTransactionAsStartupScreenState] = useState(
    defaultAppSettings.CreateTransactionAsStartupScreen
  );
  const [loading, setLoading] = useState(true);

  const refreshSettings = useCallback(async () => {
    setLoading(true);

    const result = await getAppSettings();
    if (result.Status === 'Success') {
      setThemeSettingState(result.Data.Theme);
      setLeftHandedModeState(result.Data.LeftHandedMode);
      setCreateTransactionAsStartupScreenState(result.Data.CreateTransactionAsStartupScreen);
    } else if (result.Message) {
      console.warn(result.Message);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const setThemeSetting = useCallback(async (nextThemeSetting: AppThemeSetting) => {
    const previousThemeSetting = themeSetting;
    setThemeSettingState(nextThemeSetting);

    const result = await updateAppTheme(nextThemeSetting);
    if (result.Status !== 'Success') {
      setThemeSettingState(previousThemeSetting);
    }

    return result;
  }, [themeSetting]);

  const setLeftHandedMode = useCallback(async (nextLeftHandedMode: boolean) => {
    const previousLeftHandedMode = leftHandedMode;
    setLeftHandedModeState(nextLeftHandedMode);

    const result = await updateLeftHandedMode(nextLeftHandedMode);
    if (result.Status !== 'Success') {
      setLeftHandedModeState(previousLeftHandedMode);
    }

    return result;
  }, [leftHandedMode]);

  const setCreateTransactionAsStartupScreen = useCallback(async (nextCreateTransactionAsStartupScreen: boolean) => {
    const previousCreateTransactionAsStartupScreen = createTransactionAsStartupScreen;
    setCreateTransactionAsStartupScreenState(nextCreateTransactionAsStartupScreen);

    const result = await updateCreateTransactionAsStartupScreen(nextCreateTransactionAsStartupScreen);
    if (result.Status !== 'Success') {
      setCreateTransactionAsStartupScreenState(previousCreateTransactionAsStartupScreen);
    }

    return result;
  }, [createTransactionAsStartupScreen]);

  const theme = getResolvedTheme(themeSetting, deviceTheme);
  const value = useMemo(
    () => ({
      colors: Colors[theme],
      createTransactionAsStartupScreen,
      leftHandedMode,
      loading,
      refreshSettings,
      setCreateTransactionAsStartupScreen,
      setLeftHandedMode,
      setThemeSetting,
      theme,
      themeSetting,
    }),
    [
      createTransactionAsStartupScreen,
      leftHandedMode,
      loading,
      refreshSettings,
      setCreateTransactionAsStartupScreen,
      setLeftHandedMode,
      setThemeSetting,
      theme,
      themeSetting,
    ]
  );

  return createElement(AppThemeContext.Provider, { value }, children);
}

export function useAppTheme() {
  const context = useContext(AppThemeContext);
  const deviceTheme: AppTheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  if (context) {
    return context;
  }

  const theme = getResolvedTheme(defaultAppSettings.Theme, deviceTheme);

  return {
    colors: Colors[theme],
    createTransactionAsStartupScreen: defaultAppSettings.CreateTransactionAsStartupScreen,
    leftHandedMode: defaultAppSettings.LeftHandedMode,
    loading: false,
    refreshSettings: async () => {},
    setCreateTransactionAsStartupScreen: async (): Promise<InsertOrUpdateResult> => ({ Status: 'Error', Message: 'AppThemeProvider is not available.' }),
    setLeftHandedMode: async (): Promise<InsertOrUpdateResult> => ({ Status: 'Error', Message: 'AppThemeProvider is not available.' }),
    setThemeSetting: async (): Promise<InsertOrUpdateResult> => ({ Status: 'Error', Message: 'AppThemeProvider is not available.' }),
    theme,
    themeSetting: defaultAppSettings.Theme,
  };
}

