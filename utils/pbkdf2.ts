import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { pbkdf2 as noblePbkdf2, pbkdf2Async as noblePbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

// PBKDF2-SHA256 provider. Uses react-native-quick-crypto (native OpenSSL,
// runs off the JS thread) when its native module is present — dev builds and
// release APKs — and falls back to pure-JS @noble/hashes everywhere else:
// Expo Go, web, or a build where the native module failed to load.
//
// Both produce identical output for the same inputs, so a hash or backup made
// on one side verifies on the other. The only difference is speed: roughly two
// orders of magnitude, which is why callers pick their iteration count from
// hasNativePbkdf2() rather than using one fixed number.

type NativePbkdf2Callback = (error: Error | null, derivedKey?: Uint8Array) => void;

type NativeQuickCrypto = {
  pbkdf2: (
    password: string | Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    callback: NativePbkdf2Callback
  ) => void;
  pbkdf2Sync: (
    password: string | Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string
  ) => Uint8Array;
};

let nativeQuickCrypto: NativeQuickCrypto | null | undefined;

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const loadNativeQuickCrypto = (): NativeQuickCrypto | null => {
  // Expo Go has no Nitro modules. Checked first so Expo Go never even
  // evaluates the package, rather than relying on the require below throwing.
  if (Platform.OS === 'web' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    return null;
  }

  try {
    // Required lazily, never imported at the top level: evaluating the package
    // without its native module throws, and a top-level import would take the
    // whole app down with it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const quickCrypto = require('react-native-quick-crypto') as NativeQuickCrypto;

    // Known-answer check at 1 iteration against the JS implementation. Catches
    // both a module that loads but fails on first call, and any encoding
    // difference that would make native hashes unverifiable from Expo Go.
    const probeSalt = new Uint8Array([109, 111, 110, 101, 108, 121, 45, 112, 114, 111, 98, 101]);
    const nativeProbe = quickCrypto.pbkdf2Sync('nettkeeping-probe-ü', probeSalt, 1, 32, 'sha256');
    const jsProbe = noblePbkdf2(sha256, 'nettkeeping-probe-ü', probeSalt, { c: 1, dkLen: 32 });

    if (!bytesEqual(Uint8Array.from(nativeProbe), jsProbe)) {
      console.warn('react-native-quick-crypto PBKDF2 output mismatch; using the JS implementation.');
      return null;
    }

    return quickCrypto;
  } catch (error) {
    console.warn('react-native-quick-crypto unavailable; using the JS PBKDF2 implementation.', error);
    return null;
  }
};

const getNativeQuickCrypto = () => {
  if (nativeQuickCrypto === undefined) {
    nativeQuickCrypto = loadNativeQuickCrypto();
  }

  return nativeQuickCrypto;
};

export const hasNativePbkdf2 = () => getNativeQuickCrypto() !== null;

export const pbkdf2Sha256 = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
  dkLen: number
): Promise<Uint8Array> => {
  const quickCrypto = getNativeQuickCrypto();

  if (quickCrypto) {
    return new Promise((resolve, reject) => {
      quickCrypto.pbkdf2(password, salt, iterations, dkLen, 'sha256', (error, derivedKey) => {
        if (error || !derivedKey) {
          reject(error ?? new Error('PBKDF2 returned no key.'));
          return;
        }

        // Copy out of the library's Buffer into a plain Uint8Array, which is
        // what every caller (hex encoding, AESEncryptionKey.import) expects.
        resolve(Uint8Array.from(derivedKey));
      });
    });
  }

  return noblePbkdf2Async(sha256, password, salt, {
    asyncTick: 10,
    c: iterations,
    dkLen,
  });
};
