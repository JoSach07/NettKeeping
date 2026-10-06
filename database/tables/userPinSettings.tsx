import { describeError } from '@/utils/userFacingError';

import { getDBConnection, GetResult, InsertOrUpdateResult } from "../dbService";
import {
    clearStoredPinCredentials,
    clearStoredRecoveryCredentials,
    getStoredPinCredentials,
    setStoredPinCredentials,
} from '@/utils/secureCredentials';

export const pinLockoutSeconds = 30;
export const maxFailedPinAttempts = 3;
export const defaultPinHashAlgorithm = 'PBKDF2-SHA256';

export interface UserPinSettings {
    Id: 1;
    IsPinEnabled: boolean;
    // Loaded from the device secure store, not the database.
    PinHash: string | null;
    PinSalt: string | null;
    HashAlgorithm: string;
    // The count the stored hash was made with (picked per build by
    // createPinHash in utils/pinCrypto.ts). Null while no PIN is set.
    HashIterations: number | null;
    FailedAttemptCount: number;
    LockedUntil: string | null;
    IsBiometricsEnabled: boolean;
}

type UserPinSettingsRow = Omit<UserPinSettings, 'IsPinEnabled' | 'IsBiometricsEnabled' | 'PinHash' | 'PinSalt'> & {
    IsPinEnabled: number;
    IsBiometricsEnabled: number;
};

export interface GetUserPinSettingsResult extends GetResult {
    Data: UserPinSettings | null;
}

export const defaultUserPinSettings: UserPinSettings = {
    Id: 1,
    IsPinEnabled: false,
    PinHash: null,
    PinSalt: null,
    HashAlgorithm: defaultPinHashAlgorithm,
    HashIterations: null,
    FailedAttemptCount: 0,
    LockedUntil: null,
    IsBiometricsEnabled: false,
};

const normalizeUserPinSettings = (
    settings: UserPinSettingsRow | null | undefined,
    credentials: { hash: string; salt: string } | null
): UserPinSettings => ({
    ...defaultUserPinSettings,
    ...settings,
    Id: 1,
    IsPinEnabled: Boolean(settings?.IsPinEnabled),
    IsBiometricsEnabled: Boolean(settings?.IsBiometricsEnabled),
    PinHash: credentials?.hash ?? null,
    PinSalt: credentials?.salt ?? null,
});

export const getUserPinSettings = async (): Promise<GetUserPinSettingsResult> => {
    try {
        const _db = await getDBConnection();

        const settings = await _db.getFirstAsync<UserPinSettingsRow>('SELECT * FROM UserPinSettings WHERE Id = 1');
        const credentials = await getStoredPinCredentials();

        // A backup made on this schema does not contain the PIN hash (it lives
        // in the device secure store), so after importing one on a device
        // without matching credentials the PIN cannot be verified. Reset it so
        // the user is not locked out; the backup file itself stays protected
        // by its password.
        if (settings && Boolean(settings.IsPinEnabled) && !credentials) {
            await _db.runAsync(
                `UPDATE UserPinSettings
                    SET IsPinEnabled = 0,
                        IsBiometricsEnabled = 0,
                        HashIterations = NULL,
                        FailedAttemptCount = 0,
                        LockedUntil = NULL
                    WHERE Id = 1`
            );
            await clearStoredRecoveryCredentials().catch(() => undefined);

            return {
                Status: "Success",
                Message: 'PIN was reset because its stored credentials were not found on this device. Set it up again in App Settings.',
                Data: normalizeUserPinSettings(
                    { ...settings, IsPinEnabled: 0, IsBiometricsEnabled: 0, HashIterations: null, FailedAttemptCount: 0, LockedUntil: null },
                    null
                ),
            };
        }

        return {
            Status: "Success",
            Data: normalizeUserPinSettings(settings, credentials),
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Unable to load security settings.'),
            Data: null,
        };
    }
}

export const enableUserPin = async (
    pinHash: string,
    pinSalt: string,
    hashAlgorithm: string = defaultPinHashAlgorithm,
    // Required: must be the count the hash was actually made with.
    hashIterations: number
): Promise<InsertOrUpdateResult> => {
    try {
        const _db = await getDBConnection();
        await setStoredPinCredentials(pinHash, pinSalt);
        await _db.runAsync(
            `UPDATE UserPinSettings
                SET IsPinEnabled = 1,
                    HashAlgorithm = ?,
                    HashIterations = ?,
                    FailedAttemptCount = 0,
                    LockedUntil = NULL
                WHERE Id = 1`,
            [hashAlgorithm, hashIterations]
        );

        return {
            Status: "Success",
            DataId: 1,
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to enable PIN.'),
        };
    }
}

export const disableUserPin = async (): Promise<InsertOrUpdateResult> => {
    try {
        const _db = await getDBConnection();
        await _db.runAsync(
            `UPDATE UserPinSettings
                SET IsPinEnabled = 0,
                    HashIterations = NULL,
                    FailedAttemptCount = 0,
                    LockedUntil = NULL,
                    IsBiometricsEnabled = 0
                WHERE Id = 1`
        );
        await clearStoredPinCredentials();
        await clearStoredRecoveryCredentials();

        return {
            Status: "Success",
            DataId: 1,
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to disable PIN.'),
        };
    }
}

export const updateBiometricsEnabled = async (isBiometricsEnabled: boolean): Promise<InsertOrUpdateResult> => {
    try {
        const _db = await getDBConnection();
        await _db.runAsync(
            'UPDATE UserPinSettings SET IsBiometricsEnabled = ? WHERE Id = 1',
            [isBiometricsEnabled ? 1 : 0]
        );

        return {
            Status: "Success",
            DataId: 1,
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to update biometrics setting.'),
        };
    }
}

export const recordFailedPinAttempt = async (): Promise<InsertOrUpdateResult> => {
    try {
        const _db = await getDBConnection();
        const settings = await _db.getFirstAsync<UserPinSettingsRow>('SELECT * FROM UserPinSettings WHERE Id = 1');
        const failedAttemptCount = (settings?.FailedAttemptCount ?? 0) + 1;
        const lockedUntil =
            failedAttemptCount >= maxFailedPinAttempts
                ? new Date(Date.now() + pinLockoutSeconds * 1000).toISOString()
                : null;

        await _db.runAsync(
            `UPDATE UserPinSettings
                SET FailedAttemptCount = ?,
                    LockedUntil = ?
                WHERE Id = 1`,
            [failedAttemptCount >= maxFailedPinAttempts ? 0 : failedAttemptCount, lockedUntil]
        );

        return {
            Status: "Success",
            DataId: 1,
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to record the PIN attempt.'),
        };
    }
}

export const clearPinLockout = async (): Promise<InsertOrUpdateResult> => {
    try {
        const _db = await getDBConnection();
        await _db.runAsync(
            `UPDATE UserPinSettings
                SET FailedAttemptCount = 0,
                    LockedUntil = NULL
                WHERE Id = 1`
        );

        return {
            Status: "Success",
            DataId: 1,
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to clear the PIN lockout.'),
        };
    }
}
