import FontAwesome from '@expo/vector-icons/FontAwesome';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import LoadingDots from '@/components/themed/LoadingDots';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { NumericField } from '@/components/themed/fields';
import { AppThemeSetting, getAppSettings } from '@/database/tables/appSettings';
import {
  defaultPinHashAlgorithm,
  disableUserPin,
  enableUserPin,
  getUserPinSettings,
  maxFailedPinAttempts,
  pinLockoutSeconds,
  updateBiometricsEnabled,
  UserPinSettings,
  clearPinLockout,
  recordFailedPinAttempt,
} from '@/database/tables/userPinSettings';
import { useAppTheme } from '@/hooks/useAppTheme';
import {
  createPinHash,
  formatRecoveryCode,
  formatRecoveryCodeForDisplay,
  generateRecoveryCode,
  verifyPinHash,
} from '@/utils/pinCrypto';
import { runWithAppLockSuspended } from '@/utils/appLockSuspension';
import { notifyPinSettingsChanged } from '@/utils/pinSettingsEvents';
import { setStoredRecoveryCredentials } from '@/utils/secureCredentials';
import {
  exportEncryptedDatabaseBackup,
  importEncryptedDatabaseBackup,
  selectEncryptedDatabaseBackup,
} from '@/utils/databaseBackup';
import {
  chooseExportDirectory,
  defaultExportDirectoryName,
} from '@/utils/exportDirectory';
import { describeError, ErrorMessage } from '@/utils/userFacingError';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type PopupMessage = {
  detail?: string | null;
  message: string;
  title?: string;
  variant: 'danger' | 'success' | 'warning';
};

type BackupModalMode = 'export' | 'import';
type PinModalMode = 'enable' | 'disable';
type SettingIconName = React.ComponentProps<typeof FontAwesome>['name'] | 'fingerprint';

