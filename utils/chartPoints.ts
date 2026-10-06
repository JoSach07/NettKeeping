import { Account } from '@/database/tables/accounts';
import { Currency } from '@/database/tables/currencies';
import { InvestmentHistory } from '@/database/tables/investmentHistories';
import { AccountTransactionDetail } from '@/database/tables/transactions';
import { endOfDbDate, formatDbDate, parseDbDate, startOfDbDate } from '@/utils/dbDate';

// Point data for components/LineChart. Everything screen-specific (how a
// balance or a unit value is derived) lives here, so the chart itself only
// knows about dates and numbers.
export type LineChartPoint = {
  date: Date;
  id: string;
  value: number;
};

// One point per local calendar day: the last one that day.
//
// Every date in the app is a date-only string, so all of a day's entries parse
// to the same midnight and used to stack into a vertical column at one x. The
// intermediate dots in that column were never real balances — their order is
// insertion order, not the time they happened — and they still fed the min/max
// range, so one busy day could stretch the axis to a value that was never held.
//
// "Last" means latest time, then latest in the caller's order. Callers must
// pass same-day points in the order they replay in (see buildBalancePoints and
// compareInvestmentHistories). The index tie-break is explicit rather than
// relying on Array.prototype.sort being stable.
export const collapseToLatestPerDay = (points: LineChartPoint[]): LineChartPoint[] => {
  const ordered = points
    .map((point, index) => ({ index, point }))
    .sort((first, second) => first.point.date.getTime() - second.point.date.getTime() || first.index - second.index)
    .map(({ point }) => point);
  const collapsed: LineChartPoint[] = [];

  ordered.forEach((point) => {
    const previous = collapsed[collapsed.length - 1];
    if (previous && formatDbDate(previous.date) === formatDbDate(point.date)) {
      collapsed[collapsed.length - 1] = point;
    } else {
      collapsed.push(point);
    }
  });

  return collapsed;
};

export const formatCompactAmount = (amount: number, currency?: Currency) => {
  const basicAmount = currency ? amount / currency.NumberToBasic : amount;
  const absoluteAmount = Math.abs(basicAmount);
  const sign = basicAmount < 0 ? '-' : '';
  const units = [
    { suffix: 'B', value: 1_000_000_000 },
    { suffix: 'M', value: 1_000_000 },
    { suffix: 'K', value: 1_000 },
  ];
  const unit = units.find((candidate) => absoluteAmount >= candidate.value);

  if (!unit) {
    return `${sign}${Math.round(absoluteAmount).toString()}`;
  }

  const compactValue = absoluteAmount / unit.value;
  const displayValue = compactValue >= 100
    ? Math.round(compactValue).toString()
    : compactValue.toFixed(1).replace(/\.0$/, '').replace('.', ',');

  return `${sign}${displayValue}${unit.suffix}`;
};

// Moved unchanged from app/(tabs)/accounts.tsx. `transactions` must be in
// replay order (date, then Id), which getAccountTransactionDetailsForRange
// returns.
export const buildBalancePoints = (
  account: Account,
  transactions: AccountTransactionDetail[],
  rangeStart: Date
): LineChartPoint[] => {
  const openingDate = parseDbDate(account.OpeningBalanceDate);
  const chartStartDate = rangeStart.getTime() > openingDate.getTime() ? rangeStart : openingDate;
  const startBalance = chartStartDate.getTime() === openingDate.getTime()
    ? account.OpeningBalance
    : [...transactions].reverse().reduce((balance, transaction) => {
        return Boolean(transaction.IsIncome) ? balance - transaction.Amount : balance + transaction.Amount;
      }, account.Balance);
  const points: LineChartPoint[] = [{
    date: chartStartDate,
    id: `${account.Id}-opening`,
    value: startBalance,
  }];
  let runningBalance = startBalance;

  transactions.forEach((transaction) => {
    runningBalance = Boolean(transaction.IsIncome)
      ? runningBalance + transaction.Amount
      : runningBalance - transaction.Amount;
    points.push({
      date: parseDbDate(transaction.TransactionDate),
      id: `${account.Id}-${transaction.Id}`,
      value: runningBalance,
    });
  });

  const lastPoint = points[points.length - 1];
  const today = new Date();
  if (lastPoint.date.getTime() < today.getTime() || lastPoint.value !== account.Balance) {
    points.push({
      date: today,
      id: `${account.Id}-current`,
      value: account.Balance,
    });
  }

  return points;
};

// The replay order from database/investmentReplay.ts: day, then the opening
// entry first (same-day entries land after the anchor), then insertion order.
// getInvestmentHistoriesByInvestment sorts by CreatedAt, Id and ignores
// IsOpening, so it cannot be trusted to put a day's latest entry last.
export const compareInvestmentHistories = (first: InvestmentHistory, second: InvestmentHistory) => {
  const byDay = formatDbDate(parseDbDate(first.CreatedAt)).localeCompare(formatDbDate(parseDbDate(second.CreatedAt)));
  if (byDay !== 0) {
    return byDay;
  }
  if (Boolean(first.IsOpening) !== Boolean(second.IsOpening)) {
    return first.IsOpening ? -1 : 1;
  }
  return first.Id - second.Id;
};

// `histories` is what getInvestmentHistoriesByInvestment returns for the
// range: every entry from the start day on, plus the single latest entry
// before it as a baseline.
//
// The line starts at the range start only when that baseline exists, because
// only then is there a known value at the range start. Without one, the
// investment did not exist yet (or had no entry), so the line starts at its
// first entry and the space to its left stays empty — the accounts chart
// behaves the same for an account opened mid-range. This used to pin the first
// in-range value to the range start regardless, drawing a flat history for a
// period before the investment existed.
//
// The last value is carried to the end of the requested end day, since it is
// still the value today.
export const buildInvestmentChartPoints = (
  histories: InvestmentHistory[],
  valueOf: (history: InvestmentHistory) => number,
  startDate: Date,
  endDate: Date
): LineChartPoint[] => {
  const rangeStart = startOfDbDate(startDate);
  const rangeEnd = endOfDbDate(endDate);
  const ordered = [...histories].sort(compareInvestmentHistories);
  // By calendar day, not instant: an entry dated on the start day is in range.
  // It used to count as "at or before start" (both midnights), and only the
  // last such entry survived as the baseline, so the rest of that day's
  // entries vanished from the chart.
  const before = ordered.filter((history) => startOfDbDate(history.CreatedAt) < rangeStart);
  const inRange = ordered.filter((history) => startOfDbDate(history.CreatedAt) >= rangeStart);
  const baseline = before[before.length - 1];
  const points: LineChartPoint[] = [];

  if (baseline) {
    points.push({ date: rangeStart, id: `${baseline.Id}-start`, value: valueOf(baseline) });
  }

  inRange.forEach((history) => {
    points.push({ date: parseDbDate(history.CreatedAt), id: `${history.Id}`, value: valueOf(history) });
  });

  const lastPoint = points[points.length - 1];
  // An entry past the end (legacy or leaked future date) is already the right
  // edge; the chart stretches its axis to reach it.
  if (lastPoint && lastPoint.date.getTime() < rangeEnd.getTime()) {
    points.push({ date: rangeEnd, id: `${lastPoint.id}-end`, value: lastPoint.value });
  }

  return points;
};
