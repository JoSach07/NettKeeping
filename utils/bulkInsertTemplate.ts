import { getDBConnection } from '@/database/dbService';
import { isReservedCategoryId } from '@/database/tables/categories';
import { getConfiguredExportDirectory } from '@/utils/exportDirectory';
import { getMoneyDecimalPlaces } from '@/utils/moneyInput';
import { describeError } from '@/utils/userFacingError';
import {
  blank,
  buildXlsxBytes,
  colName,
  n,
  SheetValidation,
  styles,
  text,
  WorkbookDefinedName,
  WorkbookSheet,
} from '@/utils/xlsxWriter';

// The bulk insert template: two colour-coded blocks side by side, Income on
// the left and Spending on the right. Which block a row sits in IS its
// transaction type, which is why there is no Type column and why a category name
// that exists under both types is never ambiguous here.
//
// These constants are the contract between the template written here and the
// parser in utils/bulkInsertImport. Change one and the other stops matching.

export const templateSheetName = 'Bulk Insert';
export const templateTransferSheetName = 'Transfers';
// Visible and human-facing, unlike _Lists, which is hidden, machine-owned and
// whose ranges must stay sized to their lists.
export const templateInvestmentSheetName = 'Investments';
export const templateInfoSheetName = 'Info';
export const templateListsSheetName = '_Lists';
export const templateFileName = 'nettkeeping-bulk-insert-template.xlsx';

// Zero-based row indexes: group labels (row 0), then headers, then data.
export const templateHeaderRowIndex = 1;
export const templateFirstDataRowIndex = 2;

// How far the dropdowns reach. The range itself costs nothing in file size —
// it is one attribute, not one entry per cell — so this is purely about how
// many rows a user can fill before the dropdowns run out. Two blocks at 500
// stay under the parser's row cap even when both are full.
export const templateDataRowCount = 500;

// Column offsets within a block, and where each block starts. Column F (index
// 5) is the gutter between them.
export const templateFieldOffsets = {
  account: 4,
  amount: 3,
  category: 2,
  date: 0,
  description: 1,
};

export const templateIncomeColumn = 0;
export const templateSpendingColumn = 6;
export const templateColumnsPerBlock = 5;

// The asterisks and the bracketed date format are decoration for the user.
// The parser strips both before matching, so neither becomes part of the
// contract and a template downloaded before this label changed still reads.
export const templateHeaders = [
  'Date (DD/MM/YYYY)*',
  'Description',
  'Category*',
  'Amount*',
  'Account*',
];

// The Transfers sheet is one block rather than two, but it keeps the same
// label/header/data row layout so row numbers mean the same thing on both
// sheets and the shared row indexes above still apply.
//
// There is no category column: a transfer's two legs always use the reserved
// transfer categories, which the importer supplies. Received Amount is the
// only optional column — blank means "same as sent", which is every
// same-currency transfer.
export const templateTransferHeaders = [
  'Date (DD/MM/YYYY)*',
  'Description',
  'From Account*',
  'To Account*',
  'Sent Amount*',
  'Received Amount',
];

export const templateTransferFieldOffsets = {
  date: 0,
  description: 1,
  fromAccount: 2,
  receivedAmount: 5,
  sentAmount: 4,
  toAccount: 3,
};

// One block with a direction column rather than two colour-coded blocks: at
// seven columns a side that would be fifteen across, and buying and selling
// are the same event with opposite sign, not two different shapes.
//
// There is no amount column — the amount is derived (quantity x unit value,
// plus fees when buying, minus when selling), and asking for it as well would
// invite a total that disagrees with its own parts.
export const templateInvestmentHeaders = [
  'Date (DD/MM/YYYY)*',
  'Description',
  'Transaction Type*',
  'Account*',
  'Investment*',
  'Quantity*',
  'Value per Unit*',
  'Additional Fees',
];

export const templateInvestmentFieldOffsets = {
  account: 3,
  additionalFees: 7,
  date: 0,
  description: 1,
  direction: 2,
  investment: 4,
  quantity: 5,
  unitValue: 6,
};

// Short enough for an inline literal list, which the format caps at 255
// characters including the quotes.
export const templateBuyLabel = 'Buy';
export const templateSellLabel = 'Sell';

const incomeCategoriesDefinedName = 'NettKeepingIncomeCategories';
const spendingCategoriesDefinedName = 'NettKeepingSpendingCategories';
const accountsDefinedName = 'NettKeepingAccounts';
const investmentsDefinedName = 'NettKeepingInvestments';

