import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';

import { __excelExportTestUtils } from '@/utils/excelExport';

const valueMap = (value: number) => new Map([['IDR', value]]);

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

const snapshot = [
  { Label: 'Nett Value', Style: 'nett' as const, ValueByCurrency: valueMap(300) },
  { Label: 'Bank Accounts', Style: 'account' as const, ValueByCurrency: valueMap(100) },
  { Label: 'BCA', Style: 'normal' as const, ValueByCurrency: valueMap(60) },
  { Label: 'CIMB', Style: 'normal' as const, ValueByCurrency: valueMap(40) },
  { Label: 'Investments', Style: 'investment' as const, ValueByCurrency: valueMap(200) },
  { Label: 'Precious Metals', Style: 'normal' as const, ValueByCurrency: valueMap(150) },
  { Label: 'Papers', Style: 'normal' as const, ValueByCurrency: valueMap(50) },
  { Label: 'Investment Category 3', Style: 'normal' as const, ValueByCurrency: valueMap(0) },
  { Label: 'Investment Category 4', Style: 'normal' as const, ValueByCurrency: valueMap(0) },
];

// Bought on 3 August: nothing held before then, 5 units at 100 after.
// Unit values are stored in minor units x 10^4, so Rp 100 is
// 1000000 in the database and still exports as 100.
const investment = {
  CurrencyCode: 'IDR',
  Id: 1,
  InvestmentCategoryName: 'Precious Metals',
  Name: 'Silver',
  NumberToBasic: 1,
  Quantity: 5,
  QuantityDecimals: 0,
  Unit: 'gram',
  UnitValue: 1000000,
};

const investmentHistories = [
  { CreatedAt: '2026-08-03', InvestmentId: 1, Quantity: 5, UnitValue: 1000000 },
];

const investmentStateFor = (month: number) => (month >= 8 ? { quantity: 5, unitValue: 1000000 } : { quantity: 0, unitValue: 0 });

const report = (month: number, isFuture: boolean) => ({
  endDate: new Date(2026, month, 0),
  income: [],
  incomeSummary: [],
  investmentState: isFuture ? null : investmentStateFor(month),
  isFuture,
  month,
  snapshot: isFuture ? [] : snapshot,
  spending: [],
  spendingSummary: [],
  startInvestmentState: isFuture ? null : investmentStateFor(month - 1),
  startSnapshot: isFuture ? [] : snapshot,
  year: 2026,
});

const populatedReport = () => ({
  ...report(7, false),
  income: [{
    AccountId: 1,
    AccountName: 'BCA',
    Amount: 127,
    CategoryName: 'Interest',
    CurrencyCode: 'IDR',
    Description: 'Monthly interest',
    Id: 1,
    IsIncome: 1,
    MonthName: 'July',
    TransactionDate: '2026-07-02',
    NumberToBasic: 1,
  }],
  incomeSummary: [{ CategoryName: 'Interest', Type: 'Income' as const }],
  spending: [{
    AccountId: 1,
    AccountName: 'BCA',
    Amount: 94350,
    CategoryName: 'Subscription',
    CurrencyCode: 'IDR',
    Description: 'Apple Music',
    Id: 2,
    IsIncome: 0,
    MonthName: 'July',
    TransactionDate: '2026-07-06',
    NumberToBasic: 1,
  }],
  spendingSummary: [{ CategoryName: 'Subscription', Type: 'Spending' as const }],
});

