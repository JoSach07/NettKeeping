import { useEffect } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

// When the soft keyboard is closed without leaving the field (the nav bar's
// Back / "V" button), Android keeps the TextInput focused. On Android 10 and
// older (API < 30) React Native's ScrollView then still treats the keyboard as
// open (it ignores keyboard events there as unreliable), so with
// keyboardShouldPersistTaps="handled" the next tap is spent blurring the field
// instead of reaching the button under the finger — Save needs two taps.
//
// Blurring the focused input as soon as the keyboard hides removes that state
// for every screen at once. Mounted once, in the root layout.
export function useBlurInputOnKeyboardHide() {
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const subscription = Keyboard.addListener('keyboardDidHide', () => {
      TextInput.State.currentlyFocusedInput()?.blur();
    });
    return () => subscription.remove();
  }, []);
}
