import { getDBConnection } from '@/database/dbService';
import { parseDbDate } from '@/utils/dbDate';
import { getConfiguredExportDirectory } from '@/utils/exportDirectory';
import { describeError } from '@/utils/userFacingError';
import {
  blank,
  buildXlsxBytes,
  escapeFormulaString,
  formula,
  n,
  quoteSheet,
  SheetCell,
  styles,
  text,
  WorkbookSheet,
} from '@/utils/xlsxWriter';
import { calculateInvestmentAmountForDisplay, quantityToNumber, unitValueToNumber } from '@/utils/investmentNumbers';

export type ExcelExportPeriod =
  | { kind: 'yearly'; year: number }
  | { kind: 'monthly'; month: number; year: number };

export type ExcelExportScope =
  | { kind: 'all' }
  | { accountId: number; accountName: string; kind: 'account' }
  | { investmentId: number; investmentName: string; kind: 'investment' };

type ExportResult = {
  Detail?: string;
  Message?: string;
  Status: 'Success' | 'Error' | 'Cancelled';
  Uri?: string;
};

type AccountRow = {
  CurrencyCode: string;
  Id: number;
  Name: string;
  NumberToBasic: number;
  OpeningBalance: number;
  OpeningBalanceDate: string;
};

type InvestmentRow = {
  CurrencyCode: string;
  Id: number;
  InvestmentCategoryName: string;
  Name: string;
  NumberToBasic: number;
  // Scaled by QuantityDecimals; unit value in minor units x 10^4
  // (utils/investmentNumbers).
  Quantity: number;
  QuantityDecimals: number;
  Unit: string | null;
  UnitValue: number;
};

type InvestmentHistoryRow = {
  CreatedAt: string;
  InvestmentId: number;
  Quantity: number;
  UnitValue: number;
};

type TransactionRow = {
  AccountId: number;
  AccountName: string;
  Amount: number;
  CategoryName: string;
  CurrencyCode: string;
  Description: string | null;
  Id: number;
  IsIncome: number;
  MonthName: string;
  TransactionDate: string;
  NumberToBasic: number;
};

type SummaryRow = {
  CategoryName: string;
  Type: 'Income' | 'Spending';
};

type SnapshotRow = {
  Label: string;
  Style: 'account' | 'investment' | 'nett' | 'normal';
  ValueByCurrency: Map<string, number>;
};

// Quantity and value per unit only mean something for a single investment —
// summing quantities across different units, or averaging prices across
// holdings, produces nonsense. So these are filled in for investment-scoped
// exports only and stay null everywhere else.
type InvestmentState = {
  quantity: number;
  unitValue: number;
};

type MonthReport = {
  endDate: Date;
  income: TransactionRow[];
  incomeSummary: SummaryRow[];
  investmentState: InvestmentState | null;
  isFuture: boolean;
  month: number;
  snapshot: SnapshotRow[];
  spending: TransactionRow[];
  spendingSummary: SummaryRow[];
  startInvestmentState: InvestmentState | null;
  startSnapshot: SnapshotRow[];
  year: number;
};

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const dataSheetName = '_Data';
const defaultCurrency = 'Value';

