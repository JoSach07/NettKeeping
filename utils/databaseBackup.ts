import { File, FileMode } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from 'expo-crypto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  getSerializedDatabase,
  replaceDatabaseWithSerializedBytes,
} from '@/database/dbService';
import { getAppSettings, updateExportDirectory } from '@/database/tables/appSettings';
import { runWithAppLockSuspended } from '@/utils/appLockSuspension';
import { getConfiguredExportDirectory } from '@/utils/exportDirectory';
import { hasNativePbkdf2, pbkdf2Sha256 } from '@/utils/pbkdf2';
import { describeError, describeFileReadError, isAppOwnedDocumentType, UserFacingError } from '@/utils/userFacingError';

const backupFormat = 'nettkeeping-database-backup';
// A backup is a one-line JSON header, a 0x0a separator, then the raw
// ciphertext. Keeping the ciphertext binary rather than base64 inside the JSON
// keeps the file ~25% smaller, removes the decode step entirely, and lets the
// import read it as a view over the file bytes instead of a copy.
// Reset to 1 when the schema was squashed before the first public release.
// Bump it whenever a backup from the previous version could not be restored
// as-is; never reset it again.
const backupVersion = 1;
const backupExtension = 'nettkeepingbackup';
// No longer JSON — the bulk of the file is binary.
const backupMimeType = 'application/octet-stream';
const headerSeparatorByte = 0x0a;
// The header is a fixed set of short fields; 1KB is far more than it can reach
// and bounds how much of an unknown file is read while validating a pick.
const maxHeaderBytes = 1024;
// Iteration count for NEW backups, picked by which PBKDF2 implementation this
// build has (see utils/pbkdf2.ts). 600k native matches current OWASP guidance
// for PBKDF2-SHA256; pure JS on Hermes stays at 210k (~14 s) because 600k
// would take ~40 s. Import always uses the count in the file's header, so
// backups from either kind of build stay importable in both — a 600k backup
// imported into Expo Go just takes that ~40 s.
const nativeKdfIterations = 600_000;
const jsKdfIterations = 210_000;
const getKdfIterations = () => (hasNativePbkdf2() ? nativeKdfIterations : jsKdfIterations);
const kdfSaltBytes = 16;
const aesKeyBytes = 32;
const aesIvBytes = 12;
const aesTagBytes = 16;
// Measured against this schema: 10,000 transactions is ~0.8MB as a backup file and
// 100,000 is ~7.6MB, so 32MB is roughly 420,000 transactions of headroom. The cap
// exists to stop an arbitrary pick — the picker accepts any file type — from
// being read into the JS heap before anything can reject it. Importing expands
// a backup several times over (JSON text, the base64 string, its bytes, then
// the decrypted database), so peak memory is a few times this number.
const maxBackupFileBytes = 32 * 1024 * 1024;

const assertReadableBackupSize = (sizeInBytes: number) => {
  // size is 0 for a file that does not exist or cannot be read, and a real
  // backup is never empty, so both cases fail here.
  if (sizeInBytes <= 0) {
    throw new UserFacingError('This file is empty or cannot be read.');
  }

  if (sizeInBytes > maxBackupFileBytes) {
    throw new UserFacingError('This file is larger than NettKeeping can import.');
  }
};

// The header is machine-generated and ASCII-only: a fixed format string, an
// ISO timestamp, a hex salt and numbers. A byte-per-character conversion is
// therefore exact, and avoids depending on TextEncoder/TextDecoder, which
// Hermes does not reliably provide.
const decodeAsciiHeader = (bytes: Uint8Array) => {
  let text = '';

  for (let index = 0; index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }

  return text;
};

const encodeAsciiHeader = (text: string) => {
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    const charCode = text.charCodeAt(index);

    if (charCode > 0x7f) {
      // Cannot happen with the fields above, but a silent truncation here would
      // write a corrupt header that only fails at restore time.
      throw new Error('Backup header contains a non-ASCII character.');
    }

    bytes[index] = charCode;
  }

  return bytes;
};

type BackupHeader = {
  cipher: {
    name: 'AES-256-GCM';
    ivLength: number;
    tagLength: 16;
  };
  createdAt: string;
  format: typeof backupFormat;
  kdf: {
    iterations: number;
    name: 'PBKDF2-SHA256';
    salt: string;
  };
  version: typeof backupVersion;
};

type BackupResult = {
  // Raw technical text for the popup's Details toggle. Present only when
  // Message is a generic stand-in for an internal failure.
  Detail?: string;
  Message?: string;
  Status: 'Success' | 'Error' | 'Cancelled';
  Uri?: string;
};