const validationErrorTitle = 'Not in NettKeeping';
const validationError =
  'This name is not in NettKeeping yet. Create it in the app first, or the row will be rejected when the file is imported.';

export type TemplateAccount = {
  Code: string;
  Name: string;
  NumberToBasic: number;
};

export type TemplateInvestment = {
  Code: string;
  Name: string;
  NumberToBasic: number;
  QuantityDecimals: number;
  Unit: string | null;
};

export type TemplateLists = {
  accounts: TemplateAccount[];
  incomeCategories: string[];
  investments: TemplateInvestment[];
  spendingCategories: string[];
};

type TemplateResult = {
  Detail?: string;
  Message?: string;
  Status: 'Success' | 'Error';
  Uri?: string;
};

type CategoryNameRow = {
  Id: number;
  TransactionTypeId: number;
  Name: string;
};

const getTemplateLists = async (): Promise<TemplateLists> => {
  const db = await getDBConnection();

  const categories = await db.getAllAsync<CategoryNameRow>(
    `SELECT Id, Name, TransactionTypeId
     FROM Categories
     WHERE IsActive = 1
     ORDER BY Name COLLATE NOCASE`
  );
  const accounts = await db.getAllAsync<TemplateAccount>(
    `SELECT a.Name, cur.Code, cur.NumberToBasic
     FROM Accounts a
     INNER JOIN Currencies cur ON cur.Id = a.CurrencyId
     WHERE a.IsActive = 1
     ORDER BY a.Name COLLATE NOCASE`
  );
  const investments = await db.getAllAsync<TemplateInvestment>(
    `SELECT i.Name, i.Unit, i.QuantityDecimals, cur.Code, cur.NumberToBasic
     FROM Investments i
     INNER JOIN Currencies cur ON cur.Id = i.CurrencyId
     WHERE i.IsActive = 1
     ORDER BY i.Name COLLATE NOCASE`
  );

  // Reserved categories are excluded from the lists for the same reason
  // insertTransaction refuses them: transfers and investments have their own
  // flows, and a bulk row cannot carry the second account or the holding they
  // need.
  const selectableCategories = categories.filter((category) => !isReservedCategoryId(category.Id));

  return {
    accounts,
    investments,
    incomeCategories: selectableCategories
      .filter((category) => category.TransactionTypeId === 1)
      .map((category) => category.Name),
    spendingCategories: selectableCategories
      .filter((category) => category.TransactionTypeId === 2)
      .map((category) => category.Name),
  };
};

// A sheet that cannot produce a single valid row is worse than no sheet: the
// user fills it in and every row comes back rejected. Both of these are
// omitted entirely rather than shipped empty, and the popup says why rather
// than leaving their absence to be noticed.
//
// Not a performance measure — the Transfers sheet costs 16 microseconds to
// build and 1.9KB of XML, against the ~16ms the writer already spends
// yielding to the UI thread between sheets. This is only about not asking for
// work that cannot be used.
export const templateHasInvestments = (lists: TemplateLists) => lists.investments.length > 0;

// One account cannot transfer to itself, so a lone account makes every row on
// the sheet fail the same check.
export const templateHasTransfers = (lists: TemplateLists) => lists.accounts.length >= 2;

const buildListsSheet = (lists: TemplateLists): WorkbookSheet => {
  const rowCount = Math.max(
    lists.incomeCategories.length,
    lists.spendingCategories.length,
    lists.accounts.length,
    lists.investments.length
  );

  // The investments column only exists when the Investments sheet does, so
  // nothing here points at a range that was never written.
  const withInvestments = templateHasInvestments(lists);
  const headerRow = [
    text('Income Categories', styles.tableHeader),
    text('Spending Categories', styles.tableHeader),
    text('Accounts', styles.tableHeader),
  ];

  if (withInvestments) {
    headerRow.push(text('Investments', styles.tableHeader));
  }

  const rows = [headerRow];

  for (let index = 0; index < rowCount; index += 1) {
    const row = [
      text(lists.incomeCategories[index] ?? ''),
      text(lists.spendingCategories[index] ?? ''),
      text(lists.accounts[index]?.Name ?? ''),
    ];

    if (withInvestments) {
      row.push(text(lists.investments[index]?.Name ?? ''));
    }

    rows.push(row);
  }

  return {
    cols: withInvestments ? [26, 26, 26, 26] : [26, 26, 26],
    hidden: true,
    name: templateListsSheetName,
    rows,
  };
};

