import { useCallback, useState } from 'react';

import { ErrorMessage } from '@/utils/userFacingError';

// Error state for a message rendered on screen or in a modal's Popup, plus the
// raw detail behind it for the Details toggle. Setting a message without a
// detail clears any previous one, so a validation message can never inherit
// the raw text of an earlier database failure.
export const useErrorState = () => {
  const [error, setError] = useState<ErrorMessage>({ message: '' });
  const setErrorMessage = useCallback(
    (message: string, detail?: string) => setError({ detail, message }),
    []
  );

  return [error, setErrorMessage] as const;
};
