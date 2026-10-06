// AppLockGate loads UserPinSettings once at startup and keeps its own copy.
// Anything that changes those settings mid-session (App Settings enabling or
// disabling the PIN, toggling biometrics, importing a backup that replaces the
// table) calls notifyPinSettingsChanged so the gate reloads them. Without it
// the gate kept the startup copy: a PIN enabled in Settings did not lock the
// app until a restart, and a new PIN was checked against the old hash.

type Listener = () => void;

const listeners = new Set<Listener>();

export const subscribePinSettingsChanged = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyPinSettingsChanged = () => {
  listeners.forEach((listener) => listener());
};
