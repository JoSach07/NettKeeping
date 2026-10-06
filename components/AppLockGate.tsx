import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as LocalAuthentication from 'expo-local-authentication';

import Button from '@/components/themed/Button';
import LoadingDots from '@/components/themed/LoadingDots';
import Text from '@/components/themed/Text';
import {
  clearPinLockout,
  defaultPinHashAlgorithm,
  enableUserPin,
  getUserPinSettings,
  maxFailedPinAttempts,
  pinLockoutSeconds,
  recordFailedPinAttempt,
  UserPinSettings,
} from '@/database/tables/userPinSettings';
import { useAppTheme } from '@/hooks/useAppTheme';
import {
  createPinHash,
  formatRecoveryCode,
  formatRecoveryCodeForDisplay,
  generateRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeIsValidFormat,
  recoveryCodeLength,
  verifyPinHash,
} from '@/utils/pinCrypto';
import {
  appLockSuspensionGraceMs,
  isAppLockSuspended,
  setAppLockEngaged,
} from '@/utils/appLockSuspension';
import { subscribePinSettingsChanged } from '@/utils/pinSettingsEvents';
import {
  getStoredRecoveryCredentials,
  setStoredRecoveryCredentials,
} from '@/utils/secureCredentials';
import ErrorText, { DetailToggle } from '@/components/themed/ErrorText';
import { describeError, ErrorMessage, toErrorMessage } from '@/utils/userFacingError';

type AppLockGateProps = {
  children: ReactNode;
  onReady: () => void;
};

type LockStage = 'pin' | 'recovery' | 'newPin' | 'newRecoveryCode';