const getBackupPasswordKey = async (password: string, salt: Uint8Array, iterations: number) => {
  const keyBytes = await pbkdf2Sha256(password, salt, iterations, aesKeyBytes);

  return AESEncryptionKey.import(keyBytes);
};

const getBackupFileName = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-');

  return `nettkeeping-backup-${timestamp}.${backupExtension}`;
};

// Splits the leading header line off a run of file bytes. Works on a 1KB probe
// as well as on the whole file, so the pick path and the import path share it.
const readHeaderText = (bytes: Uint8Array) => {
  const separatorIndex = bytes.indexOf(headerSeparatorByte);

  if (separatorIndex < 0 || separatorIndex > maxHeaderBytes) {
    throw new UserFacingError('This file is not a NettKeeping backup.');
  }

  return { headerText: decodeAsciiHeader(bytes.subarray(0, separatorIndex)), separatorIndex };
};

// Each rejection carries its own message. The cases mean different things to
// the user: a foreign file is their mistake, a version mismatch is NettKeeping's,
// and a damaged file means the backup itself is no longer usable.
const parseBackupHeader = (headerText: string): BackupHeader => {
  let parsed: Partial<BackupHeader>;

  try {
    parsed = JSON.parse(headerText) as Partial<BackupHeader>;
  } catch {
    throw new UserFacingError('This file is not a NettKeeping backup.');
  }

  if (parsed?.format !== backupFormat) {
    throw new UserFacingError('This file is not a NettKeeping backup.');
  }

  if (parsed.version !== backupVersion) {
    throw new UserFacingError(
      typeof parsed.version === 'number' && parsed.version > backupVersion
        ? 'This backup was made by a newer version of NettKeeping. Update NettKeeping to import it.'
        : 'This backup was made by a version of NettKeeping that is no longer supported.'
    );
  }

  if (
    parsed.kdf?.name !== 'PBKDF2-SHA256' ||
    parsed.cipher?.name !== 'AES-256-GCM' ||
    !parsed.kdf.salt ||
    !parsed.cipher.ivLength ||
    !parsed.cipher.tagLength
  ) {
    throw new UserFacingError('This NettKeeping backup is incomplete or damaged.');
  }

  return parsed as BackupHeader;
};

// AES-GCM rejects a wrong key at its authentication tag check, which in
// practice means a mistyped password. Scoped to the decrypt call alone so an
// unrelated failure is never reported as a bad password.
const decryptSealedBackup = async (sealedData: AESSealedData, key: AESEncryptionKey) => {
  try {
    return await aesDecryptAsync(sealedData, key);
  } catch {
    throw new UserFacingError('Incorrect backup password.');
  }
};

export const exportEncryptedDatabaseBackup = async (password: string): Promise<BackupResult> => {
  try {
    const directory = await getConfiguredExportDirectory();
    const serializedDatabase = await getSerializedDatabase();
    const salt = Crypto.getRandomBytes(kdfSaltBytes);
    const kdfIterations = getKdfIterations();
    const key = await getBackupPasswordKey(password, salt, kdfIterations);
    const sealedData = await aesEncryptAsync(serializedDatabase, key, {
      nonce: { length: aesIvBytes },
      tagLength: aesTagBytes,
    });
    const backupHeader: BackupHeader = {
      cipher: {
        name: 'AES-256-GCM',
        ivLength: aesIvBytes,
        tagLength: aesTagBytes,
      },
      createdAt: new Date().toISOString(),
      format: backupFormat,
      kdf: {
        iterations: kdfIterations,
        name: 'PBKDF2-SHA256',
        salt: bytesToHex(salt),
      },
      version: backupVersion,
    };
    // 'bytes' rather than 'base64': the ciphertext goes into the file as-is.
    const cipherBytes = await sealedData.combined('bytes');
    const headerBytes = encodeAsciiHeader(JSON.stringify(backupHeader));
    const fileBytes = new Uint8Array(headerBytes.length + 1 + cipherBytes.length);

    fileBytes.set(headerBytes, 0);
    fileBytes[headerBytes.length] = headerSeparatorByte;
    fileBytes.set(cipherBytes, headerBytes.length + 1);

    const outputFile = directory.createFile(getBackupFileName(), backupMimeType);

    outputFile.write(fileBytes);

    return {
      Status: 'Success',
      Uri: outputFile.uri,
    };
  } catch (error) {
    // getConfiguredExportDirectory throws messages written for the user, so
    // those pass through; a native or storage failure gets the fallback, with
    // the raw text carried in Detail rather than concatenated into the popup.
    return {
      Status: 'Error',
      ...describeError(error, 'Failed to export database backup.'),
    };
  }
};