const themeOptions: { label: string; value: AppThemeSetting }[] = [
  { label: 'Use device settings', value: 'device' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

const getThemeLabel = (themeSetting: AppThemeSetting) =>
  themeOptions.find((option) => option.value === themeSetting)?.label ?? 'Use device settings';

const getBackupRecommendation = (pinEnabled: boolean, biometricsEnabled: boolean, canUseBiometrics: boolean) =>
  canUseBiometrics && pinEnabled !== biometricsEnabled
    ? '\n\nFor backup access, it is recommended to enable both PIN and biometrics.'
    : '';

const waitForUiPaint = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

export default function AppSettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    colors,
    createTransactionAsStartupScreen,
    leftHandedMode,
    setCreateTransactionAsStartupScreen,
    setLeftHandedMode,
    setThemeSetting,
    themeSetting,
  } = useAppTheme();
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [pinModalMode, setPinModalMode] = useState<PinModalMode | null>(null);
  const [backupModalMode, setBackupModalMode] = useState<BackupModalMode | null>(null);
  const [selectedBackupUri, setSelectedBackupUri] = useState<string | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [confirmBackupPassword, setConfirmBackupPassword] = useState('');
  const [backupModalError, setBackupModalError] = useState('');
  // Failures returned by the backup utilities render inside the modal, not on
  // the screen behind it. The screen-level Popup below lives in this screen's
  // own view tree, and a native Modal window always draws above that tree, so a
  // backup error used to appear on the main screen dimmed by the modal
  // backdrop. Same in-modal Popup pattern as manageAccounts/manageCategories.
  // The status row keeps the synchronous validation messages and the progress
  // label; this carries the async result, which is the path that has a Detail.
  const [backupModalPopup, setBackupModalPopup] = useState<PopupMessage | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinModalError, setPinModalError] = useState('');
  // Same split as backupModalPopup: pinModalError is the status row for
  // synchronous validation; this carries a failed enable/disable write, which
  // used to go to the screen-level Popup hidden behind the open PIN modal.
  const [pinModalPopup, setPinModalPopup] = useState<PopupMessage | null>(null);
  const [pinLockoutRemainingSeconds, setPinLockoutRemainingSeconds] = useState(0);
  const [userPinSettings, setUserPinSettings] = useState<UserPinSettings | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryCodeCopied, setRecoveryCodeCopied] = useState(false);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportDirectoryConfigured, setExportDirectoryConfigured] = useState(false);
  const [exportDirectoryName, setExportDirectoryName] = useState(defaultExportDirectoryName);
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);
  const infoIconScale = useMemo(() => new Animated.Value(1), []);
  const leftHandedModeMounted = useRef(false);

  const pinEnabled = userPinSettings?.IsPinEnabled ?? false;
  const biometricsEnabled = userPinSettings?.IsBiometricsEnabled ?? false;
  const displayedPinEnabled =
    pinModalMode === 'enable' ? true : pinModalMode === 'disable' ? false : pinEnabled;

  useEffect(() => {
    if (pinModalMode !== 'disable' || !userPinSettings?.LockedUntil) {
      setPinLockoutRemainingSeconds(0);
      return;
    }

    const updateRemainingSeconds = () => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil((new Date(userPinSettings.LockedUntil ?? '').getTime() - Date.now()) / 1000)
      );

      setPinLockoutRemainingSeconds(remainingSeconds);
      if (remainingSeconds === 0) {
        setPinModalError('');
        setUserPinSettings((current) => (current ? { ...current, LockedUntil: null } : current));
      }
    };

    updateRemainingSeconds();
    const intervalId = setInterval(updateRemainingSeconds, 1000);
    return () => clearInterval(intervalId);
  }, [pinModalMode, userPinSettings?.LockedUntil]);

  const loadPinSettings = useCallback(async () => {
    const result = await getUserPinSettings();
    if (result.Status === 'Success' && result.Data) {
      setUserPinSettings(result.Data);

      if (result.Message) {
        setPopupMessage({
          title: 'PIN reset',
          message: result.Message,
          variant: 'warning',
        });
      }
    } else {
      setPopupMessage({
        detail: result.Detail,
        message: result.Message ?? 'Failed to load security settings.',
        variant: 'danger',
      });
    }
  }, []);

  useEffect(() => {
    loadPinSettings();
  }, [loadPinSettings]);

  const loadExportDirectory = useCallback(async () => {
    const result = await getAppSettings();

    if (result.Status === 'Success') {
      setExportDirectoryConfigured(Boolean(result.Data.ExportDirectoryUri));
      setExportDirectoryName(result.Data.ExportDirectoryName ?? defaultExportDirectoryName);
    }
  }, []);

  useEffect(() => {
    loadExportDirectory();
  }, [loadExportDirectory]);

  useEffect(() => {
    let mounted = true;

    const loadBiometricsAvailability = async () => {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);

      if (mounted) {
        setCanUseBiometrics(hasHardware && isEnrolled);
      }
    };

    loadBiometricsAvailability();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!leftHandedModeMounted.current) {
      leftHandedModeMounted.current = true;
      return;
    }

    Animated.sequence([
      Animated.timing(infoIconScale, {
        duration: 90,
        toValue: 0.82,
        useNativeDriver: true,
      }),
      Animated.spring(infoIconScale, {
        friction: 4,
        tension: 180,
        toValue: 1,
        useNativeDriver: true,
      }),
    ]).start();
  }, [infoIconScale, leftHandedMode]);

  const closePinModal = () => {
    if (saving) {
      return;
    }

    setPinModalMode(null);
    setPin('');
    setConfirmPin('');
    setPinModalError('');
    setPinModalPopup(null);
  };

  const closeBackupModal = () => {
    if (saving) {
      return;
    }

    setBackupModalMode(null);
    setBackupPassword('');
    setConfirmBackupPassword('');
    setBackupModalError('');
    setBackupModalPopup(null);
    setSelectedBackupUri(null);
  };

  const handleSelectBackupFile = async () => {
    if (saving) {
      return;
    }

    setSaving(true);
    const result = await selectEncryptedDatabaseBackup();
    setSaving(false);

    if (result.Status === 'Cancelled') {
      return;
    }

    if (result.Status === 'Error' || !result.Uri) {
      setPopupMessage({
        detail: result.Detail,
        message: result.Message ?? 'Failed to select database backup.',
        variant: 'danger',
      });
      return;
    }

    setSelectedBackupUri(result.Uri);
    setBackupModalMode('import');
  };

  const handleBackupData = async () => {
    if (saving || !backupModalMode) {
      return;
    }

    // Unmount the previous attempt's popup before validating: it stops a stale
    // failure from sitting under a fresh status-row message, and it lets an
    // identical message remount so the danger shake replays on a second miss.
    setBackupModalPopup(null);

    if (backupPassword.length < 8) {
      setBackupModalError('Password must be at least 8 characters.');
      return;
    }

    if (backupModalMode === 'export' && backupPassword !== confirmBackupPassword) {
      setBackupModalError('Password confirmation does not match.');
      return;
    }

    setBackupModalError('');
    setSaving(true);
    await waitForUiPaint();

    if (backupModalMode === 'import' && !selectedBackupUri) {
      setSaving(false);
      setBackupModalError('Select a backup file before importing.');
      return;
    }

    const result = backupModalMode === 'export'
      ? await exportEncryptedDatabaseBackup(backupPassword)
      : await importEncryptedDatabaseBackup(selectedBackupUri!, backupPassword);

    setSaving(false);

    if (result.Status === 'Cancelled') {
      return;
    }

    if (result.Status === 'Success') {
      if (backupModalMode === 'import') {
        // The import replaced the UserPinSettings table.
        notifyPinSettingsChanged();
      }

      // The import used to clear the export directory, so this reset the row to
      // "choose once" to match. The directory now survives an import, and the
      // displayed value is already the local one, so resetting it here would be
      // the only thing left telling the user to pick a folder again.
      setPopupMessage({
        title: backupModalMode === 'export' ? 'Export complete' : 'Import complete',
        message:
          backupModalMode === 'export'
            ? 'Encrypted database backup exported.'
            : 'Database backup imported. Restart NettKeeping if any screen shows stale data.',
        variant: 'success',
      });
      setBackupModalMode(null);
      setBackupPassword('');
      setConfirmBackupPassword('');
      setBackupModalError('');
      setBackupModalPopup(null);
      setSelectedBackupUri(null);
      return;
    }

    // Detail is only set when Message is a generic fallback standing in for an
    // internal error, so there is nothing to reveal when the failure was
    // already explained in plain words.
    // The modal deliberately stays open so the password can be retyped.
    setBackupModalPopup({
      detail: result.Detail,
      message: result.Message ?? 'Database backup action failed.',
      variant: 'danger',
    });
  };

  const handleChooseExportDirectory = async () => {
    if (saving) {
      return;
    }

    setSaving(true);
    const result = await chooseExportDirectory();
    setSaving(false);

    if (result.Status === 'Cancelled') {
      return;
    }

    if (result.Status === 'Success') {
      const directoryName = result.DirectoryName ?? defaultExportDirectoryName;
      setExportDirectoryConfigured(true);
      setExportDirectoryName(directoryName);
      setPopupMessage({
        title: 'Export directory updated',
        message: `Future exports will be saved to ${directoryName}.`,
        variant: 'success',
      });
      return;
    }

    setPopupMessage({
      detail: result.Detail,
      message: result.Message ?? 'Failed to update the export output directory.',
      variant: 'danger',
    });
  };

  const showSecuritySuccess = (message: string, nextPinEnabled: boolean, nextBiometricsEnabled: boolean) => {
    setPopupMessage({
      title: 'Security updated',
      message: `${message}${getBackupRecommendation(nextPinEnabled, nextBiometricsEnabled, canUseBiometrics)}`,
      variant: 'success',
    });
  };

  const handleThemeSelect = async (nextThemeSetting: AppThemeSetting) => {
    const result = await setThemeSetting(nextThemeSetting);

    if (result.Status === 'Success') {
      return;
    }

    setPopupMessage({
      detail: result.Detail,
      message: result.Message ?? 'Failed to update app theme.',
      variant: 'danger',
    });
  };

  const handleLeftHandedModeChange = async (nextLeftHandedMode: boolean) => {
    const result = await setLeftHandedMode(nextLeftHandedMode);

    if (result.Status === 'Success') {
      setPopupMessage({
        title: 'Layout updated',
        message: `Left-handed mode ${nextLeftHandedMode ? 'enabled' : 'disabled'}.`,
        variant: 'success',
      });
      return;
    }

    setPopupMessage({
      detail: result.Detail,
      message: result.Message ?? 'Failed to update left-handed mode.',
      variant: 'danger',
    });
  };

  const handleCreateTransactionAsStartupScreenChange = async (nextCreateTransactionAsStartupScreen: boolean) => {
    const result = await setCreateTransactionAsStartupScreen(nextCreateTransactionAsStartupScreen);

    if (result.Status === 'Success') {
      setPopupMessage({
        title: 'Startup updated',
        message: `NettKeeping will ${nextCreateTransactionAsStartupScreen ? 'open Create Transaction' : 'open Home'} on startup.`,
        variant: 'success',
      });
      return;
    }

    setPopupMessage({
      detail: result.Detail,
      message: result.Message ?? 'Failed to update startup screen.',
      variant: 'danger',
    });
  };

  const handleSavePin = async () => {
    if (saving || !pinModalMode) {
      return;
    }

    if (pinModalMode === 'enable') {
      if (!/^\d{4,12}$/.test(pin)) {
        setPinModalError('PIN must be 4 to 12 digits.');
        return;
      }

      if (pin !== confirmPin) {
        setPinModalError('PIN confirmation does not match.');
        return;
      }
    } else {
      if (!pin) {
        setPinModalError('Current PIN is required.');
        return;
      }

      if (userPinSettings?.LockedUntil && new Date(userPinSettings.LockedUntil).getTime() > Date.now()) {
        const lockedSeconds = Math.ceil((new Date(userPinSettings.LockedUntil).getTime() - Date.now()) / 1000);
        setPinLockoutRemainingSeconds(lockedSeconds);
        setPinModalError('');
        return;
      }
    }

    setPinModalError('');
    setPinModalPopup(null);
    setSaving(true);

    if (pinModalMode === 'disable') {
      let pinHash = userPinSettings?.PinHash;
      let pinSalt = userPinSettings?.PinSalt;
      let pinIterations = userPinSettings?.HashIterations;

      if (!pinHash || !pinSalt || !pinIterations) {
        const refreshedSettings = await getUserPinSettings();

        if (
          refreshedSettings.Status !== 'Success' ||
          !refreshedSettings.Data ||
          !refreshedSettings.Data.PinHash ||
          !refreshedSettings.Data.PinSalt ||
          !refreshedSettings.Data.HashIterations
        ) {
          setSaving(false);
          setPinModalError('Saved PIN data could not be loaded.');
          return;
        }

        setUserPinSettings(refreshedSettings.Data);
        pinHash = refreshedSettings.Data.PinHash;
        pinSalt = refreshedSettings.Data.PinSalt;
        pinIterations = refreshedSettings.Data.HashIterations;
      }

      const pinIsValid = await verifyPinHash(
        pin,
        pinHash,
        pinSalt,
        pinIterations
      );

      if (!pinIsValid) {
        const nextFailedAttemptCount = (userPinSettings?.FailedAttemptCount ?? 0) + 1;

        await recordFailedPinAttempt();

        if (nextFailedAttemptCount >= maxFailedPinAttempts) {
          setUserPinSettings((current) =>
            current
              ? {
                  ...current,
                  FailedAttemptCount: 0,
                  LockedUntil: new Date(Date.now() + pinLockoutSeconds * 1000).toISOString(),
                }
              : current
          );
          setPinLockoutRemainingSeconds(pinLockoutSeconds);
          setPinModalError('');
        } else {
          setUserPinSettings((current) =>
            current
              ? {
                  ...current,
                  FailedAttemptCount: nextFailedAttemptCount,
                  LockedUntil: null,
                }
              : current
          );
          const attemptsRemaining = Math.max(0, maxFailedPinAttempts - nextFailedAttemptCount);
          setPinModalError(`Incorrect PIN. ${attemptsRemaining} attempts remaining.`);
        }

        setSaving(false);
        setPin('');
        return;
      }

      await clearPinLockout();
    }

    const result =
      pinModalMode === 'enable'
        ? await createPinHash(pin).then(({ hash, iterations, salt }) =>
            enableUserPin(hash, salt, defaultPinHashAlgorithm, iterations)
          )
        : await disableUserPin();

    if (result.Status === 'Success') {
      const nextPinEnabled = pinModalMode === 'enable';
      const nextBiometricsEnabled = nextPinEnabled ? biometricsEnabled : false;
      let nextRecoveryCode: string | null = null;
      // Held until the end rather than shown on the spot: showSecuritySuccess
      // below used to overwrite it in the same pass, so the user was told
      // "Security updated" and never learned there was no recovery code.
      let recoveryCodeWarning: ErrorMessage | null = null;

      if (nextPinEnabled) {
        try {
          nextRecoveryCode = generateRecoveryCode();
          const recovery = await createPinHash(nextRecoveryCode);
          await setStoredRecoveryCredentials({
            hash: recovery.hash,
            salt: recovery.salt,
            iterations: recovery.iterations,
          });
        } catch (error) {
          nextRecoveryCode = null;
          const described = describeError(error, 'Your PIN was enabled, but a recovery code could not be saved.');
          recoveryCodeWarning = { detail: described.Detail, message: described.Message };
        }
      }

      // After the recovery code is stored, so the gate's "Forgot PIN?" link
      // reflects it.
      notifyPinSettingsChanged();
      const updatedSettings = await getUserPinSettings();

      setSaving(false);

      if (updatedSettings.Status === 'Success' && updatedSettings.Data) {
        setUserPinSettings(updatedSettings.Data);
      }

      closePinModal();

      if (nextRecoveryCode) {
        setRecoveryCodeCopied(false);
        setRecoveryCode(nextRecoveryCode);
      } else if (recoveryCodeWarning) {
        // In place of the success message, not before it. The PIN modal is
        // closed by now, so the screen-level Popup is the right place.
        setPopupMessage({
          title: 'Recovery code unavailable',
          detail: recoveryCodeWarning.detail,
          message: `${recoveryCodeWarning.message}${getBackupRecommendation(nextPinEnabled, nextBiometricsEnabled, canUseBiometrics)}`,
          variant: 'warning',
        });
      } else {
        showSecuritySuccess(`PIN ${nextPinEnabled ? 'enabled' : 'disabled'}.`, nextPinEnabled, nextBiometricsEnabled);
      }
      return;
    }

    setSaving(false);
    setPinModalPopup({
      detail: result.Detail,
      message: result.Message ?? `Failed to ${pinModalMode} PIN.`,
      variant: 'danger',
    });
  };

  const handleCopyRecoveryCode = async () => {
    if (!recoveryCode) {
      return;
    }

    await Clipboard.setStringAsync(formatRecoveryCode(recoveryCode));
    setRecoveryCodeCopied(true);
  };

  const closeRecoveryCodeModal = () => {
    const pinIsEnabled = userPinSettings?.IsPinEnabled ?? true;
    setRecoveryCode(null);
    setRecoveryCodeCopied(false);
    showSecuritySuccess('PIN enabled.', pinIsEnabled, biometricsEnabled);
  };

  const handleBiometricsChange = async (nextBiometricsEnabled: boolean) => {
    if (saving) {
      return;
    }

    if (nextBiometricsEnabled) {
      if (!canUseBiometrics) {
        setPopupMessage({ message: 'Biometrics are not available on this device.', variant: 'danger' });
        return;
      }

      // Suspended because the device-credential fallback (pattern/PIN/password)
      // is a separate system activity and would otherwise trip the relock.
      const authResult = await runWithAppLockSuspended(() =>
        LocalAuthentication.authenticateAsync({
          cancelLabel: 'Cancel',
          disableDeviceFallback: false,
          promptMessage: 'Enable biometrics for NettKeeping',
        })
      );

      if (!authResult.success) {
        setPopupMessage({ message: 'Biometric authentication was not completed.', variant: 'warning' });
        return;
      }
    }

    setSaving(true);
    const result = await updateBiometricsEnabled(nextBiometricsEnabled);
    setSaving(false);

    if (result.Status === 'Success') {
      notifyPinSettingsChanged();
      setUserPinSettings((current) =>
        current ? { ...current, IsBiometricsEnabled: nextBiometricsEnabled } : current
      );
      showSecuritySuccess(
        `Biometrics ${nextBiometricsEnabled ? 'enabled' : 'disabled'}.`,
        pinEnabled,
        nextBiometricsEnabled
      );
      return;
    }

    setPopupMessage({
      detail: result.Detail,
      message: result.Message ?? 'Failed to update biometrics setting.',
      variant: 'danger',
    });
  };

  // Changes PIN settings text depending on current state.
  const pinModalTitle = pinModalMode === 'enable' ? 'Enable PIN' : 'Disable PIN';
  const pinModalAction = pinModalMode === 'enable' ? 'Enable' : 'Disable';
  const backupModalTitle = backupModalMode === 'export' ? 'Export Data' : 'Import Data';
  const backupModalAction = backupModalMode === 'export' ? 'Export' : 'Import';

  // Loading indicator text. The work has no measurable progress, so the label
  // is paired with a looping spinner rather than a dot sequence that fills up
  // and resets — that read as a progress bar. The spinner also animates
  // natively, where the old dots re-rendered this whole screen every 350ms.
  const pinProcessingLabel = pinModalMode === 'enable' ? 'Securing PIN' : 'Verifying PIN';
  const backupProcessingLabel = backupModalMode === 'export' ? 'Exporting backup' : 'Importing backup';

  // PIN popup message.
  // If its attempting to save, then show the loading indicator text otherwise check how many tried the user have in attempting to insert their pin.
  // If the user no longer has any attempts, show the locked down message, otherwise show how many attempts they have left.
  const pinModalStatusMessage = saving
    ? pinProcessingLabel
    : pinLockoutRemainingSeconds > 0
      ? `Try again in ${pinLockoutRemainingSeconds} seconds.`
      : pinModalError;
  const pinModalStatusColor = saving
    ? colors.text
    : pinLockoutRemainingSeconds > 0
      ? colors.warningText
      : colors.dangerText;
  const backupModalStatusMessage = saving ? backupProcessingLabel : backupModalError;
  const backupModalStatusColor = saving ? colors.text : colors.dangerText;
  const popupBottomOffset = useMemo(() => ({ bottom: insets.bottom + 16 }), [insets.bottom]);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Animated.View
            style={[
              styles.infoButton,
              leftHandedMode ? styles.infoButtonLeft : styles.infoButtonRight,
              { transform: [{ scale: infoIconScale }] },
            ]}>
            <Pressable
              accessibilityLabel="Show app settings information"
              accessibilityRole="button"
              onPress={() => setInfoModalOpen(true)}
              testID="settings.info"
              style={({ pressed }) => [styles.infoButtonPressable, pressed && styles.pressed]}>
              <FontAwesome name="info-circle" size={24} color={colors.buttonPrimary} />
            </Pressable>
          </Animated.View>
          <Text style={styles.title}>App Settings</Text>
        </View>

        <View style={styles.section}>
          <SettingButton
            icon="paint-brush"
            label="App theme"
            testID="settings.theme"
            onPress={() => setThemeModalOpen(true)}
            value={getThemeLabel(themeSetting)}
          />
          <SettingSwitch
            icon="exchange"
            label="Left-handed mode"
            testID="settings.leftHanded"
            onValueChange={handleLeftHandedModeChange}
            value={leftHandedMode}
          />
          <SettingSwitch
            icon="dollar"
            label="Create transaction on startup"
            testID="settings.startOnCreate"
            onValueChange={handleCreateTransactionAsStartupScreenChange}
            value={createTransactionAsStartupScreen}
          />
        </View>

        <View style={styles.section}>
          <SettingButton
            icon="university"
            label="Accounts"
            testID="settings.accounts"
            onPress={() => router.push('/manageAccounts')}
            value="Add, edit, and remove"
          />
          <SettingButton
            icon="bar-chart"
            label="Investments"
            testID="settings.investments"
            onPress={() => router.push('/manageInvestments')}
            value="Add and view"
          />
          <SettingButton
            icon="tags"
            label="Transaction categories"
            testID="settings.transactionCategories"
            onPress={() => router.push('/manageCategories')}
            value="Add, edit, remove, and reassign"
          />
          <SettingButton
            icon="line-chart"
            label="Investment categories"
            testID="settings.investmentCategories"
            onPress={() => router.push('/manageInvestmentCategories')}
            value="Add, edit, remove, and reassign"
          />
        </View>

        <View style={styles.section}>
          <SettingButton
            icon="folder-open"
            label="Export output directory"
            testID="settings.exportDir"
            onPress={handleChooseExportDirectory}
            value={exportDirectoryConfigured ? exportDirectoryName : `${defaultExportDirectoryName} (choose once)`}
          />
          <SettingButton
            icon="download"
            label="Export data"
            testID="settings.exportData"
            onPress={() => setBackupModalMode('export')}
            value="Encrypted database backup"
          />
          <SettingButton
            icon="upload"
            label="Import data"
            testID="settings.importData"
            onPress={handleSelectBackupFile}
            value="Restore from backup"
          />
        </View>

        <View style={styles.section}>
          <SettingSwitch
            disabled={!userPinSettings}
            icon="lock"
            label="PIN"
            testID="settings.pin"
            onValueChange={(value) => setPinModalMode(value ? 'enable' : 'disable')}
            value={displayedPinEnabled}
          />
          {canUseBiometrics ? (
            <SettingSwitch
              disabled={!userPinSettings}
              icon="fingerprint"
              label="Biometrics"
              testID="settings.biometrics"
              onValueChange={handleBiometricsChange}
              value={biometricsEnabled}
            />
          ) : null}
        </View>

      </ScrollView>

      {popupMessage ? (
        <Popup
          detail={popupMessage.detail}
          message={popupMessage.message}
          onClose={() => setPopupMessage(null)}
          style={[styles.popup, popupBottomOffset]}
          title={popupMessage.title}
          variant={popupMessage.variant}
        />
      ) : null}

      <Modal animationType="fade" transparent visible={themeModalOpen} onRequestClose={() => setThemeModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={() => setThemeModalOpen(false)} />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>App theme</Text>
            {themeOptions.map((option) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: option.value === themeSetting }}
                key={option.value}
                onPress={() => handleThemeSelect(option.value)}
                testID={`settings.theme.option.${option.value}`}
                style={({ pressed }) => [
                  styles.optionRow,
                  option.value === themeSetting && { backgroundColor: colors.buttonPrimaryHighlighted },
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.value === themeSetting ? <FontAwesome name="check" size={18} color={colors.text} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={infoModalOpen} onRequestClose={() => setInfoModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={() => setInfoModalOpen(false)} />
          <View style={[styles.infoPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.infoHeader}>
              <Text style={styles.modalTitle}>Settings info</Text>
              <Pressable
                accessibilityLabel="Close settings information"
                accessibilityRole="button"
                onPress={() => setInfoModalOpen(false)}
                style={styles.infoCloseButton}
                testID="settings.info.close">
                <FontAwesome name="times" size={18} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.infoContent} showsVerticalScrollIndicator={false}>
              <InfoItem
                icon="paint-brush"
                title="App theme"
                description={`Changes the colors that NettKeeping uses.\n\nLight mode primarily uses bright colors, while Dark mode primarily uses, you guessed it, dark colors.`}
              />
              <InfoItem
                icon="exchange"
                title="Left-handed mode"
                description={`Moves certain buttons to the opposite side of the screen.\n\nWhen enabled, some buttons move to the left for easier access, and some move to the right for harder access.\n\nSome things, like the settings toggles on this page, will not move because they serve more as visual cues than buttons.`}
              />
              <InfoItem
                icon="dollar"
                title="Create transaction on startup"
                description="Opens the Create Transaction screen instead of Home when NettKeeping starts."
              />
              <InfoItem
                icon="lock"
                title="PIN"
                description={`Protects your privacy using a secure PIN.\n\nThis PIN will not protect any exported data.\n\nWhen you enable a PIN, NettKeeping shows a one-time recovery code. Store it somewhere safe: it is the only way back in if you forget your PIN.${
                  canUseBiometrics
                    ? '\n\nIt is recommended to also enable Biometrics as an alternative way of accessing your data.'
                    : ''
                }`}
              />
              {canUseBiometrics ? (
                <InfoItem
                  icon="fingerprint"
                  title="Biometrics"
                  description="Protects your privacy using your device's saved biometric authentication."
                />
              ) : null}
              <InfoItem
                icon="folder-open"
                title="Export output directory"
                description="Sets the folder where exported files are saved."
              />
              <InfoItem
                icon="download"
                title="Export and import data"
                description="Exports application data including accounts, investments, transactions, and all other user inputted data. Useful as a backup or for migrating data to another device."
              />
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={backupModalMode !== null} onRequestClose={closeBackupModal}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeBackupModal} />
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>{backupModalTitle}</Text>
              <Text style={styles.modalText}>
                {backupModalMode === 'export'
                  ? 'Choose a strong password for this backup. The file cannot be imported without it.'
                  : 'Importing replaces all current NettKeeping data on this device. Enter the backup password to continue.'}
              </Text>
              <TextInput
                accessibilityLabel="Backup password"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setBackupPassword}
                placeholder="Backup password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                style={[styles.passwordInput, { borderColor: colors.border, color: colors.text }]}
                testID="settings.backup.password"
                value={backupPassword}
              />
              {backupModalMode === 'export' ? (
                <TextInput
                  accessibilityLabel="Confirm backup password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setConfirmBackupPassword}
                  placeholder="Confirm password"
                  placeholderTextColor={colors.textMuted}
                  secureTextEntry
                  style={[styles.passwordInput, { borderColor: colors.border, color: colors.text }]}
                  testID="settings.backup.confirmPassword"
                  value={confirmBackupPassword}
                />
              ) : null}

              <View style={styles.modalStatusRow}>
                <Text
                  style={[
                    styles.modalStatusText,
                    { color: backupModalStatusColor },
                    !backupModalStatusMessage && styles.hiddenFeedbackText,
                  ]}
                  testID="settings.backup.status">
                  {backupModalStatusMessage || 'No backup status'}
                </Text>
                {saving ? <LoadingDots /> : null}
              </View>

              {backupModalPopup ? (
                <Popup
                  detail={backupModalPopup.detail}
                  message={backupModalPopup.message}
                  onClose={() => setBackupModalPopup(null)}
                  style={styles.modalPopup}
                  title={backupModalPopup.title}
                  variant={backupModalPopup.variant}
                />
              ) : null}

              <View style={styles.modalActions}>
                <Button disabled={saving} onPress={closeBackupModal} size="small" testID="settings.backup.cancel">
                  Cancel
                </Button>
                <Button
                  disabled={saving}
                  onPress={handleBackupData}
                  size="small"
                  testID="settings.backup.confirm"
                  variant={backupModalMode === 'import' ? 'danger' : 'primary'}>
                  {backupModalAction}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <Modal animationType="fade" transparent visible={pinModalMode !== null} onRequestClose={closePinModal}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closePinModal} />
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>{pinModalTitle}</Text>

              {pinModalMode === 'enable' ? (
                <>
                  <Text style={styles.modalText}>
                    Setting up a secure PIN may take a moment on some devices.
                  </Text>
                  <NumericField
                    label="PIN:"
                    testID="settings.pinForm.pin"
                    maxLength={12}
                    onChangeText={(value) => setPin(value.replace(/\D/g, ''))}
                    secureTextEntry
                    value={pin}
                  />
                  <NumericField
                    label="Confirm PIN:"
                    testID="settings.pinForm.confirmPin"
                    maxLength={12}
                    onChangeText={(value) => setConfirmPin(value.replace(/\D/g, ''))}
                    secureTextEntry
                    value={confirmPin}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.modalText}>Enter your current PIN. Disabling PIN will also disable biometrics.</Text>
                  <NumericField
                    label="Current PIN:"
                    testID="settings.pinForm.currentPin"
                    maxLength={12}
                    onChangeText={(value) => setPin(value.replace(/\D/g, ''))}
                    secureTextEntry
                    value={pin}
                  />
                </>
              )}

              <View style={styles.modalStatusRow}>
                <Text
                  style={[
                    styles.modalStatusText,
                    { color: pinModalStatusColor },
                    !pinModalStatusMessage && styles.hiddenFeedbackText,
                  ]}
                  testID="settings.pinForm.status">
                  {pinModalStatusMessage || 'No PIN status'}
                </Text>
                {saving ? <LoadingDots /> : null}
              </View>

              {pinModalPopup ? (
                <Popup
                  detail={pinModalPopup.detail}
                  message={pinModalPopup.message}
                  onClose={() => setPinModalPopup(null)}
                  style={styles.modalPopup}
                  title={pinModalPopup.title}
                  variant={pinModalPopup.variant}
                />
              ) : null}

              <View style={styles.modalActions}>
                <Button disabled={saving} onPress={closePinModal} size="small" testID="settings.pinForm.cancel">
                  Cancel
                </Button>
                <Button
                  disabled={saving || pinLockoutRemainingSeconds > 0}
                  onPress={handleSavePin}
                  size="small"
                  testID="settings.pinForm.save"
                  variant={pinModalMode === 'disable' ? 'danger' : 'primary'}>
                  {pinModalAction}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <Modal
        animationType="fade"
        transparent
        visible={recoveryCode !== null}
        onRequestClose={closeRecoveryCodeModal}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Recovery Code</Text>
            <Text style={styles.modalText}>
              Store your recovery code somewhere safe. You can use this in case you forget your access PIN.
            </Text>
            <Text
              accessibilityLabel="Your recovery code"
              selectable
              style={[styles.recoveryCodeText, { borderColor: colors.border }]}
              testID="settings.recovery.code">
              {recoveryCode ? formatRecoveryCodeForDisplay(recoveryCode) : ''}
            </Text>
            <View style={styles.modalActions}>
              <Button onPress={handleCopyRecoveryCode} size="small" testID="settings.recovery.copy">
                {recoveryCodeCopied ? 'Copied!' : 'Copy'}
              </Button>
              <Button onPress={closeRecoveryCodeModal} size="small" testID="settings.recovery.done" variant="primary">
                Done
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

