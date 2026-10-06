import { Directory } from 'expo-file-system';
import { Platform } from 'react-native';

import { getAppSettings, updateExportDirectory } from '@/database/tables/appSettings';
import { runWithAppLockSuspended } from '@/utils/appLockSuspension';
import { describeError, UserFacingError } from '@/utils/userFacingError';

export const defaultExportDirectoryName = 'Download/NettKeeping';

const androidDownloadsInitialUri =
  'content://com.android.externalstorage.documents/document/primary%3ADownload';

type ChooseExportDirectoryResult = {
  Detail?: string;
  DirectoryName?: string;
  Message?: string;
  Status: 'Success' | 'Error' | 'Cancelled';
};

const getDirectoryDisplayName = (directory: Directory) => {
  const decodedUri = decodeURIComponent(directory.uri.replace(/\/$/, ''));
  const documentPath = decodedUri.match(/\/(?:tree|document)\/[^:]+:(.+)$/)?.[1];

  return documentPath || directory.name || defaultExportDirectoryName;
};

export const chooseExportDirectory = async (): Promise<ChooseExportDirectoryResult> => {
  try {
    const directory = await runWithAppLockSuspended(() =>
      Directory.pickDirectoryAsync(Platform.OS === 'android' ? androidDownloadsInitialUri : undefined)
    );
    const directoryName = getDirectoryDisplayName(directory);
    const updateResult = await updateExportDirectory(directory.uri, directoryName);

    if (updateResult.Status !== 'Success') {
      return {
        Status: 'Error',
        Message: updateResult.Message ?? 'Failed to save the export output directory.',
      };
    }

    return {
      Status: 'Success',
      DirectoryName: directoryName,
    };
  } catch (error) {
    if (/cancel/i.test(String(error))) {
      return { Status: 'Cancelled' };
    }

    return {
      Status: 'Error',
      ...describeError(
        error,
        'Failed to select the export output directory. On Android, select or create a subfolder such as Download/NettKeeping.'
      ),
    };
  }
};

export const getConfiguredExportDirectory = async (): Promise<Directory> => {
  const settingsResult = await getAppSettings();

  // UserFacingError, not Error: both of these are written for the user and are
  // the reason the export catch cannot simply swallow everything generically.
  if (settingsResult.Status !== 'Success') {
    throw new UserFacingError('Failed to load the export output directory setting.');
  }

  if (!settingsResult.Data.ExportDirectoryUri) {
    throw new UserFacingError(
      `Export output directory is not configured. Choose ${defaultExportDirectoryName} in App Settings.`
    );
  }

  return new Directory(settingsResult.Data.ExportDirectoryUri);
};
