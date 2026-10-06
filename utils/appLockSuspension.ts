// NettKeeping's own system pickers (file picker, folder picker, device-credential
// prompt) run as separate Android activities on top of NettKeeping's. React Native
// reports that as AppState 'background', which AppLockGate would otherwise
// treat as the user leaving the app and relock on.
//
// Wrapping those calls in runWithAppLockSuspended tells the gate the
// background is expected. The gate then skips the relock only if the user is
// back within appLockSuspensionGraceMs — if they wander off from inside the
// picker (home button, another app) and return later, it still locks.
//
// The wrapper also holds the task's result until the app is unlocked. When the
// grace window was exceeded, the lock screen is showing by the time the picker
// returns, and whatever the caller does next (e.g. opening the backup-import
// Modal) would otherwise open a NEW RN Modal — a newer native window that
// draws ABOVE the lock screen's Modal and exposes the app without a PIN.

export const appLockSuspensionGraceMs = 60_000;

let activeSuspensions = 0;
let appLockEngaged = false;
const unlockWaiters = new Set<() => void>();

export const isAppLockSuspended = () => activeSuspensions > 0;

// Called by AppLockGate: synchronously when it engages the lock, and from an
// effect after the lock screen has been removed when it disengages.
export const setAppLockEngaged = (engaged: boolean) => {
  appLockEngaged = engaged;

  if (!engaged && unlockWaiters.size > 0) {
    const waiters = [...unlockWaiters];
    unlockWaiters.clear();
    waiters.forEach((resolve) => resolve());
  }
};

const waitForUnlock = () =>
  appLockEngaged
    ? new Promise<void>((resolve) => {
        unlockWaiters.add(resolve);
      })
    : Promise.resolve();

export const runWithAppLockSuspended = async <T>(task: () => Promise<T>): Promise<T> => {
  activeSuspensions += 1;

  try {
    return await task();
  } finally {
    activeSuspensions -= 1;
    await waitForUnlock();
  }
};
