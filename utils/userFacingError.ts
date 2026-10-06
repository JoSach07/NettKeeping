// An error whose message is written for the user and is safe to show as-is.
// Anything else reaching a catch is an internal failure: its message may leak
// implementation detail or a raw native error, so callers substitute their own
// wording rather than concatenating it into a popup.
//
// Lives in its own module so both utils/databaseBackup and utils/exportDirectory
// can throw it without importing each other.
export class UserFacingError extends Error {}

// Splits a caught error into what the user reads and what sits behind the
// popup's "Details" toggle. Detail is returned on the result object rather than
// stashed in module state, so it cannot end up attached to a different failure.
// It is never written to disk: a personal finance app logging diagnostics would
// create the one unencrypted copy of the data that the PIN and the encrypted
// backups exist to protect.
export const describeError = (
  error: unknown,
  fallback: string
): { Detail?: string; Message: string } => {
  // A UserFacingError was already phrased for the user, so nothing is hidden
  // and there is no detail worth revealing.
  if (error instanceof UserFacingError) {
    return { Message: error.message };
  }

  return {
    Detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    Message: fallback,
  };
};

// Cloud apps can list their own document formats (Google Sheets, Docs, ...) in
// the system file picker. Android exposes those as "virtual" documents with no
// bytes behind them, so any read fails with "FileNotFoundException: file is
// virtual". Reading one would need the provider to convert it first
// (openTypedAssetFileDescriptor), which expo-file-system does not expose.
//
// Google's formats are recognised up front by MIME type; the message check
// is the net for any other app doing the same thing.
export const isAppOwnedDocumentType = (mimeType: string | null | undefined) =>
  (mimeType ?? '').startsWith('application/vnd.google-apps.');

export const isVirtualDocumentError = (error: unknown) =>
  error instanceof Error && /file is virtual/i.test(error.message);

// describeError, except that a virtual-document failure gets the caller's
// explanation instead of a generic fallback and a raw native error.
export const describeFileReadError = (
  error: unknown,
  fallback: string,
  virtualDocumentMessage: string
): { Detail?: string; Message: string } =>
  isVirtualDocumentError(error) ? { Message: virtualDocumentMessage } : describeError(error, fallback);

// What a screen keeps for an error it renders: the plain sentence plus the raw
// text for a Details toggle (Popup's `detail`, or ErrorText).
export type ErrorMessage = { message: string; detail?: string };

// Builds an ErrorMessage from a failed result, falling back to the screen's own
// sentence when the result carries none.
export const toErrorMessage = (
  result: { Message?: string; Detail?: string },
  fallback: string
): ErrorMessage => ({ detail: result.Detail, message: result.Message ?? fallback });

// Several failed loads reported together: one message per line, and the raw
// details of those that have one, separated by a blank line.
export const joinErrorMessages = (errors: ErrorMessage[]): ErrorMessage => {
  const details = errors.map((error) => error.detail).filter((detail): detail is string => Boolean(detail));

  return {
    detail: details.length > 0 ? details.join('\n\n') : undefined,
    message: errors.map((error) => error.message).join('\n'),
  };
};