// Both separator conventions are accepted for text cells, and a numeric cell
// was already resolved by the spreadsheet app, so the example shows both
// rather than picking one and being wrong on half the world's locales.
const getAmountExample = (numberToBasic: number) =>
  (getMoneyDecimalPlaces({ Code: '', NumberToBasic: numberToBasic }) === 0
    ? '1257'
    : '12.57 or 12,57');

// Everything a filled-in row is checked against, in the file itself. The three
// notes below the table are the three things that actually generate errors.
const buildInfoSheet = (lists: TemplateLists): WorkbookSheet => {
  const rows = [
    [text('How to fill in the Bulk Insert sheet', styles.title)],
    [],
    [
      text('Account', styles.tableHeader),
      text('Currency', styles.tableHeader),
      text('Decimals allowed', styles.tableHeader),
      text('Example amount', styles.tableHeader),
    ],
  ];

  for (const account of lists.accounts) {
    rows.push([
      text(account.Name),
      text(account.Code),
      n(getMoneyDecimalPlaces({ Code: account.Code, NumberToBasic: account.NumberToBasic }), styles.default),
      text(getAmountExample(account.NumberToBasic)),
    ]);
  }

  rows.push(
    [],
    [text('Date', styles.tableHeader)],
    [text('Format the cell as a date, or type it as DD/MM/YYYY (for example 21/08/2026).')],
    [text('Day comes first: 03/04/2026 is 3 April, not 8 March. YYYY-MM-DD is accepted too.')],
    [text('Write the year in full. A two-digit year like 21/08/26 is refused.')],
    [],
    [text('Amount', styles.tableHeader)],
    [text('No currency symbols. Grouped thousands are fine, and 1.257 and 1,257 both mean 1257.')],
    [text('Group in threes if you group at all. Something like 2.500.37 is refused, because it is neither 250037 nor 2.500,37.')],
    [text('A cell can show fewer decimals than it holds. Wrap a calculated amount in ROUND() or it will be refused.')],
  );

  if (templateHasTransfers(lists)) {
    rows.push(
      [],
      [text('Transfers sheet', styles.tableHeader)],
      [text('One row moves money between two of your accounts. It needs no category: transfers use their own.')],
      [text('Leave Received Amount blank when both accounts use the same currency. It is required when they differ.')],
      [text('Received Amount is what actually lands in the To account, not a rate. Work it out in the sheet if you like: =ROUND(E3/16000,2).')]
    );
  } else {
    rows.push(
      [],
      [text('Transfers sheet', styles.tableHeader)],
      [text('Not included: transfers need two accounts to move money between. Create another account in the app, then download the template again.')]
    );
  }

  // Only describe a sheet that is actually in the file.
  if (templateHasInvestments(lists)) {
    rows.push(
      [],
      [text('Investments sheet', styles.tableHeader)],
      [text('Transaction Type is Buy or Sell, then the account the money moves through and the investment being traded.')],
      [text('The investment and the account must use the same currency. Pair them using the table below.')],
      [],
      [
        text('Investment', styles.tableHeader),
        text('Currency', styles.tableHeader),
        text('Unit', styles.tableHeader),
        text('Quantity decimals', styles.tableHeader),
      ],
      // Without this the sheet states a rule the file gives no way to follow:
      // the accounts table above lists each account's currency, but nothing
      // said which currency an investment is held in.
      ...lists.investments.map((investment) => [
        text(investment.Name),
        text(investment.Code),
        text(investment.Unit ?? '—'),
        n(investment.QuantityDecimals, styles.default),
      ]),
      [],
      [text('Quantity may have up to the number of decimals shown for its investment (0 means whole units only).')],
      [text('Value per Unit is the price of one unit, in that currency, with up to 4 more decimals than the currency allows.')],
      [text('The transaction amount is worked out for you: quantity x value per unit, plus fees when buying and minus fees when selling.')],
      [text('Additional Fees may be left blank, which means none.')]
    );
  } else {
    rows.push(
      [],
      [text('Investments sheet', styles.tableHeader)],
      [text('Not included: there are no investments in NettKeeping yet. Create one in the app, then download the template again.')]
    );
  }

  rows.push(
    [],
    [text('Rows', styles.tableHeader)],
    [text('Accounts and categories must already exist in NettKeeping. Pick them from the dropdowns.')],
    [text('Reserved transfer and investment categories cannot be used on the Bulk Insert sheet. Use the sheet made for them.')],
    [text('If any row is invalid, nothing is imported until it is fixed.')],
    [text('Account and Categories are copied from when this template was downloaded. If you don\'t see an account or category, please redownload the template from the NettKeeping app.')]
  );

  return {
    cols: [30, 12, 18, 22],
    name: templateInfoSheetName,
    rows,
  };
};