type SettingButtonProps = {
  icon: SettingIconName;
  label: string;
  onPress: () => void;
  testID: string;
  value: string;
};

function SettingButton({ icon, label, onPress, testID, value }: SettingButtonProps) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.settingRow,
        { borderColor: colors.border },
        pressed && styles.pressed,
      ]}>
      <SettingIcon icon={icon} />
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={[styles.settingValue, { color: colors.textMuted }]}>{value}</Text>
      </View>
      <FontAwesome name="angle-right" size={22} color={colors.text} />
    </Pressable>
  );
}

type SettingSwitchProps = {
  disabled?: boolean;
  icon: SettingIconName;
  label: string;
  onValueChange: (value: boolean) => void;
  testID: string;
  value: boolean;
};

function SettingSwitch({ disabled, icon, label, onValueChange, testID, value }: SettingSwitchProps) {
  const { colors } = useAppTheme();
  const handlePress = () => {
    if (!disabled) {
      onValueChange(!value);
    }
  };

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={handlePress}
      testID={testID}
      style={({ pressed }) => [
        styles.settingRow,
        { borderColor: colors.border, opacity: disabled ? 0.55 : 1 },
        pressed && styles.pressed,
      ]}>
      <SettingIcon icon={icon} />
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
      </View>
      <Switch
        disabled={disabled}
        onValueChange={onValueChange}
        testID={`${testID}.switch`}
        thumbColor={value ? colors.buttonPrimary : colors.textMuted}
        trackColor={{ false: colors.border, true: colors.buttonPrimaryHighlighted }}
        value={value}
      />
    </Pressable>
  );
}