// A backup is a binary file that no cloud app converts into its own document
// format, so an app-owned (virtual) document here can only be a wrong pick.
// It gets the same message as any other wrong file rather than a read error.
const notABackupMessage = 'This file is not a NettKeeping backup.';

export const selectEncryptedDatabaseBackup = async (): Promise<BackupResult> => {
  try {
    const pickedFile = await runWithAppLockSuspended(() =>
      File.pickFileAsync({
        mimeTypes: ['application/json', 'application/octet-stream', '*/*'],
      })
    );

    if (pickedFile.canceled) {
      return {
        Status: 'Cancelled',
      };
    }

    // Size is checked before anything is read, since the picker accepts any
    // file type. Only the header is then read — a 1KB probe rather than the
    // whole file, which is read once later if the user goes on to import.
    if (isAppOwnedDocumentType(pickedFile.result.type)) {
      throw new UserFacingError(notABackupMessage);
    }

    assertReadableBackupSize(pickedFile.result.size);

    const handle = pickedFile.result.open(FileMode.ReadOnly);

    try {
      parseBackupHeader(readHeaderText(handle.readBytes(maxHeaderBytes)).headerText);
    } finally {
      handle.close();
    }

    return {
      Status: 'Success',
      Uri: pickedFile.result.uri,
    };
  } catch (error) {
    return {
      Status: 'Error',
      ...describeFileReadError(error, 'Selected file could not be read.', notABackupMessage),
    };
  }
};

export const importEncryptedDatabaseBackup = async (
  backupUri: string,
  password: string
): Promise<BackupResult> => {
  try {
    // Re-checked here rather than trusted from the pick: the file is read a
    // second time, and nothing guarantees it is the same file it was then.
    const backupSourceFile = new File(backupUri);

    assertReadableBackupSize(backupSourceFile.size);

    const backupBytes = await backupSourceFile.bytes();
    const { headerText, separatorIndex } = readHeaderText(backupBytes);
    const backupHeader = parseBackupHeader(headerText);
    const key = await getBackupPasswordKey(
      password,
      hexToBytes(backupHeader.kdf.salt),
      backupHeader.kdf.iterations
    );
    // subarray, not slice: this is a view over the bytes already in memory, so
    // the ciphertext is never copied.
    const cipherBytes = backupBytes.subarray(separatorIndex + 1);

    if (cipherBytes.length <= backupHeader.cipher.ivLength + backupHeader.cipher.tagLength) {
      throw new UserFacingError('This NettKeeping backup is incomplete or damaged.');
    }

    const sealedData = AESSealedData.fromCombined(cipherBytes, {
      ivLength: backupHeader.cipher.ivLength,
      tagLength: backupHeader.cipher.tagLength,
    });
    const serializedDatabase = await decryptSealedBackup(sealedData, key);
    // Read before the swap: the SAF grant belongs to this installation, not to
    // the database, so the imported row's directory is a URI this device has no
    // permission for. Capturing the local one here lets it be restored below
    // instead of clearing the setting and making the user pick a folder again
    // after every single import.
    const localSettingsResult = await getAppSettings();
    const localExportDirectory =
      localSettingsResult.Status === 'Success'
        ? {
            name: localSettingsResult.Data.ExportDirectoryName,
            uri: localSettingsResult.Data.ExportDirectoryUri,
          }
        : null;
    const importResult = await replaceDatabaseWithSerializedBytes(serializedDatabase);

    if (importResult.Status !== 'Success') {
      return {
        Status: 'Error',
        // Detail forwarded rather than dropped: the database swap is where a
        // failure is most opaque, and its raw cause is the useful part.
        Detail: importResult.Detail,
        Message: importResult.Message ?? 'Failed to import database backup.',
      };
    }

    // Always overwrite what the imported database carried. Falling back to null
    // when the local settings could not be read is the safe direction: an empty
    // setting only costs a pick, while keeping the source device's URI would
    // leave exports pointing at a folder this install cannot write to.
    await updateExportDirectory(
      localExportDirectory?.uri ?? null,
      localExportDirectory?.name ?? null
    );

    return {
      Status: 'Success',
      Uri: backupUri,
    };
  } catch (error) {
    return {
      Status: 'Error',
      ...describeFileReadError(error, 'Failed to import database backup.', notABackupMessage),
    };
  }
};
