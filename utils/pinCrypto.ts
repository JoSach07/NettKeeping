import * as Crypto from 'expo-crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { hasNativePbkdf2, pbkdf2Sha256 } from '@/utils/pbkdf2';

// Iteration count for NEW PIN and recovery-code hashes, picked by which PBKDF2
// implementation this build has (see utils/pbkdf2.ts). 100k native is ~50-500
// ms depending on the phone; 2,500 is what pure JS on Hermes can afford
// (~165 ms on a flagship). Existing hashes keep verifying at whatever count
// they were made with, because each stores its own — so changing these never
// locks anyone out. An old 2,500 hash only moves to 100k when the PIN is set
// again.
//
// The PIN only guards against casual access on an unlocked phone; the
// lockout, not the KDF, is what stops guessing. So the native count is set for
// a quick unlock, not maximum cost.
const nativePinHashIterations = 100_000;
const jsPinHashIterations = 2_500;

export const getPinHashIterations = () =>
  hasNativePbkdf2() ? nativePinHashIterations : jsPinHashIterations;

const pinSaltBytes = 16;
const pinHashBytes = 32;

// Returns the iteration count it actually used. Callers must store THAT, not
// a constant, so the stored count can never drift from the hash it describes.
export const createPinHash = async (pin: string, iterations = getPinHashIterations()) => {
  const salt = Crypto.getRandomBytes(pinSaltBytes);
  const hash = await pbkdf2Sha256(pin, salt, iterations, pinHashBytes);

  return {
    hash: bytesToHex(hash),
    iterations,
    salt: bytesToHex(salt),
  };
};

export const verifyPinHash = async (pin: string, hash: string, salt: string, iterations: number) => {
  const nextHash = await pbkdf2Sha256(pin, hexToBytes(salt), iterations, pinHashBytes);

  return bytesToHex(nextHash) === hash;
};

export const recoveryCodeLength = 16;

// Crockford base32: no I, L, O, or U, so codes stay unambiguous when written
// down. 32 characters means each random byte maps without modulo bias.
const recoveryCodeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const generateRecoveryCode = (): string => {
  const bytes = Crypto.getRandomBytes(recoveryCodeLength);
  let code = '';

  for (let index = 0; index < recoveryCodeLength; index++) {
    code += recoveryCodeAlphabet[bytes[index] & 31];
  }

  return code;
};

export const formatRecoveryCode = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');

// For on-screen display only (never for copying): a zero-width space after
// each dash lets a narrow screen wrap between whole groups ("ABCD-ABCD-" /
// "ABCD-ABCD"). Without it Android may refuse to break at a dash before a
// digit and split a group instead.
export const formatRecoveryCodeForDisplay = (code: string): string => formatRecoveryCode(code).replace(/-/g, '-\u200B');

// Accepts codes pasted or typed with any spacing/dashes, in any case, and
// maps the characters the alphabet deliberately excludes to their lookalikes.
export const normalizeRecoveryCode = (input: string): string =>
  input
    .toUpperCase()
    // \u200B: the display format's invisible break point, if the code was
    // selected and copied by hand. JS's \s does not match it.
    .replace(/[\s\u200B-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

export const recoveryCodeIsValidFormat = (code: string): boolean =>
  code.length === recoveryCodeLength && [...code].every((char) => recoveryCodeAlphabet.includes(char));
