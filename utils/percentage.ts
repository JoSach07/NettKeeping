/**
 * Formats a category's share of a total for display.
 *
 * Shares that are non-zero but round down to 0% are shown as "<1%" so that a
 * used category is never rendered as unused. Home and the category breakdown
 * screen must agree on this, so both read it from here.
 */
export const formatPercentage = (amount: number, total: number) => {
  if (total <= 0) {
    return '0%';
  }

  const share = (amount / total) * 100;

  if (share > 0 && share < 1) {
    return '<1%';
  }

  return `${Math.round(share)}%`;
};
