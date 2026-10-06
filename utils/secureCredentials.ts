import * as SecureStore from 'expo-secure-store';

const pinHashKey = 'nettkeeping.pin.hash';
const pinSaltKey = 'nettkeeping.pin.salt';
const recoveryCredentialsKey = 'nettkeeping.recovery.credentials';

export interface RecoveryCredentials {
  hash: string;
  salt: string;
  iterations: number;
}

export const getStoredPinCredentials = async (): Promise<{ hash: string; salt: string } | null> => {
  const [hash, salt] = await Promise.all([
    SecureStore.getItemAsync(pinHashKey),
    SecureStore.getItemAsync(pinSaltKey),
  ]);

  return hash && salt ? { hash, salt } : null;
};

export const setStoredPinCredentials = async (hash: string, salt: string): Promise<void> => {
  await SecureStore.setItemAsync(pinHashKey, hash);
  await SecureStore.setItemAsync(pinSaltKey, salt);
};

export const clearStoredPinCredentials = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(pinHashKey);
  await SecureStore.deleteItemAsync(pinSaltKey);
};

export const getStoredRecoveryCredentials = async (): Promise<RecoveryCredentials | null> => {
  const raw = await SecureStore.getItemAsync(recoveryCredentialsKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryCredentials>;
    return parsed.hash && parsed.salt && parsed.iterations
      ? { hash: parsed.hash, salt: parsed.salt, iterations: parsed.iterations }
      : null;
  } catch {
    return null;
  }
};

export const setStoredRecoveryCredentials = async (credentials: RecoveryCredentials): Promise<void> => {
  await SecureStore.setItemAsync(recoveryCredentialsKey, JSON.stringify(credentials));
};

export const clearStoredRecoveryCredentials = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(recoveryCredentialsKey);
};