export default function AppLockGate({ children, onReady }: AppLockGateProps) {
  const insets = useSafeAreaInsets();
  const { colors, leftHandedMode } = useAppTheme();
  const [checkingSettings, setCheckingSettings] = useState(true);
  const [loadError, setLoadError] = useState<ErrorMessage | null>(null);
  const [locked, setLocked] = useState(false);
  // Once the user has unlocked at least once, the app tree stays mounted for
  // the rest of the session and a relock is shown as a Modal on top of it.
  // Unmounting it on relock threw away navigation, open modals and pending
  // picker results — every relock landed back on the home tab.
  const [unlockedOnce, setUnlockedOnce] = useState(false);
  const [stage, setStage] = useState<LockStage>('pin');
  const [pinSettings, setPinSettings] = useState<UserPinSettings | null>(null);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [pin, setPin] = useState('');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [recoveryCodeCopied, setRecoveryCodeCopied] = useState(false);
  // Detail is only set by a failed save, for the status block's Details toggle;
  // every other status line replaces it with none.
  const [status, setStatus] = useState<ErrorMessage>({ message: '' });
  const statusMessage = status.message;
  const setStatusMessage = useCallback(
    (message: string, detail?: string) => setStatus({ detail, message }),
    []
  );
  const [statusVariant, setStatusVariant] = useState<'danger' | 'warning' | 'default'>('default');
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState(0);
  const [verifying, setVerifying] = useState(false);
  // Android draws the caret of an empty, center-aligned TextInput at the far
  // right while a placeholder is set. The placeholder is dropped while a field
  // is focused so the caret sits centred; the stage title above still labels it.
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const focusProps = (field: string, placeholder: string) => ({
    onBlur: () => setFocusedField((current) => (current === field ? null : current)),
    onFocus: () => setFocusedField(field),
    placeholder: focusedField === field ? undefined : placeholder,
  });
  const appStateRef = useRef(AppState.currentState);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // Set when the app went to the background while one of NettKeeping's own system
  // pickers was open (see utils/appLockSuspension); the relock decision is
  // deferred to the return, based on how long the user was away.
  const suspendedBackgroundAtRef = useRef<number | null>(null);

  const loadPinSettings = useCallback(async () => {
    setLoadError(null);

    const result = await getUserPinSettings();

    if (result.Status === 'Success' && result.Data) {
      setPinSettings(result.Data);
      setLocked(result.Data.IsPinEnabled);

      if (result.Data.IsPinEnabled) {
        const recoveryCredentials = await getStoredRecoveryCredentials().catch(() => null);
        setRecoveryAvailable(Boolean(recoveryCredentials));
      }
    } else {
      // Fail closed: without knowing whether a PIN is required, do not let
      // the app content render.
      setLocked(true);
      setLoadError(toErrorMessage(result, 'Failed to load security settings.'));
    }

    setCheckingSettings(false);
    onReady();
  }, [onReady]);

  useEffect(() => {
    loadPinSettings();
  }, [loadPinSettings]);

  // Mid-session reload. Unlike loadPinSettings it never touches `locked`:
  // enabling a PIN in Settings must not lock the screen the user is on, it
  // only arms the relock for the next time the app is backgrounded. On a read
  // failure the current copy is kept rather than failing closed, since the
  // user is already past the lock.
  const refreshPinSettings = useCallback(async () => {
    const result = await getUserPinSettings();

    if (result.Status !== 'Success' || !result.Data) {
      return;
    }

    setPinSettings(result.Data);

    const recoveryCredentials = result.Data.IsPinEnabled
      ? await getStoredRecoveryCredentials().catch(() => null)
      : null;
    setRecoveryAvailable(Boolean(recoveryCredentials));
  }, []);

  useEffect(() => subscribePinSettingsChanged(refreshPinSettings), [refreshPinSettings]);

  useEffect(() => {
    // Gated on checkingSettings: `locked` starts false while settings load,
    // and that must not count as an unlock.
    if (!checkingSettings && !locked) {
      setUnlockedOnce(true);
    }

    // Engaging is also reported synchronously in engageLock; this covers the
    // initial lock and every unlock. Running in an effect means a picker
    // result held by runWithAppLockSuspended is released only after the lock
    // Modal has been removed.
    setAppLockEngaged(locked);
  }, [checkingSettings, locked]);

  useEffect(() => {
    const engageLock = () => {
      setAppLockEngaged(true);
      setLocked(true);
      // An input unmounted while focused never fires onBlur.
      setFocusedField(null);
      // Picks up anything written outside the gate, e.g. failed attempts
      // recorded by the PIN check in App Settings' disable-PIN modal.
      refreshPinSettings();
      setStage('pin');
      setPin('');
      setRecoveryCodeInput('');
      setNewPin('');
      setConfirmNewPin('');
      setNewRecoveryCode(null);
      setRecoveryCodeCopied(false);
      setStatusMessage('');
      setStatusVariant('default');
      setVerifying(false);
    };

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const appWasOpen = appStateRef.current === 'active';
      appStateRef.current = nextAppState;

      if (!pinSettings?.IsPinEnabled) {
        return;
      }

      if (appWasOpen && nextAppState !== 'active') {
        if (isAppLockSuspended() && !lockedRef.current) {
          suspendedBackgroundAtRef.current = Date.now();
          return;
        }

        engageLock();
        return;
      }

      if (nextAppState === 'active' && suspendedBackgroundAtRef.current !== null) {
        const awayMs = Date.now() - suspendedBackgroundAtRef.current;
        suspendedBackgroundAtRef.current = null;

        if (awayMs > appLockSuspensionGraceMs) {
          engageLock();
        }
      }
    });

    return () => subscription.remove();
  }, [pinSettings?.IsPinEnabled, refreshPinSettings]);

  useEffect(() => {
    if (!locked || !pinSettings?.LockedUntil) {
      setLockoutRemainingSeconds(0);
      return;
    }

    const updateRemainingSeconds = () => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil((new Date(pinSettings.LockedUntil ?? '').getTime() - Date.now()) / 1000)
      );

      setLockoutRemainingSeconds(remainingSeconds);

      if (remainingSeconds === 0) {
        setStatusMessage('');
        setPinSettings((current) => (current ? { ...current, LockedUntil: null } : current));
      }
    };

    updateRemainingSeconds();
    const intervalId = setInterval(updateRemainingSeconds, 1000);
    return () => clearInterval(intervalId);
  }, [locked, pinSettings?.LockedUntil]);

  const handleUnlock = async () => {
    if (verifying || !pinSettings) {
      return;
    }

    if (lockoutRemainingSeconds > 0) {
      return;
    }

    if (!pin) {
      setStatusVariant('danger');
      setStatusMessage('PIN is required.');
      return;
    }

    if (!pinSettings.PinHash || !pinSettings.PinSalt || !pinSettings.HashIterations) {
      setStatusVariant('danger');
      setStatusMessage('Saved PIN data could not be loaded.');
      return;
    }

    setStatusMessage('');
    setStatusVariant('default');
    setVerifying(true);

    const pinIsValid = await verifyPinHash(pin, pinSettings.PinHash, pinSettings.PinSalt, pinSettings.HashIterations);

    if (pinIsValid) {
      await clearPinLockout();
      setVerifying(false);
      setLocked(false);
      setPin('');
      return;
    }

    const nextFailedAttemptCount = pinSettings.FailedAttemptCount + 1;
    const shouldLock = nextFailedAttemptCount >= maxFailedPinAttempts;
    const nextLockedUntil = shouldLock ? new Date(Date.now() + pinLockoutSeconds * 1000).toISOString() : null;

    await recordFailedPinAttempt();
    setPinSettings((current) =>
      current
        ? {
            ...current,
            FailedAttemptCount: shouldLock ? 0 : nextFailedAttemptCount,
            LockedUntil: nextLockedUntil,
          }
        : current
    );
    setPin('');
    setVerifying(false);

    if (shouldLock) {
      setStatusVariant('warning');
      setStatusMessage('');
      setLockoutRemainingSeconds(pinLockoutSeconds);
      return;
    }

    const attemptsRemaining = Math.max(0, maxFailedPinAttempts - nextFailedAttemptCount);
    setStatusVariant('danger');
    setStatusMessage(`Incorrect PIN. ${attemptsRemaining} attempts remaining.`);
  };

  const handleBiometricUnlock = async () => {
    if (verifying || !pinSettings?.IsBiometricsEnabled) {
      return;
    }

    setStatusMessage('');
    setStatusVariant('default');
    setVerifying(true);

    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);

    if (!hasHardware || !isEnrolled) {
      setVerifying(false);
      setStatusVariant('danger');
      setStatusMessage('Biometrics are not available on this device.');
      return;
    }

    const authResult = await LocalAuthentication.authenticateAsync({
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      promptMessage: 'Unlock NettKeeping',
    });

    setVerifying(false);

    if (authResult.success) {
      await clearPinLockout();
      setLocked(false);
      setPin('');
      return;
    }

    setStatusVariant('warning');
    setStatusMessage('Biometric authentication was not completed.');
  };

  const switchStage = (nextStage: LockStage) => {
    setStage(nextStage);
    setFocusedField(null);
    setStatusMessage('');
    setStatusVariant('default');
  };

  const handleVerifyRecoveryCode = async () => {
    if (verifying) {
      return;
    }

    if (!recoveryCodeIsValidFormat(recoveryCodeInput)) {
      setStatusVariant('danger');
      setStatusMessage(`Recovery code must be ${recoveryCodeLength} characters.`);
      return;
    }

    setStatusMessage('');
    setStatusVariant('default');
    setVerifying(true);

    const recoveryCredentials = await getStoredRecoveryCredentials().catch(() => null);

    if (!recoveryCredentials) {
      setVerifying(false);
      setStatusVariant('danger');
      setStatusMessage('Saved recovery data could not be loaded.');
      return;
    }

    const codeIsValid = await verifyPinHash(
      recoveryCodeInput,
      recoveryCredentials.hash,
      recoveryCredentials.salt,
      recoveryCredentials.iterations
    );

    setVerifying(false);

    if (codeIsValid) {
      setRecoveryCodeInput('');
      switchStage('newPin');
      return;
    }

    setStatusVariant('danger');
    setStatusMessage('Incorrect recovery code.');
  };

  const handleSaveNewPin = async () => {
    if (verifying) {
      return;
    }

    if (!/^\d{4,12}$/.test(newPin)) {
      setStatusVariant('danger');
      setStatusMessage('PIN must be 4 to 12 digits.');
      return;
    }

    if (newPin !== confirmNewPin) {
      setStatusVariant('danger');
      setStatusMessage('PIN confirmation does not match.');
      return;
    }

    setStatusMessage('');
    setStatusVariant('default');
    setVerifying(true);

    try {
      const { hash, iterations, salt } = await createPinHash(newPin);
      const result = await enableUserPin(hash, salt, defaultPinHashAlgorithm, iterations);

      if (result.Status !== 'Success') {
        setVerifying(false);
        setStatusVariant('danger');
        setStatusMessage(result.Message ?? 'Failed to save the new PIN.', result.Detail);
        return;
      }

      const nextRecoveryCode = generateRecoveryCode();
      const nextRecovery = await createPinHash(nextRecoveryCode);
      await setStoredRecoveryCredentials({
        hash: nextRecovery.hash,
        salt: nextRecovery.salt,
        iterations: nextRecovery.iterations,
      });

      const refreshedSettings = await getUserPinSettings();
      if (refreshedSettings.Status === 'Success' && refreshedSettings.Data) {
        setPinSettings(refreshedSettings.Data);
      }

      setVerifying(false);
      setNewPin('');
      setConfirmNewPin('');
      setNewRecoveryCode(nextRecoveryCode);
      setRecoveryCodeCopied(false);
      setRecoveryAvailable(true);
      switchStage('newRecoveryCode');
    } catch (error) {
      setVerifying(false);
      setStatusVariant('danger');
      const described = describeError(error, 'Failed to save the new PIN.');
      setStatusMessage(described.Message, described.Detail);
    }
  };

  const handleCopyNewRecoveryCode = async () => {
    if (!newRecoveryCode) {
      return;
    }

    await Clipboard.setStringAsync(formatRecoveryCode(newRecoveryCode));
    setRecoveryCodeCopied(true);
  };

  const handleFinishRecovery = () => {
    setNewRecoveryCode(null);
    setRecoveryCodeCopied(false);
    setLocked(false);
    switchStage('pin');
  };

  if (checkingSettings) {
    return null;
  }

  if (loadError) {
    return (
      <View style={[styles.screen, styles.errorScreen, { backgroundColor: colors.background }]}>
        <View style={styles.panel}>
          <Image source={require('@/assets/images/nettkeeping-splash.png')} style={styles.logo} />
          <Text style={styles.title}>Something went wrong</Text>
          <ErrorText
            color={colors.dangerText}
            detail={loadError.detail}
            message="NettKeeping could not load its security settings, so it stays locked to protect your data."
            style={styles.errorBlock}
            textStyle={styles.errorText}
          />
          <Button onPress={loadPinSettings} testID="lock.retry">
            Retry
          </Button>
        </View>
      </View>
    );
  }

  if (!locked) {
    // Same fragment shape as the relocked return below, so React keeps the
    // mounted tree across lock/unlock.
    return (
      <>
        {children}
        {null}
      </>
    );
  }

  // Paired with a looping spinner rather than a dot sequence — see the matching
  // note in appSettings.
  const verifyingLabel =
    stage === 'recovery'
      ? 'Verifying code'
      : stage === 'newPin'
        ? 'Securing PIN'
        : 'Verifying PIN';
  const displayedStatusMessage =
    verifying
      ? verifyingLabel
      : stage === 'pin' && lockoutRemainingSeconds > 0
        ? `Try again in ${lockoutRemainingSeconds} seconds.`
        : statusMessage;
  const statusColor =
    statusVariant === 'danger'
      ? colors.dangerText
      : statusVariant === 'warning'
        ? colors.warningText
        : colors.text;
  // Identical in all three stages, so it is built once here rather than
  // repeated in each branch below.
  const statusBlock = (
    <View style={styles.statusRow}>
      <Text
        style={[
          styles.status,
          { color: statusColor },
          !displayedStatusMessage && styles.hiddenStatus,
        ]}>
        {displayedStatusMessage || ' '}
      </Text>
      {verifying ? <LoadingDots /> : null}
    </View>
  );
  const statusDetail =
    !verifying && status.detail && displayedStatusMessage === statusMessage ? (
      <View style={styles.statusDetail}>
        <DetailToggle align="left" color={statusColor} detail={status.detail} />
      </View>
    ) : null;

  const lockScreen = (
    // 'padding', not 'height', on Android too. 'height' saves the view's height
    // once, on first layout, and sizes itself from that. The relock Modal is
    // mounted while the app is going to the background, so that saved height
    // could be wrong; a keyboard event landing between the saved and the real
    // height then made it shrink, stop overlapping the keyboard, grow back,
    // overlap again... every frame (the lock screen "twitch"). 'padding' never
    // changes the view's own size and never uses a saved height, so it cannot
    // feed back into itself like that.
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: insets.bottom + 24,
            paddingTop: insets.top + 16,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View style={styles.panel}>
          <Image source={require('@/assets/images/nettkeeping-splash.png')} style={styles.logo} />

          {stage === 'pin' ? (
            <>
              <Text style={styles.title}>Enter PIN</Text>
              <TextInput
                accessibilityLabel="PIN"
                testID="lock.pin"
                inputMode="numeric"
                keyboardType="number-pad"
                maxLength={12}
                onChangeText={(value) => setPin(value.replace(/\D/g, ''))}
                onSubmitEditing={handleUnlock}
                {...focusProps('pin', 'PIN')}
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                style={[
                  styles.pinInput,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={pin}
              />
              {statusBlock}
              {statusDetail}
              <View style={[styles.unlockRow, leftHandedMode && styles.unlockRowReversed]}>
                <Pressable
                  accessibilityLabel="Unlock"
                  testID="lock.unlock"
                  accessibilityRole="button"
                  disabled={verifying || lockoutRemainingSeconds > 0}
                  onPress={handleUnlock}
                  style={({ pressed }) => [
                    styles.unlockButton,
                    {
                      backgroundColor: colors.buttonPrimaryBackground,
                      borderColor: colors.buttonPrimaryBorder,
                    },
                    (verifying || lockoutRemainingSeconds > 0) && styles.disabled,
                    pressed && styles.pressed,
                  ]}>
                  <FontAwesome name="unlock" size={26} color={colors.text} />
                </Pressable>

                {pinSettings?.IsBiometricsEnabled ? (
                  <Pressable
                    accessibilityLabel="Unlock with biometrics"
                    testID="lock.biometric"
                    accessibilityRole="button"
                    disabled={verifying}
                    onPress={handleBiometricUnlock}
                    style={({ pressed }) => [
                      styles.unlockButton,
                      {
                        backgroundColor: colors.buttonPrimaryBackground,
                        borderColor: colors.buttonPrimaryBorder,
                      },
                      verifying && styles.disabled,
                      pressed && styles.pressed,
                    ]}>
                    <MaterialIcons name="fingerprint" size={28} color={colors.text} />
                  </Pressable>
                ) : null}
              </View>

              {recoveryAvailable ? (
                <Pressable
                  accessibilityLabel="Forgot PIN"
                  testID="lock.forgot"
                  accessibilityRole="button"
                  disabled={verifying}
                  onPress={() => switchStage('recovery')}
                  style={({ pressed }) => [styles.forgotPinButton, pressed && styles.pressed]}>
                  <Text style={[styles.forgotPinText, { color: colors.textMuted }]}>Forgot PIN?</Text>
                </Pressable>
              ) : null}
            </>
          ) : null}

          {stage === 'recovery' ? (
            <>
              <Text style={styles.title}>Enter Recovery Code</Text>
              <Text style={[styles.helperText, { color: colors.textMuted }]}>
                Enter the recovery code you saved when setting up your PIN.
              </Text>
              <TextInput
                accessibilityLabel="Recovery code"
                testID="lock.recoveryCode"
                autoCapitalize="characters"
                autoCorrect={false}
                // No maxLength: Android applies it natively to the raw paste, before
                // normalizing, so a code pasted with spaces or the display format's
                // invisible break points got cut. Length is enforced by the slice.
                onChangeText={(value) => setRecoveryCodeInput(normalizeRecoveryCode(value).slice(0, recoveryCodeLength))}
                onSubmitEditing={handleVerifyRecoveryCode}
                {...focusProps('recovery', 'XXXX-XXXX-XXXX-XXXX')}
                placeholderTextColor={colors.textMuted}
                style={[
                  styles.pinInput,
                  styles.recoveryInput,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={formatRecoveryCode(recoveryCodeInput)}
              />
              {statusBlock}
              {statusDetail}
              <View style={[styles.unlockRow, leftHandedMode && styles.unlockRowReversed]}>
                <Pressable
                  accessibilityLabel="Verify recovery code"
                  testID="lock.verifyRecovery"
                  accessibilityRole="button"
                  disabled={verifying}
                  onPress={handleVerifyRecoveryCode}
                  style={({ pressed }) => [
                    styles.unlockButton,
                    {
                      backgroundColor: colors.buttonPrimaryBackground,
                      borderColor: colors.buttonPrimaryBorder,
                    },
                    verifying && styles.disabled,
                    pressed && styles.pressed,
                  ]}>
                  <FontAwesome name="check" size={24} color={colors.text} />
                </Pressable>
              </View>
              <Pressable
                accessibilityLabel="Back to PIN entry"
                testID="lock.backToPin"
                accessibilityRole="button"
                disabled={verifying}
                onPress={() => {
                  setRecoveryCodeInput('');
                  switchStage('pin');
                }}
                style={({ pressed }) => [styles.forgotPinButton, pressed && styles.pressed]}>
                <Text style={[styles.forgotPinText, { color: colors.textMuted }]}>Back to PIN entry</Text>
              </Pressable>
            </>
          ) : null}

          {stage === 'newPin' ? (
            <>
              <Text style={styles.title}>Set New PIN</Text>
              <TextInput
                accessibilityLabel="New PIN"
                testID="lock.newPin"
                inputMode="numeric"
                keyboardType="number-pad"
                maxLength={12}
                onChangeText={(value) => setNewPin(value.replace(/\D/g, ''))}
                {...focusProps('newPin', 'New PIN')}
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                style={[
                  styles.pinInput,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={newPin}
              />
              <TextInput
                accessibilityLabel="Confirm new PIN"
                testID="lock.confirmNewPin"
                inputMode="numeric"
                keyboardType="number-pad"
                maxLength={12}
                onChangeText={(value) => setConfirmNewPin(value.replace(/\D/g, ''))}
                onSubmitEditing={handleSaveNewPin}
                {...focusProps('confirmNewPin', 'Confirm new PIN')}
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                style={[
                  styles.pinInput,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={confirmNewPin}
              />
              {statusBlock}
              {statusDetail}
              <View style={[styles.unlockRow, leftHandedMode && styles.unlockRowReversed]}>
                <Pressable
                  accessibilityLabel="Save new PIN"
                  testID="lock.saveNewPin"
                  accessibilityRole="button"
                  disabled={verifying}
                  onPress={handleSaveNewPin}
                  style={({ pressed }) => [
                    styles.unlockButton,
                    {
                      backgroundColor: colors.buttonPrimaryBackground,
                      borderColor: colors.buttonPrimaryBorder,
                    },
                    verifying && styles.disabled,
                    pressed && styles.pressed,
                  ]}>
                  <FontAwesome name="check" size={24} color={colors.text} />
                </Pressable>
              </View>
            </>
          ) : null}

          {stage === 'newRecoveryCode' && newRecoveryCode ? (
            <>
              <Text style={styles.title}>New Recovery Code</Text>
              <Text
                accessibilityLabel="Your new recovery code"
                selectable
                style={[styles.recoveryCodeDisplay, { borderColor: colors.border }]}>
                {formatRecoveryCodeForDisplay(newRecoveryCode)}
              </Text>
              <Text style={[styles.helperText, { color: colors.textMuted }]}>
                Store your recovery code somewhere safe. You can use this in case you forget your access PIN.
              </Text>
              <View style={[styles.unlockRow, leftHandedMode && styles.unlockRowReversed]}>
                <Button onPress={handleCopyNewRecoveryCode} testID="lock.recoveryCopy">
                  {recoveryCodeCopied ? 'Copied!' : 'Copy'}
                </Button>
                <Button onPress={handleFinishRecovery} testID="lock.recoveryDone" variant="primary">
                  Done
                </Button>
              </View>
            </>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  // Cold start: nothing has been unlocked yet, so the app tree is not mounted
  // at all — there is no state to preserve.
  if (!unlockedOnce) {
    return lockScreen;
  }

  // Relock: must be an RN Modal, not an overlay View. Any Modal the app has
  // open is its own native window and would draw above a View, showing its
  // contents without a PIN. Mounting this Modal when the lock engages makes it
  // the newest window, so it sits on top of anything already open. Back is
  // swallowed by the no-op onRequestClose so it cannot dismiss the lock.
  // Both *Translucent props extend it under the system bars (without them the
  // app showed through there); lockScreen already pads by the safe-area insets.
  return (
    <>
      {children}
      <Modal
        animationType="none"
        navigationBarTranslucent
        onRequestClose={() => {}}
        statusBarTranslucent
        visible>
        {lockScreen}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  hiddenStatus: {
    opacity: 0,
  },
  panel: {
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: 360,
    paddingHorizontal: 20,
    width: '100%',
  },
  disabled: {
    opacity: 0.55,
  },
  errorScreen: {
    justifyContent: 'center',
  },
  errorBlock: {
    marginBottom: 20,
  },
  errorText: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  forgotPinButton: {
    marginTop: 20,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  forgotPinText: {
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  helperText: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    textAlign: 'center',
  },
  logo: {
    height: 104,
    marginBottom: 18,
    resizeMode: 'contain',
    width: 104,
  },
  pinInput: {
    alignSelf: 'stretch',
    borderRadius: 5,
    borderWidth: 1,
    fontSize: 22,
    height: 54,
    includeFontPadding: true,
    lineHeight: 30,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 0,
    textAlign: 'center',
    textAlignVertical: 'center',
  },
  pressed: {
    opacity: 0.65,
  },
  recoveryCodeDisplay: {
    borderRadius: 6,
    borderWidth: 1,
    fontSize: 20,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1.5,
    marginBottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlign: 'center',
  },
  recoveryInput: {
    fontSize: 18,
    letterSpacing: 1.5,
  },
  screen: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  status: {
    // See the matching note in appSettings: shrink, do not stretch, or the
    // dots end up detached at the far edge of the row.
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 20,
    minHeight: 20,
  },
  // The spacing that used to sit on the text now sits on the row, so the
  // spinner and the label stay vertically centred against each other.
  statusDetail: {
    marginBottom: 12,
    marginTop: -8,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 12,
    minHeight: 20,
  },
  title: {
    fontSize: 30,
    fontWeight: '400',
    marginBottom: 24,
    textAlign: 'center',
  },
  unlockButton: {
    alignItems: 'center',
    borderRadius: 27,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  unlockRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'center',
  },
  unlockRowReversed: {
    flexDirection: 'row-reverse',
  },
});
