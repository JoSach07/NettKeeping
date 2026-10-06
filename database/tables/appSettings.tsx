import { describeError } from '@/utils/userFacingError';

import { getDBConnection, GetResult, InsertOrUpdateResult } from "../dbService";

export type AppThemeSetting = 'device' | 'light' | 'dark';

export interface AppSettings {
    Id: 1;
    Theme: AppThemeSetting;
    LeftHandedMode: boolean;
    CreateTransactionAsStartupScreen: boolean;
    ExportDirectoryUri: string | null;
    ExportDirectoryName: string | null;
}

type AppSettingsRow = Omit<AppSettings, 'LeftHandedMode' | 'CreateTransactionAsStartupScreen'> & {
    LeftHandedMode: number;
    CreateTransactionAsStartupScreen: number;
};

export interface GetAppSettingsResult extends GetResult {
    Data: AppSettings;
}

export const defaultAppSettings: AppSettings = {
    Id: 1,
    Theme: 'device',
    LeftHandedMode: false,
    CreateTransactionAsStartupScreen: false,
    ExportDirectoryUri: null,
    ExportDirectoryName: null,
};

const normalizeAppSettings = (settings: AppSettingsRow | null | undefined): AppSettings => ({
    ...defaultAppSettings,
    ...settings,
    Id: 1,
    LeftHandedMode: Boolean(settings?.LeftHandedMode),
    CreateTransactionAsStartupScreen: Boolean(settings?.CreateTransactionAsStartupScreen),
    ExportDirectoryUri: settings?.ExportDirectoryUri ?? null,
    ExportDirectoryName: settings?.ExportDirectoryName ?? null,
});

export const getAppSettings = async (): Promise<GetAppSettingsResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const settings = await _db.getFirstAsync<AppSettingsRow>('SELECT * FROM AppSettings WHERE Id = 1');
            const response: GetAppSettingsResult = {
                Status: "Success",
                Data: normalizeAppSettings(settings)
            }

            return response;
        } catch (err){
            const response: GetAppSettingsResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load app settings.'),
                Data: defaultAppSettings
            }

            return response;
        }
    }else{
        const response: GetAppSettingsResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: defaultAppSettings
        }

        return response;
    }
}

export const updateAppTheme = async (theme: AppThemeSetting): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            await _db.runAsync('UPDATE AppSettings SET Theme = ? WHERE Id = 1', [theme]);

            const response: InsertOrUpdateResult = {
                Status: "Success",
                DataId: 1
            };
            return response;
        } catch (err){
            const response: InsertOrUpdateResult = {
                Status: "Error",
                ...describeError(err, 'Failed to update app theme.'),
            };
            return response;
        }
    }else{
        const response: InsertOrUpdateResult = {
            Status: "Error",
            Message: 'Error opening database connection',
        }
        return response;
    }
}

export const updateLeftHandedMode = async (leftHandedMode: boolean): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            await _db.runAsync('UPDATE AppSettings SET LeftHandedMode = ? WHERE Id = 1', [leftHandedMode ? 1 : 0]);

            const response: InsertOrUpdateResult = {
                Status: "Success",
                DataId: 1
            };
            return response;
        } catch (err){
            const response: InsertOrUpdateResult = {
                Status: "Error",
                ...describeError(err, 'Failed to update left-handed mode.'),
            };
            return response;
        }
    }else{
        const response: InsertOrUpdateResult = {
            Status: "Error",
            Message: 'Error opening database connection',
        }
        return response;
    }
}

export const updateCreateTransactionAsStartupScreen = async (createTransactionAsStartupScreen: boolean): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            await _db.runAsync(
                'UPDATE AppSettings SET CreateTransactionAsStartupScreen = ? WHERE Id = 1',
                [createTransactionAsStartupScreen ? 1 : 0]
            );

            const response: InsertOrUpdateResult = {
                Status: "Success",
                DataId: 1
            };
            return response;
        } catch (err){
            const response: InsertOrUpdateResult = {
                Status: "Error",
                ...describeError(err, 'Failed to update startup screen.'),
            };
            return response;
        }
    }else{
        const response: InsertOrUpdateResult = {
            Status: "Error",
            Message: 'Error opening database connection',
        }
        return response;
    }
}

export const updateExportDirectory = async (
    uri: string | null,
    name: string | null
): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            await _db.runAsync(
                'UPDATE AppSettings SET ExportDirectoryUri = ?, ExportDirectoryName = ? WHERE Id = 1',
                [uri, name]
            );

            return {
                Status: "Success",
                DataId: 1
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to update the export output directory.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}