function SettingIcon({
  icon,
  size = 'regular',
}: {
  icon: SettingIconName;
  size?: 'info' | 'regular';
}) {
  const { colors } = useAppTheme();
  const iconSize = size === 'info' ? 18 : 18;
  const circleSize = size === 'info' ? 46 : 40;

  return (
    <View
      style={[
        styles.iconCircle,
        {
          backgroundColor: colors.buttonPrimary,
          borderRadius: circleSize / 2,
          height: circleSize,
          width: circleSize,
        },
      ]}>
      {icon === 'fingerprint' ? (
        <MaterialIcons name="fingerprint" size={size === 'info' ? 22 : 21} color={colors.text} />
      ) : (
        <FontAwesome name={icon} size={iconSize} color={colors.text} />
      )}
    </View>
  );
}

type InfoItemProps = {
  description: string;
  icon: SettingIconName;
  title: string;
};

function InfoItem({ description, icon, title }: InfoItemProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.infoItem}>
      <SettingIcon icon={icon} size="info" />
      <View style={styles.infoText}>
        <Text style={styles.infoTitle}>{title}</Text>
        <Text style={[styles.infoDescription, { color: colors.text }]}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: 15,
  },
  iconCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    justifyContent: 'center',
    minHeight: 40,
    position: 'relative',
  },
  infoButton: {
    height: 40,
    position: 'absolute',
    top: 0,
    width: 40,
    zIndex: 1,
  },
  infoButtonPressable: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  infoButtonLeft: {
    left: 0,
  },
  infoButtonRight: {
    right: 0,
  },
  infoCloseButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  infoContent: {
    paddingBottom: 6,
  },
  hiddenFeedbackText: {
    opacity: 0,
  },
  infoDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  infoHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  infoItem: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    paddingVertical: 12,
  },
  infoPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: '82%',
    maxWidth: 430,
    padding: 16,
    width: '92%',
  },
  infoText: {
    flex: 1,
    paddingLeft: 14,
  },
  infoTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  modalBackdropPressable: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  modalStatusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 20,
    marginBottom: 4,
  },
  modalStatusText: {
    // flexShrink rather than flex, so a long error still wraps but a short
    // processing label does not stretch and push the dots to the far edge.
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 20,
  },
  modalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 360,
    padding: 16,
    width: '90%',
  },
  modalPopup: {
    marginBottom: 8,
  },
  modalText: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 18,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
  optionLabel: {
    fontSize: 18,
  },
  optionRow: {
    alignItems: 'center',
    borderRadius: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
  },
  passwordInput: {
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 16,
    marginBottom: 12,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  recoveryCodeText: {
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1.5,
    marginBottom: 18,
    paddingHorizontal: 12,
    paddingVertical: 12,
    textAlign: 'center',
  },
  popup: {
    left: 15,
    position: 'absolute',
    right: 15,
  },
  pressed: {
    opacity: 0.65,
  },
  screen: {
    flex: 1,
  },
  section: {
    paddingTop: 24,
  },
  settingLabel: {
    fontSize: 18,
    fontWeight: '600',
  },
  settingRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 72,
    paddingVertical: 12,
  },
  settingText: {
    flex: 1,
    paddingLeft: 14,
  },
  settingValue: {
    fontSize: 14,
    marginTop: 3,
  },
  title: {
    fontSize: 30,
    fontWeight: '400',
    textAlign: 'center',
  },
});