// Ranges are sized to the exact number of entries: a range longer than the
// list shows trailing blank options in the dropdown.
const buildDefinedNames = (lists: TemplateLists): WorkbookDefinedName[] => {
  const definedNames: WorkbookDefinedName[] = [];
  const addDefinedName = (name: string, column: string, count: number) => {
    if (count === 0) {
      return;
    }

    definedNames.push({
      name,
      refersTo: `'${templateListsSheetName}'!$${column}$2:$${column}$${count + 1}`,
    });
  };

  addDefinedName(incomeCategoriesDefinedName, 'A', lists.incomeCategories.length);
  addDefinedName(spendingCategoriesDefinedName, 'B', lists.spendingCategories.length);
  addDefinedName(accountsDefinedName, 'C', lists.accounts.length);
  addDefinedName(investmentsDefinedName, 'D', lists.investments.length);

  return definedNames;
};

const buildTemplateSheet = (lists: TemplateLists): WorkbookSheet => {
  const lastColumn = templateSpendingColumn + templateColumnsPerBlock;
  const groupRow = new Array(lastColumn).fill(null).map(() => blank());
  const headerRow = new Array(lastColumn).fill(null).map(() => blank());

  // The whole width of each block carries the fill, not just the label cell,
  // so the two groups read as blocks at a glance.
  for (let offset = 0; offset < templateColumnsPerBlock; offset += 1) {
    groupRow[templateIncomeColumn + offset] = text(offset === 0 ? 'Income' : '', styles.incomeHeader);
    groupRow[templateSpendingColumn + offset] = text(offset === 0 ? 'Spending' : '', styles.spendingHeader);
    headerRow[templateIncomeColumn + offset] = text(templateHeaders[offset], styles.tableHeader);
    headerRow[templateSpendingColumn + offset] = text(templateHeaders[offset], styles.tableHeader);
  }

  const firstRow = templateFirstDataRowIndex + 1;
  const lastRow = templateFirstDataRowIndex + templateDataRowCount;
  const validations: SheetValidation[] = [];
  const addValidation = (columnIndex: number, definedName: string, hasEntries: boolean) => {
    if (!hasEntries) {
      return;
    }

    const column = colName(columnIndex);
    validations.push({
      error: validationError,
      errorTitle: validationErrorTitle,
      formula: definedName,
      sqref: `${column}${firstRow}:${column}${lastRow}`,
    });
  };

  addValidation(
    templateIncomeColumn + templateFieldOffsets.category,
    incomeCategoriesDefinedName,
    lists.incomeCategories.length > 0
  );
  addValidation(
    templateIncomeColumn + templateFieldOffsets.account,
    accountsDefinedName,
    lists.accounts.length > 0
  );
  addValidation(
    templateSpendingColumn + templateFieldOffsets.category,
    spendingCategoriesDefinedName,
    lists.spendingCategories.length > 0
  );
  addValidation(
    templateSpendingColumn + templateFieldOffsets.account,
    accountsDefinedName,
    lists.accounts.length > 0
  );

  // Data rows are left out of the sheet entirely rather than emitted empty:
  // a styled blank cell is still a cell, and 500 rows of them across two
  // blocks would bloat the file and blur the line between a filled row and an
  // untouched one.
  return {
    // The date columns are wider than their content needs so the
    // "(DD/MM/YYYY)" in the header is readable without resizing.
    cols: [21, 30, 22, 16, 22, 4, 21, 30, 22, 16, 22],
    name: templateSheetName,
    rows: [groupRow, headerRow],
    validations,
  };
};