describe('Excel export layout', () => {
  it('keeps annual months snapshot-only and does not carry snapshots into future months', async () => {
    const reports = Array.from({ length: 12 }, (_, index) => report(index + 1, index >= 7));
    const annual = __excelExportTestUtils.buildAnnualSheet(2026, ['IDR'], snapshot, snapshot, reports);
    const values = annual.rows.flat().map((cell) => cell.v);

    expect(values).not.toContain('Income');
    expect(values).not.toContain('Spending');
    expect(values).toContain('August');
    expect(values.filter((value) => value === 'BCA')).toHaveLength(9);

    const fixturePath = process.env.EXCEL_LAYOUT_FIXTURE;
    if (fixturePath) {
      const scopedAnnual = __excelExportTestUtils.buildScopedAnnualSheet(
        2026,
        ['IDR'],
        snapshot,
        snapshot,
        reports,
        investment,
        { quantity: 0, unitValue: 0 },
        { quantity: 5, unitValue: 1000000 }
      );
      const scopedMonthly = __excelExportTestUtils.buildScopedMonthlySheet(populatedReport(), ['IDR'], investment);
      const bytes = await __excelExportTestUtils.buildXlsxBytes([
        scopedAnnual,
        scopedMonthly,
        {
          hidden: true,
          name: '_Data',
          rows: [[{ t: 'str', v: 'Date' }]],
        },
      ]);
      fs.writeFileSync(fixturePath, bytes);
    }
  });

  it('places complete start and end snapshots above income and spending', () => {
    const monthly = __excelExportTestUtils.buildMonthlySheet(report(7, false), ['IDR']);
    const rowValues = monthly.rows.map((row) => row.map((cell) => cell.v));
    const snapshotHeaderRow = rowValues.findIndex(
      (row) => row.includes('Start of Month') && row.includes('End of Month')
    );
    const lastSnapshotRow = rowValues.findIndex((row) => row.includes('Investment Category 4'));
    const incomeRecapRow = rowValues.findIndex((row) => row.includes('Income Recap'));

    expect(snapshotHeaderRow).toBe(1);
    expect(rowValues[2][0]).toBe('Nett Value');
    expect(rowValues[2][8]).toBe('Nett Value');
    expect(lastSnapshotRow).toBeGreaterThan(snapshotHeaderRow);
    expect(incomeRecapRow).toBeGreaterThan(lastSnapshotRow);
  });

  it('lists scoped yearly periods in one column, opening to closing', () => {
    const reports = Array.from({ length: 12 }, (_, index) => report(index + 1, index >= 7));
    const scoped = __excelExportTestUtils.buildScopedAnnualSheet(
      2026,
      ['IDR'],
      snapshot,
      snapshot,
      reports,
      null,
      null,
      null
    );
    const labels = scoped.rows.map((row) => row[0].v);

    expect(labels).toEqual([
      '2026 Annual',
      'Year Start',
      ...monthNames,
      'Year End',
    ]);
    // One column of labels and one of values: nothing is paired off to the right.
    expect(scoped.rows.every((row) => row.length === 2)).toBe(true);
    expect(scoped.rows.flat().map((cell) => cell.v)).not.toContain('Nett Value');
  });

  it('reports quantity, unit value and total per period for investment exports', () => {
    // Future starts in October here so August and September carry a real
    // position; the other fixtures cut off earlier.
    const reports = Array.from({ length: 12 }, (_, index) => report(index + 1, index >= 9));
    const scoped = __excelExportTestUtils.buildScopedAnnualSheet(
      2026,
      ['IDR'],
      snapshot,
      snapshot,
      reports,
      investment,
      { quantity: 0, unitValue: 0 },
      { quantity: 5, unitValue: 1000000 }
    );
    const rowFor = (label: string) => scoped.rows.find((row) => row[0].v === label);

    expect(scoped.rows[1].map((cell) => cell.v)).toEqual([null, 'Quantity (gram)', 'Value Per Unit', 'Total']);
    // Bought in August: every month before it is empty, not today's holding.
    expect(rowFor('February')?.map((cell) => cell.v)).toEqual(['February', 0, 0, 0]);
    expect(rowFor('August')?.map((cell) => cell.v)).toEqual(['August', 5, 100, 500]);
    expect(rowFor('Year End')?.map((cell) => cell.v)).toEqual(['Year End', 5, 100, 500]);
    // A month that has not happened yet reports nothing rather than a zero
    // holding.
    expect(rowFor('November')?.map((cell) => cell.v)).toEqual(['November', null, null, null]);
  });

  it('uses start/end values, category recaps, and transactions for scoped monthly exports', () => {
    const scoped = __excelExportTestUtils.buildScopedMonthlySheet(
      populatedReport(),
      ['IDR'],
      investment
    );
    const values = scoped.rows.flat().map((cell) => cell.v);
    const rowFor = (label: string) => scoped.rows.find((row) => row[0].v === label);

    expect(values).toContain('July');
    // The old hardcoded label next to the sheet title labelled nothing.
    expect(values).not.toContain('Start of Month:');
    expect(rowFor('Month Start')?.slice(0, 4).map((cell) => cell.v)).toEqual(['Month Start', 0, 0, 0]);
    expect(rowFor('Month End')?.slice(0, 4).map((cell) => cell.v)).toEqual(['Month End', 0, 0, 0]);
    expect(values).toContain('Income Recap');
    expect(values).toContain('Spending Recap');
    expect(values).not.toContain('Nett Value');
    expect(values).toContain('Date');
    expect(values).toContain('Income');
    expect(values).toContain('Spending');
    expect(values).toContain('Monthly interest');
    expect(values).toContain('Apple Music');
  });

  it('values an investment as nothing before its first history entry', () => {
    const before = __excelExportTestUtils.getInvestmentStateAt(investmentHistories, 1, new Date(2026, 1, 28));
    const after = __excelExportTestUtils.getInvestmentStateAt(investmentHistories, 1, new Date(2026, 7, 31));

    expect(before).toEqual({ quantity: 0, unitValue: 0 });
    expect(after).toEqual({ quantity: 5, unitValue: 1000000 });
  });

  it('keeps an investment out of the snapshot until it is bought', () => {
    const snapshotBefore = __excelExportTestUtils.buildSnapshot([], [investment], investmentHistories, new Date(2026, 1, 28), new Map());
    const snapshotAfter = __excelExportTestUtils.buildSnapshot([], [investment], investmentHistories, new Date(2026, 7, 31), new Map());
    const investmentTotal = (rows: { Label: string; ValueByCurrency: Map<string, number> }[]) =>
      rows.find((row) => row.Label === 'Investments')?.ValueByCurrency.get('IDR');

    expect(investmentTotal(snapshotBefore)).toBe(0);
    expect(investmentTotal(snapshotAfter)).toBe(500);
  });
});
