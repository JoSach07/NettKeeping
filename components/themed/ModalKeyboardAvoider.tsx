import { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TurboModuleRegistry } from 'react-native';

type DeviceInfoModule = {
  getConstants?: () => { isEdgeToEdge?: boolean };
};

// Whether React Native runs this app edge-to-edge — RN's DeviceInfo constant,
// the same check react-native-is-edge-to-edge uses. Fixed for the life of the
// process, so it is read once.
//
// Why it matters for modals: with edge-to-edge on, RN makes every Modal window
// edge-to-edge as well (ReactModalHostView). The window still asks for
// SOFT_INPUT_ADJUST_RESIZE, but an edge-to-edge window is not resized for the
// keyboard; the keyboard simply draws over it. Builds (EAS/APK) on SDK 56 are
// always edge-to-edge. Expo Go is not, and there Android does shrink the
// Modal window.
const getDeviceInfo = TurboModuleRegistry.get as (name: string) => DeviceInfoModule | null;
const isEdgeToEdge = Platform.OS === 'android' && getDeviceInfo('DeviceInfo')?.getConstants?.().isEdgeToEdge === true;

type ModalKeyboardAvoiderProps = {
  children: ReactNode;
};

// Wrap the content of every Modal that has a text input with this, directly
// inside <Modal>. When the Modal window is NOT resized for the keyboard
// (edge-to-edge), it adds bottom padding the height of the keyboard, so the
// backdrop inside shrinks as if the window had been resized: the panel's
// flexShrink/maxHeight and useKeepFocusedInputVisible then behave the same as
// in Expo Go. When the window IS resized (not edge-to-edge), it renders the
// children untouched: padding there as well makes room twice and the panel
// visibly moves twice (seen in Expo Go, 2026-09-29).
//
// 'padding', not 'height': see the lock screen note in AppLockGate.
export default function ModalKeyboardAvoider({ children }: ModalKeyboardAvoiderProps) {
  if (!isEdgeToEdge) {
    return <>{children}</>;
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