// One block rather than two, but the same three-row shape, so a row number
// means the same thing here as on the transactions sheet.
const buildTransferSheet = (lists: TemplateLists): WorkbookSheet => {
  const columnCount = templateTransferHeaders.length;
  const labelRow = new Array(columnCount).fill(null).map((_, index) =>
    text(index === 0 ? 'Transfers' : '', styles.transferHeader));
  const headerRow = templateTransferHeaders.map((header) => text(header, styles.tableHeader));

  const firstRow = templateFirstDataRowIndex + 1;
  const lastRow = templateFirstDataRowIndex + templateDataRowCount;
  const validations: SheetValidation[] = [];

  if (lists.accounts.length > 0) {
    for (const offset of [templateTransferFieldOffsets.fromAccount, templateTransferFieldOffsets.toAccount]) {
      const column = colName(offset);
      validations.push({
        error: validationError,
        errorTitle: validationErrorTitle,
        formula: accountsDefinedName,
        sqref: `${column}${firstRow}:${column}${lastRow}`,
      });
    }
  }

  return {
    cols: [21, 30, 22, 22, 18, 20],
    name: templateTransferSheetName,
    rows: [labelRow, headerRow],
    validations,
  };
};

// Same three-row shape again. The direction column uses an inline literal
// list rather than a range: two fixed values are not data, and putting them on
// _Lists would imply they could change.
const buildInvestmentSheet = (lists: TemplateLists): WorkbookSheet => {
  const columnCount = templateInvestmentHeaders.length;
  const labelRow = new Array(columnCount).fill(null).map((_, index) =>
    text(index === 0 ? 'Investments' : '', styles.investmentHeader));
  const headerRow = templateInvestmentHeaders.map((header) => text(header, styles.tableHeader));

  const firstRow = templateFirstDataRowIndex + 1;
  const lastRow = templateFirstDataRowIndex + templateDataRowCount;
  const validations: SheetValidation[] = [];
  const addValidation = (offset: number, formula: string, hasEntries: boolean) => {
    if (!hasEntries) {
      return;
    }

    const column = colName(offset);
    validations.push({
      error: validationError,
      errorTitle: validationErrorTitle,
      formula,
      sqref: `${column}${firstRow}:${column}${lastRow}`,
    });
  };

  addValidation(
    templateInvestmentFieldOffsets.direction,
    `"${templateBuyLabel},${templateSellLabel}"`,
    true
  );
  addValidation(templateInvestmentFieldOffsets.account, accountsDefinedName, lists.accounts.length > 0);
  addValidation(templateInvestmentFieldOffsets.investment, investmentsDefinedName, lists.investments.length > 0);

  return {
    // The Transaction Type column is sized for its own header rather than its
    // content, which is only ever "Buy" or "Sell".
    cols: [21, 30, 20, 22, 24, 14, 18, 18],
    name: templateInvestmentSheetName,
    rows: [labelRow, headerRow],
    validations,
  };
};

export const buildBulkInsertTemplateBytes = async (lists: TemplateLists) =>
  buildXlsxBytes(
    [
      buildTemplateSheet(lists),
      ...(templateHasTransfers(lists) ? [buildTransferSheet(lists)] : []),
      ...(templateHasInvestments(lists) ? [buildInvestmentSheet(lists)] : []),
      buildInfoSheet(lists),
      buildListsSheet(lists),
    ],
    buildDefinedNames(lists)
  );

export type BulkInsertAvailability = {
  accountCount: number;
  investmentCount: number;
};

// What the popup needs to explain, before anything is generated, which sheets
// the template will and will not contain.
export const getBulkInsertAvailability = async (): Promise<BulkInsertAvailability> => {
  const db = await getDBConnection();
  const counts = await db.getFirstAsync<BulkInsertAvailability>(
    `SELECT
        (SELECT COUNT(*) FROM Accounts WHERE IsActive = 1) AS accountCount,
        (SELECT COUNT(*) FROM Investments WHERE IsActive = 1) AS investmentCount`
  );

  return {
    accountCount: counts?.accountCount ?? 0,
    investmentCount: counts?.investmentCount ?? 0,
  };
};

export const exportBulkInsertTemplate = async (): Promise<TemplateResult> => {
  try {
    const lists = await getTemplateLists();

    if (lists.accounts.length === 0) {
      return {
        Status: 'Error',
        Message: 'Create an account before using bulk insert. Rows cannot be imported without one.',
      };
    }

    if (lists.incomeCategories.length === 0 && lists.spendingCategories.length === 0) {
      return {
        Status: 'Error',
        Message: 'Create at least one income or spending category before using bulk insert.',
      };
    }

    const directory = await getConfiguredExportDirectory();
    const bytes = await buildBulkInsertTemplateBytes(lists);
    const file = directory.createFile(
      templateFileName,
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
      // Same split as the report export: getConfiguredExportDirectory's
      // "not configured" guidance is already user-facing and survives, and
      // anything else is internal and goes behind the Details toggle.
      ...describeError(error, 'Failed to create the bulk insert template.'),
    };
  }
};

