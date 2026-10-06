import { createContext, createElement, PropsWithChildren, useContext, useMemo, useState } from 'react';

export type SummaryMode = 'spending' | 'income';

type SummaryModeContextValue = {
  setSummaryMode: (mode: SummaryMode) => void;
  summaryMode: SummaryMode;
};

const SummaryModeContext = createContext<SummaryModeContextValue | null>(null);

/**
 * Holds the spending/income selection shared by the Home breakdown and the
 * category breakdown ("View All") screen. Keeping it in one place means the
 * drill-down opens in the mode Home is showing, and a change made on either
 * screen is reflected on the other.
 */
export function SummaryModeProvider({ children }: PropsWithChildren) {
  const [summaryMode, setSummaryMode] = useState<SummaryMode>('spending');
  const value = useMemo(() => ({ setSummaryMode, summaryMode }), [summaryMode]);

  return createElement(SummaryModeContext.Provider, { value }, children);
}

export function useSummaryMode(): SummaryModeContextValue {
  const context = useContext(SummaryModeContext);

  if (context) {
    return context;
  }

  return {
    setSummaryMode: () => undefined,
    summaryMode: 'spending',
  };
}