const toDbDate = (date: Date) =>
  `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;

const toDisplayDate = (rawDate: string) => {
  const date = new Date(`${rawDate}T00:00:00`);
  return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
};

const startOfMonth = (year: number, month: number) => new Date(year, month - 1, 1);
const endOfMonth = (year: number, month: number) => new Date(year, month, 0);
const startOfYear = (year: number) => new Date(year, 0, 1);
const endOfYear = (year: number) => new Date(year, 11, 31);

const capToToday = (date: Date) => {
  const today = new Date();
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return date.getTime() > todayDateOnly.getTime() ? todayDateOnly : date;
};

const money = (amount: number, numberToBasic: number) => amount / Math.max(numberToBasic, 1);

const addValue = (map: Map<string, number>, currency: string, amount: number) => {
  map.set(currency, (map.get(currency) ?? 0) + amount);
};

const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').toLowerCase();

const getScopeFileLabel = (scope: ExcelExportScope) => {
  if (scope.kind === 'account') {
    return scope.accountName;
  }
  if (scope.kind === 'investment') {
    return scope.investmentName;
  }
  return 'all-data';
};

const buildFileName = (period: ExcelExportPeriod, scope: ExcelExportScope) => {
  const periodLabel = period.kind === 'yearly'
    ? `${period.year}`
    : `${period.year}-${period.month.toString().padStart(2, '0')}`;
  return `nettkeeping-${sanitizeFileName(getScopeFileLabel(scope))}-${periodLabel}.xlsx`;
};

const getAccountsForScope = async (scope: ExcelExportScope) => {
  if (scope.kind === 'investment') {
    return [];
  }

  const db = await getDBConnection();
  const where = scope.kind === 'account' ? ' AND a.Id = ?' : '';
  const params = scope.kind === 'account' ? [scope.accountId] : [];

  return db.getAllAsync<AccountRow>(
    `SELECT
        a.Id,
        a.Name,
        a.OpeningBalance,
        a.OpeningBalanceDate,
        cur.Code AS CurrencyCode,
        cur.NumberToBasic
     FROM Accounts a
     INNER JOIN Currencies cur ON cur.Id = a.CurrencyId
     WHERE a.IsActive = 1${where}
     ORDER BY a.Name COLLATE NOCASE`,
    params
  );
};

const getInvestmentsForScope = async (scope: ExcelExportScope) => {
  if (scope.kind === 'account') {
    return [];
  }

  const db = await getDBConnection();
  const where = scope.kind === 'investment' ? ' WHERE i.Id = ?' : '';
  const params = scope.kind === 'investment' ? [scope.investmentId] : [];

  return db.getAllAsync<InvestmentRow>(
    `SELECT
        i.Id,
        i.Name,
        ic.Name AS InvestmentCategoryName,
        i.Quantity,
        i.QuantityDecimals,
        i.Unit,
        i.UnitValue,
        cur.Code AS CurrencyCode,
        cur.NumberToBasic
     FROM Investments i
     INNER JOIN InvestmentCategories ic ON ic.Id = i.InvestmentCategoryId
     INNER JOIN Currencies cur ON cur.Id = i.CurrencyId
     ${where}
     ORDER BY ic.Name COLLATE NOCASE, i.Name COLLATE NOCASE`,
    params
  );
};

const getInvestmentHistories = async (scope: ExcelExportScope) => {
  if (scope.kind === 'account') {
    return [];
  }

  const db = await getDBConnection();
  const where = scope.kind === 'investment' ? ' WHERE InvestmentId = ?' : '';
  const params = scope.kind === 'investment' ? [scope.investmentId] : [];

  return db.getAllAsync<InvestmentHistoryRow>(
    `SELECT InvestmentId, Quantity, UnitValue, CreatedAt
     FROM InvestmentHistories
     ${where}
     ORDER BY InvestmentId, date(CreatedAt) ASC, Id ASC`,
    params
  );
};

const getTransactions = async (startDate: Date, endDate: Date, scope: ExcelExportScope) => {
  const db = await getDBConnection();
  const params: (number | string)[] = [toDbDate(startDate), toDbDate(endDate)];
  // Investment transactions are matched through the history entry that links them
  // to the investment, not by looking for the investment's name in the free
  // text description. Name matching silently dropped any transaction the user
  // described differently, and swept in other investments' transactions that
  // happened to mention this one.
  const scopeWhere =
    scope.kind === 'account'
      ? ' AND t.AccountId = ?'
      : scope.kind === 'investment'
        ? ` AND EXISTS (
                SELECT 1
                FROM InvestmentHistories ih
                WHERE ih.TransactionId = t.Id
                    AND ih.InvestmentId = ?
            )`
        : '';

  if (scope.kind === 'account') {
    params.push(scope.accountId);
  } else if (scope.kind === 'investment') {
    params.push(scope.investmentId);
  }

  return db.getAllAsync<TransactionRow>(
    `SELECT
        t.Id,
        t.Description,
        t.Amount,
        t.TransactionDate,
        t.AccountId,
        a.Name AS AccountName,
        c.Name AS CategoryName,
        tt.IsIncome,
        cur.Code AS CurrencyCode,
        cur.NumberToBasic
     FROM Transactions t
     INNER JOIN Accounts a ON a.Id = t.AccountId
     INNER JOIN Currencies cur ON cur.Id = a.CurrencyId
     INNER JOIN Categories c ON c.Id = t.CategoryId
     INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
     WHERE date(t.TransactionDate) >= date(?)
        AND date(t.TransactionDate) <= date(?)
        ${scopeWhere}
     ORDER BY date(t.TransactionDate) ASC, t.Id ASC`,
    params
  );
};

type AccountCumulativeChange = {
  cumulativeAmount: number;
  date: string;
};

// One grouped query replaces the previous per-account/per-date snapshot
// queries; snapshot values are then derived in JS from cumulative sums.
const getAccountCumulativeChanges = async (
  accounts: AccountRow[]
): Promise<Map<number, AccountCumulativeChange[]>> => {
  const changesByAccount = new Map<number, AccountCumulativeChange[]>();

  if (accounts.length === 0) {
    return changesByAccount;
  }

  const db = await getDBConnection();
  const placeholders = accounts.map(() => '?').join(', ');
  const rows = await db.getAllAsync<{ AccountId: number; ChangeAmount: number; ChangeDate: string }>(
    `SELECT
        t.AccountId,
        date(t.TransactionDate) AS ChangeDate,
        SUM(CASE WHEN tt.IsIncome = 1 THEN t.Amount ELSE -t.Amount END) AS ChangeAmount
     FROM Transactions t
     INNER JOIN Accounts a ON a.Id = t.AccountId
     INNER JOIN Categories c ON c.Id = t.CategoryId
     INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
     WHERE t.AccountId IN (${placeholders})
        AND date(t.TransactionDate) >= date(a.OpeningBalanceDate)
     GROUP BY t.AccountId, date(t.TransactionDate)
     ORDER BY t.AccountId, date(t.TransactionDate) ASC`,
    accounts.map((account) => account.Id)
  );

  rows.forEach((row) => {
    const changes = changesByAccount.get(row.AccountId) ?? [];
    const previousCumulative = changes[changes.length - 1]?.cumulativeAmount ?? 0;
    changes.push({
      cumulativeAmount: previousCumulative + row.ChangeAmount,
      date: row.ChangeDate,
    });
    changesByAccount.set(row.AccountId, changes);
  });

  return changesByAccount;
};

const getAccountSnapshotValue = (
  account: AccountRow,
  date: Date,
  changesByAccount: Map<number, AccountCumulativeChange[]>
) => {
  const changes = changesByAccount.get(account.Id) ?? [];
  const snapshotDate = toDbDate(date);
  // Dates are YYYY-MM-DD, so string comparison matches date order. Binary
  // search for the last cumulative change on or before the snapshot date.
  let low = 0;
  let high = changes.length - 1;
  let changeAmount = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (changes[mid].date <= snapshotDate) {
      changeAmount = changes[mid].cumulativeAmount;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return money(account.OpeningBalance + changeAmount, account.NumberToBasic);
};

// The investment's position on a given date: the last history entry on or
// before it. Nothing on or before means the investment did not exist yet, which
// is zero — NOT the investment's current quantity and price. Falling back to
// those reported today's holding for every month before the first purchase, so
// a February sheet for something bought in August showed the August value with
// no transaction behind it.
const getInvestmentStateAt = (
  histories: InvestmentHistoryRow[],
  investmentId: number,
  date: Date
) => {
  const history = histories
    .filter((row) => row.InvestmentId === investmentId && parseDbDate(row.CreatedAt).getTime() <= date.getTime())
    .at(-1);

  return {
    quantity: history?.Quantity ?? 0,
    unitValue: history?.UnitValue ?? 0,
  };
};

const buildSnapshot = (
  accounts: AccountRow[],
  investments: InvestmentRow[],
  histories: InvestmentHistoryRow[],
  date: Date,
  changesByAccount: Map<number, AccountCumulativeChange[]>
): SnapshotRow[] => {
  const accountRows: SnapshotRow[] = [];
  const investmentCategoryRows = new Map<string, SnapshotRow>();
  const nett = new Map<string, number>();
  const bankAccounts = new Map<string, number>();
  const investmentsTotal = new Map<string, number>();

  for (const account of accounts) {
    const value = getAccountSnapshotValue(account, date, changesByAccount);
    addValue(nett, account.CurrencyCode, value);
    addValue(bankAccounts, account.CurrencyCode, value);
    accountRows.push({
      Label: account.Name,
      Style: 'normal',
      ValueByCurrency: new Map([[account.CurrencyCode, value]]),
    });
  }

  for (const investment of investments) {
    const state = getInvestmentStateAt(histories, investment.Id, date);
    const value = money(
      calculateInvestmentAmountForDisplay(state.quantity, investment.QuantityDecimals, state.unitValue),
      investment.NumberToBasic
    );
    const row = investmentCategoryRows.get(investment.InvestmentCategoryName) ?? {
      Label: investment.InvestmentCategoryName,
      Style: 'normal',
      ValueByCurrency: new Map(),
    };

    addValue(row.ValueByCurrency, investment.CurrencyCode, value);
    addValue(nett, investment.CurrencyCode, value);
    addValue(investmentsTotal, investment.CurrencyCode, value);
    investmentCategoryRows.set(investment.InvestmentCategoryName, row);
  }

  return [
    { Label: 'Nett Value', Style: 'nett', ValueByCurrency: nett },
    { Label: 'Bank Accounts', Style: 'account', ValueByCurrency: bankAccounts },
    ...accountRows,
    { Label: 'Investments', Style: 'investment', ValueByCurrency: investmentsTotal },
    ...investmentCategoryRows.values(),
  ];
};

const getSummaryCategories = (rows: TransactionRow[], type: 'Income' | 'Spending'): SummaryRow[] => (
  [...new Set(rows.map((row) => row.CategoryName))]
    .sort((first, second) => first.localeCompare(second))
    .map((CategoryName) => ({ CategoryName, Type: type }))
);

const buildData = async (period: ExcelExportPeriod, scope: ExcelExportScope) => {
  const reportStart = period.kind === 'yearly'
    ? startOfYear(period.year)
    : startOfMonth(period.year, period.month);
  const reportEnd = capToToday(period.kind === 'yearly'
    ? endOfYear(period.year)
    : endOfMonth(period.year, period.month));
  const [accounts, investments, histories, allTransactions] = await Promise.all([
    getAccountsForScope(scope),
    getInvestmentsForScope(scope),
    getInvestmentHistories(scope),
    getTransactions(reportStart, reportEnd, scope),
  ]);
  const changesByAccount = await getAccountCumulativeChanges(accounts);
  const monthNumbers = period.kind === 'yearly'
    ? Array.from({ length: 12 }, (_, index) => index + 1)
    : [period.month];
  const reports: MonthReport[] = [];

  monthNumbers.forEach((month) => {
    const monthStart = startOfMonth(period.year, month);
    const monthEnd = capToToday(endOfMonth(period.year, month));
    const today = new Date();
    const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const isFuture = monthStart.getTime() > todayDateOnly.getTime();
    const monthRows = allTransactions.filter((transaction) => {
      const time = new Date(`${transaction.TransactionDate}T00:00:00`).getTime();
      return time >= monthStart.getTime() && time <= monthEnd.getTime();
    });
    const income = monthRows.filter((transaction) => Boolean(transaction.IsIncome));
    const spending = monthRows.filter((transaction) => !Boolean(transaction.IsIncome));
    reports.push({
      endDate: monthEnd,
      income,
      incomeSummary: getSummaryCategories(income, 'Income'),
      investmentState: null,
      isFuture,
      month,
      snapshot: [],
      spending,
      spendingSummary: getSummaryCategories(spending, 'Spending'),
      startInvestmentState: null,
      startSnapshot: [],
      year: period.year,
    });
  });

  // Only an investment-scoped export has a single investment to describe by
  // quantity and unit price.
  const scopedInvestment = scope.kind === 'investment' ? investments[0] ?? null : null;
  const getScopedInvestmentState = (date: Date) =>
    scopedInvestment ? getInvestmentStateAt(histories, scopedInvestment.Id, date) : null;

  reports.forEach((report, index) => {
    if (!report.isFuture) {
      const startDate = report.month === 1
        ? startOfYear(report.year)
        : endOfMonth(report.year, report.month - 1);

      report.snapshot = buildSnapshot(accounts, investments, histories, report.endDate, changesByAccount);
      report.investmentState = getScopedInvestmentState(report.endDate);
      report.startSnapshot = period.kind === 'yearly' && index > 0
        ? reports[index - 1].snapshot
        : buildSnapshot(accounts, investments, histories, startDate, changesByAccount);
      report.startInvestmentState = period.kind === 'yearly' && index > 0
        ? reports[index - 1].investmentState
        : getScopedInvestmentState(startDate);
    }
  });

  const transactionsWithMonthName = allTransactions.map((transaction) => ({
    ...transaction,
    MonthName: monthNames[new Date(`${transaction.TransactionDate}T00:00:00`).getMonth()],
  }));

  return {
    currencies: [...new Set([...accounts.map((account) => account.CurrencyCode), ...investments.map((investment) => investment.CurrencyCode)])],
    endInvestmentState: getScopedInvestmentState(reportEnd),
    endSnapshot: buildSnapshot(accounts, investments, histories, reportEnd, changesByAccount),
    investment: scopedInvestment,
    transactions: transactionsWithMonthName,
    reports,
    startInvestmentState: getScopedInvestmentState(reportStart),
    startSnapshot: buildSnapshot(accounts, investments, histories, reportStart, changesByAccount),
  };
};

const appendRows = (target: SheetCell[][], startRow: number, startCol: number, rows: SheetCell[][]) => {
  rows.forEach((row, rowIndex) => {
    const sheetRow = target[startRow + rowIndex] ?? [];
    row.forEach((cell, colIndex) => {
      sheetRow[startCol + colIndex] = cell;
    });
    target[startRow + rowIndex] = sheetRow;
  });
};

const ensureRectangularRows = (rows: SheetCell[][]) => {
  const width = Math.max(1, ...rows.filter(Boolean).map((row) => row.length));
  return Array.from({ length: rows.length }, (_, rowIndex) => {
    const row = rows[rowIndex] ?? [];
    return Array.from({ length: width }, (_, colIndex) => row[colIndex] ?? blank());
  });
};

const snapshotRowsToCells = (snapshot: SnapshotRow[], currencies: string[]) => {
  const activeCurrencies = currencies.length > 0 ? currencies : [defaultCurrency];
  const rows: SheetCell[][] = [
    [text('Item', styles.tableHeader), ...activeCurrencies.map((currency) => text(currency, styles.tableHeader))],
  ];

  snapshot.forEach((row) => {
    const style = row.Style === 'nett'
      ? styles.nett
      : row.Style === 'account'
        ? styles.account
        : row.Style === 'investment'
          ? styles.investment
          : styles.currency;
    rows.push([
      text(row.Label, style),
      ...activeCurrencies.map((currency) => n(row.ValueByCurrency.get(currency) ?? 0, style)),
    ]);
  });

  return rows;
};

const summaryRowsToCells = (summary: SummaryRow[], monthName: string, type: 'Income' | 'Spending') => {
  const rows: SheetCell[][] = [[text('Category', styles.tableHeader), text('Amount', styles.tableHeader)]];
  const dataSheet = quoteSheet(dataSheetName);

  summary.forEach((row) => {
    rows.push([
      text(row.CategoryName),
      formula(`SUMIFS(${dataSheet}!$F$2:$F$5000,${dataSheet}!$D$2:$D$5000,"${escapeFormulaString(row.CategoryName)}",${dataSheet}!$G$2:$G$5000,"${type}",${dataSheet}!$H$2:$H$5000,"${monthName}")`),
    ]);
  });

  if (summary.length === 0) {
    rows.push([text('No data'), n(0)]);
  }

  rows.push([
    text('Total', styles.tableHeader),
    formula(`SUMIFS(${dataSheet}!$F$2:$F$5000,${dataSheet}!$G$2:$G$5000,"${type}",${dataSheet}!$H$2:$H$5000,"${monthName}")`, styles.currency),
  ]);
  return rows;
};

const buildDataSheet = (transactions: TransactionRow[]): WorkbookSheet => {
  const rows: SheetCell[][] = [[
    text('Date', styles.tableHeader),
    text('Description', styles.tableHeader),
    text('Category', styles.tableHeader),
    text('CategoryKey', styles.tableHeader),
    text('Account', styles.tableHeader),
    text('Amount', styles.tableHeader),
    text('Type', styles.tableHeader),
    text('Month', styles.tableHeader),
    text('Currency', styles.tableHeader),
  ]];

  transactions.forEach((transaction) => {
    rows.push([
      text(toDisplayDate(transaction.TransactionDate), styles.date),
      text(transaction.Description ?? ''),
      text(transaction.CategoryName),
      text(transaction.CategoryName),
      text(transaction.AccountName),
      n(money(transaction.Amount, transaction.NumberToBasic)),
      text(Boolean(transaction.IsIncome) ? 'Income' : 'Spending'),
      text(transaction.MonthName),
      text(transaction.CurrencyCode),
    ]);
  });

  return {
    cols: [14, 32, 20, 20, 18, 16, 12, 14, 12],
    hidden: true,
    name: dataSheetName,
    rows: ensureRectangularRows(rows),
  };
};

const appendTransactionDetailTables = (rows: SheetCell[][], tableStart: number, report: MonthReport) => {
  const headers = ['Date', 'Description', 'Category', 'Amount', 'Account'];

  rows[tableStart] = [text('Income', styles.incomeHeader)];
  rows[tableStart][8] = text('Spending', styles.spendingHeader);
  rows[tableStart + 1] = headers.map((header) => text(header, styles.tableHeader));
  headers.forEach((header, index) => {
    rows[tableStart + 1][8 + index] = text(header, styles.tableHeader);
  });

  report.income.forEach((transaction, index) => {
    rows[tableStart + 2 + index] = rows[tableStart + 2 + index] ?? [];
    rows[tableStart + 2 + index][0] = text(toDisplayDate(transaction.TransactionDate), styles.date);
    rows[tableStart + 2 + index][1] = text(transaction.Description ?? '');
    rows[tableStart + 2 + index][2] = text(transaction.CategoryName);
    rows[tableStart + 2 + index][3] = n(money(transaction.Amount, transaction.NumberToBasic));
    rows[tableStart + 2 + index][4] = text(transaction.AccountName);
  });

  report.spending.forEach((transaction, index) => {
    rows[tableStart + 2 + index] = rows[tableStart + 2 + index] ?? [];
    rows[tableStart + 2 + index][8] = text(toDisplayDate(transaction.TransactionDate), styles.date);
    rows[tableStart + 2 + index][9] = text(transaction.Description ?? '');
    rows[tableStart + 2 + index][10] = text(transaction.CategoryName);
    rows[tableStart + 2 + index][11] = n(money(transaction.Amount, transaction.NumberToBasic));
    rows[tableStart + 2 + index][12] = text(transaction.AccountName);
  });
};

const buildMonthlySheet = (report: MonthReport, currencies: string[]): WorkbookSheet => {
  const sheetName = monthNames[report.month - 1];
  const rows: SheetCell[][] = [];
  const startSnapshotRows = snapshotRowsToCells(report.startSnapshot, currencies);
  const endSnapshotRows = snapshotRowsToCells(report.snapshot, currencies);
  const incomeSummary = summaryRowsToCells(report.incomeSummary, sheetName, 'Income');
  const spendingSummary = summaryRowsToCells(report.spendingSummary, sheetName, 'Spending');

  rows[0] = [text(sheetName, styles.title)];
  rows[1] = [text('Start of Month', styles.gray)];
  rows[1][8] = text('End of Month', styles.gray);
  if (!report.isFuture) {
    appendRows(rows, 2, 0, startSnapshotRows.slice(1));
    appendRows(rows, 2, 8, endSnapshotRows.slice(1));
  }

  const recapStart = Math.max(report.startSnapshot.length, report.snapshot.length) + 3;
  rows[recapStart] = [text('Income Recap', styles.incomeHeader)];
  rows[recapStart][8] = text('Spending Recap', styles.spendingHeader);
  appendRows(rows, recapStart + 1, 0, incomeSummary);
  appendRows(rows, recapStart + 1, 8, spendingSummary);

  const tableStart = recapStart + Math.max(incomeSummary.length, spendingSummary.length) + 2;
  appendTransactionDetailTables(rows, tableStart, report);

  return {
    cols: [14, 30, 20, 16, 16, 4, 4, 4, 14, 30, 20, 16, 16],
    name: sheetName,
    rows: ensureRectangularRows(rows),
  };
};

const buildAnnualSheet = (
  year: number,
  currencies: string[],
  startSnapshot: SnapshotRow[],
  endSnapshot: SnapshotRow[],
  reports: MonthReport[]
): WorkbookSheet => {
  const rows: SheetCell[][] = [];
  const sheetName = `${year} Annual`;
  const activeCurrencies = currencies.length > 0 ? currencies : [defaultCurrency];
  const snapshotWidth = activeCurrencies.length + 1;
  const rightBlockCol = snapshotWidth + 1;
  const topSnapshotRows = Math.max(startSnapshot.length, endSnapshot.length);
  const monthlySnapshotRows = Math.max(1, ...reports.map((report) => report.snapshot.length));
  const monthlyBlockHeight = monthlySnapshotRows + 3;
  rows[0] = [text(sheetName, styles.title)];
  rows[1] = [text('Starting', styles.gray)];
  rows[1][rightBlockCol] = text('End of Year', styles.gray);
  appendRows(rows, 2, 0, snapshotRowsToCells(startSnapshot, currencies).slice(1));
  appendRows(rows, 2, rightBlockCol, snapshotRowsToCells(endSnapshot, currencies).slice(1));

  reports.forEach((report, index) => {
    const left = index % 2 === 0;
    const blockRow = topSnapshotRows + 4 + Math.floor(index / 2) * monthlyBlockHeight;
    const blockCol = left ? 0 : rightBlockCol;
    const snapshotRows = snapshotRowsToCells(report.snapshot, currencies);

    rows[blockRow] = rows[blockRow] ?? [];
    rows[blockRow][blockCol] = text(monthNames[report.month - 1], styles.gray);
    if (!report.isFuture) {
      appendRows(rows, blockRow + 1, blockCol, snapshotRows.slice(1));
    }
  });

  const blockWidths = [18, ...activeCurrencies.map(() => 15)];
  return {
    cols: [...blockWidths, 4, ...blockWidths],
    name: sheetName,
    rows: ensureRectangularRows(rows),
  };
};

const getScopedValueCell = (snapshot: SnapshotRow[], currencies: string[]) => {
  if (snapshot.length === 0) {
    return blank(styles.currency);
  }

  const currency = currencies[0] ?? defaultCurrency;
  const nettValue = snapshot.find((row) => row.Style === 'nett');
  return n(nettValue?.ValueByCurrency.get(currency) ?? 0, styles.currency);
};

// An investment export describes one holding, so each period can carry the
// position behind the money: how many units were held and what one was worth.
// Account exports keep the single value column — an account has no quantity.
const getScopedPeriodCells = (
  label: string,
  snapshot: SnapshotRow[],
  investmentState: InvestmentState | null,
  currencies: string[],
  investment: InvestmentRow | null
): SheetCell[] => {
  if (!investment) {
    return [text(label, styles.gray), getScopedValueCell(snapshot, currencies)];
  }

  // A future month has no position to report; leave it empty rather than
  // claiming a zero holding.
  if (!investmentState) {
    return [text(label, styles.gray), blank(), blank(styles.currency), blank(styles.currency)];
  }

  return [
    text(label, styles.gray),
    n(quantityToNumber(investmentState.quantity, investment.QuantityDecimals), styles.default),
    n(unitValueToNumber(investmentState.unitValue, { Code: investment.CurrencyCode, NumberToBasic: investment.NumberToBasic })),
    n(money(
      calculateInvestmentAmountForDisplay(investmentState.quantity, investment.QuantityDecimals, investmentState.unitValue),
      investment.NumberToBasic
    )),
  ];
};

const getScopedHeaderCells = (investment: InvestmentRow | null): SheetCell[] | null => {
  if (!investment) {
    return null;
  }

  return [
    blank(styles.tableHeader),
    text(investment.Unit ? `Quantity (${investment.Unit})` : 'Quantity', styles.tableHeader),
    text('Value Per Unit', styles.tableHeader),
    text('Total', styles.tableHeader),
  ];
};

const getScopedSheetCols = (investment: InvestmentRow | null) =>
  investment ? [20, 18, 18, 18] : [20, 18];

const buildScopedAnnualSheet = (
  year: number,
  currencies: string[],
  startSnapshot: SnapshotRow[],
  endSnapshot: SnapshotRow[],
  reports: MonthReport[],
  investment: InvestmentRow | null,
  startInvestmentState: InvestmentState | null,
  endInvestmentState: InvestmentState | null
): WorkbookSheet => {
  const rows: SheetCell[][] = [[text(`${year} Annual`, styles.title)]];
  const headerCells = getScopedHeaderCells(investment);

  if (headerCells) {
    rows.push(headerCells);
  }

  // One row per period, top to bottom: the year's opening position, every
  // month, then the closing position.
  rows.push(getScopedPeriodCells('Year Start', startSnapshot, startInvestmentState, currencies, investment));
  reports.forEach((report) => {
    rows.push(
      getScopedPeriodCells(
        monthNames[report.month - 1],
        report.snapshot,
        report.investmentState,
        currencies,
        investment
      )
    );
  });
  rows.push(getScopedPeriodCells('Year End', endSnapshot, endInvestmentState, currencies, investment));

  return {
    cols: getScopedSheetCols(investment),
    name: `${year} Annual`,
    rows: ensureRectangularRows(rows),
  };
};

const buildScopedMonthlySheet = (
  report: MonthReport,
  currencies: string[],
  investment: InvestmentRow | null
): WorkbookSheet => {
  const sheetName = monthNames[report.month - 1];
  const rows: SheetCell[][] = [[text(sheetName, styles.title)]];
  const incomeSummary = summaryRowsToCells(report.incomeSummary, sheetName, 'Income');
  const spendingSummary = summaryRowsToCells(report.spendingSummary, sheetName, 'Spending');
  const headerCells = getScopedHeaderCells(investment);

  if (headerCells) {
    rows.push(headerCells);
  }

  rows.push(getScopedPeriodCells('Month Start', report.startSnapshot, report.startInvestmentState, currencies, investment));
  rows.push(getScopedPeriodCells('Month End', report.snapshot, report.investmentState, currencies, investment));

  const recapStart = rows.length + 1;
  rows[recapStart] = [text('Income Recap', styles.incomeHeader)];
  rows[recapStart][8] = text('Spending Recap', styles.spendingHeader);
  appendRows(rows, recapStart + 1, 0, incomeSummary);
  appendRows(rows, recapStart + 1, 8, spendingSummary);

  const tableStart = recapStart + Math.max(incomeSummary.length, spendingSummary.length) + 3;
  appendTransactionDetailTables(rows, tableStart, report);

  return {
    cols: [14, 30, 20, 16, 16, 4, 4, 4, 14, 30, 20, 16, 16],
    name: sheetName,
    rows: ensureRectangularRows(rows),
  };
};

const buildWorkbookSheets = async (period: ExcelExportPeriod, scope: ExcelExportScope): Promise<WorkbookSheet[]> => {
  const data = await buildData(period, scope);
  const visibleSheets = scope.kind !== 'all'
    ? period.kind === 'monthly'
      ? [buildScopedMonthlySheet(data.reports[0], data.currencies, data.investment)]
      : [
          buildScopedAnnualSheet(
            period.year,
            data.currencies,
            data.startSnapshot,
            data.endSnapshot,
            data.reports,
            data.investment,
            data.startInvestmentState,
            data.endInvestmentState
          ),
        ]
    : period.kind === 'monthly'
      ? [buildMonthlySheet(data.reports[0], data.currencies)]
      : [
          buildAnnualSheet(period.year, data.currencies, data.startSnapshot, data.endSnapshot, data.reports),
          ...data.reports.map((report) => buildMonthlySheet(report, data.currencies)),
        ];

  return [...visibleSheets, buildDataSheet(data.transactions)];
};

export const __excelExportTestUtils = {
  buildAnnualSheet,
  buildMonthlySheet,
  buildScopedAnnualSheet,
  buildScopedMonthlySheet,
  buildSnapshot,
  buildXlsxBytes,
  getInvestmentStateAt,
};

export const exportExcelReport = async (
  period: ExcelExportPeriod,
  scope: ExcelExportScope = { kind: 'all' }
): Promise<ExportResult> => {
  try {
    const directory = await getConfiguredExportDirectory();
    const sheets = await buildWorkbookSheets(period, scope);
    const bytes = await buildXlsxBytes(sheets);
    const file = directory.createFile(
      buildFileName(period, scope),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    file.write(bytes);

    return {
      Status: 'Success',
      Uri: file.uri,
    };
  } catch (error) {
    return {
      Status: 'Error',
      // getConfiguredExportDirectory's "not configured" guidance survives here;
      // anything else is internal and goes to Detail.
      ...describeError(error, 'Failed to export Excel report.'),
    };
  }
};
