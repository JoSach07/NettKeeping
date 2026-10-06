import { File } from 'expo-file-system';

import { getDBConnection } from '@/database/dbService';
import { isReservedCategoryId } from '@/database/tables/categories';
import { futureTransactionDateMessage, isFutureTransactionDate } from '@/database/tables/transactions';
import { runWithAppLockSuspended } from '@/utils/appLockSuspension';
import {
  templateFieldOffsets,
  templateFirstDataRowIndex,
  templateHeaderRowIndex,
  templateHeaders,
  templateIncomeColumn,
  templateSheetName,
  templateSpendingColumn,
  templateBuyLabel,
  templateInvestmentFieldOffsets,
  templateInvestmentHeaders,
  templateInvestmentSheetName,
  templateSellLabel,
  templateTransferFieldOffsets,
  templateTransferHeaders,
  templateTransferSheetName,
} from '@/utils/bulkInsertTemplate';
import { formatDbDate } from '@/utils/dbDate';
import {
  getMoneyDecimalPlaces,
  getMoneyPrecisionError,
  parseMoneyInputToMinorUnits,
} from '@/utils/moneyInput';
import {
  calculateInvestmentAmount,
  getQuantityPrecisionError,
  getUnitValueCurrency,
  normalizeQuantityDecimals,
  parseQuantityInput,
  spreadsheetNumberToScaled,
} from '@/utils/investmentNumbers';
import { describeFileReadError, isAppOwnedDocumentType, UserFacingError } from '@/utils/userFacingError';
import { readXlsx, XlsxCell, XlsxSheet, xlsxSerialToDateParts } from '@/utils/xlsxReader';

// Reads a filled-in bulk insert template and turns it into candidate
// transactions. Nothing here writes: the result feeds the preview, and only the
// confirmed preview reaches insertBulkImport.
//
// Every row is checked against the live database rather than against the lists
// baked into the template, because the template is a snapshot from whenever it
// was downloaded and the user may have renamed or deactivated things since.

// A template full on both sides is 1,000 rows. The cap counts rows that
// actually carry data, not row elements in the file: spreadsheet apps leave
// husks behind wherever a user clicked, and rejecting a file for cells it does
// not contain would be indefensible.
const maxImportRows = 2000;
// A filled template is a few hundred KB at most. This bounds how much of an
// unknown file is pulled into memory before anything else happens — the whole
// package is decompressed in JS, so an unbounded read is an out-of-memory
// crash rather than an error message.
const maxImportFileBytes = 8 * 1024 * 1024;

export type BulkInsertRow = {
  accountId: number;
  accountName: string;
  amountMinorUnits: number;
  // Set only when the amount's separators could have been read another way,
  // so the preview can mark that row instead of asking for every row to be
  // audited. Null for a plainly typed number, which is nearly all of them.
  amountNote: string | null;
  categoryId: number;
  categoryName: string;
  currencyCode: string;
  currencyNumberToBasic: number;
  description: string | null;
  isIncome: boolean;
  transactionDate: string;
  rowLabel: string;
};

// A transfer is one row here and two Transactions rows in the database, so it
// carries both accounts and both amounts. The amounts are independent: a
// cross-currency transfer sends one number and receives another, and each is
// held in its own account's currency.
export type BulkTransferRow = {
  amountNote: string | null;
  description: string | null;
  fromAccountId: number;
  fromAccountName: string;
  fromAmountMinorUnits: number;
  fromCurrencyCode: string;
  fromCurrencyNumberToBasic: number;
  transactionDate: string;
  rowLabel: string;
  toAccountId: number;
  toAccountName: string;
  toAmountMinorUnits: number;
  toCurrencyCode: string;
  toCurrencyNumberToBasic: number;
};

// An investment row carries its parts, not a total: the amount that reaches
// the account is derived (quantity x unit value, fees added when buying and
// subtracted when selling) and is recomputed inside the transaction rather
// than trusted from here.
export type BulkInvestmentRow = {
  accountId: number;
  accountName: string;
  additionalFeesMinorUnits: number;
  amountNote: string | null;
  currencyCode: string;
  currencyNumberToBasic: number;
  description: string | null;
  investmentId: number;
  investmentName: string;
  isBuy: boolean;
  transactionAmountMinorUnits: number;
  transactionDate: string;
  // Scaled by quantityDecimals (utils/investmentNumbers).
  quantity: number;
  quantityDecimals: number;
  rowLabel: string;
  unit: string | null;
  // Currency minor units x 10^4.
  unitValueMinorUnits: number;
};

export type BulkInsertRowError = {
  message: string;
  rowLabel: string;
};

export type BulkInsertPreviewResult = {
  Detail?: string;
  Errors?: BulkInsertRowError[];
  Investments?: BulkInvestmentRow[];
  Message?: string;
  Rows?: BulkInsertRow[];
  Status: 'Success' | 'Error';
  Transfers?: BulkTransferRow[];
};

export type BulkInsertFileResult = {
  Detail?: string;
  Message?: string;
  Status: 'Success' | 'Error' | 'Cancelled';
  Uri?: string;
};

type AccountLookupRow = {
  Code: string;
  CurrencyId: number;
  Id: number;
  Name: string;
  NumberToBasic: number;
};

type CategoryLookupRow = {
  Id: number;
  TransactionTypeId: number;
  Name: string;
};

type InvestmentLookupRow = {
  Code: string;
  CurrencyId: number;
  Id: number;
  Name: string;
  NumberToBasic: number;
  QuantityDecimals: number;
  Unit: string | null;
};

// Either a usable value or the reason there isn't one, never both. A note is
// carried alongside a value when the reading was a judgement call rather than
// a plain conversion, so the preview can point at exactly those rows.
type ParseResult<T> = {
  error?: string;
  note?: string;
  value?: T;
};

type BlockDefinition = {
  isIncome: boolean;
  label: string;
  transactionTypeId: number;
  startColumn: number;
};

const blocks: BlockDefinition[] = [
  { isIncome: true, label: 'Income', transactionTypeId: 1, startColumn: templateIncomeColumn },
  { isIncome: false, label: 'Spending', transactionTypeId: 2, startColumn: templateSpendingColumn },
];

const emptyCell: XlsxCell = {
  isDateFormatted: false,
  number: null,
  text: '',
  type: 'empty',
};

// Asterisks and the bracketed format hint are decoration. Stripping them here
// keeps the label free to change without invalidating templates already sitting
// in someone's downloads folder.
const normalizeHeader = (value: string) =>
  value.replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim().toLowerCase();
const normalizeName = (value: string) => value.trim().toLowerCase();

const assertReadableImportSize = (sizeInBytes: number) => {
  if (sizeInBytes <= 0) {
    throw new UserFacingError('This file is empty or cannot be read.');
  }

  if (sizeInBytes > maxImportFileBytes) {
    throw new UserFacingError('This file is larger than NettKeeping can import.');
  }
};

const getCell = (row: XlsxCell[] | undefined, columnIndex: number) => row?.[columnIndex] ?? emptyCell;

// Names are matched case-insensitively, so two active rows differing only in
// case are genuinely ambiguous and neither can be picked for the user.
const buildLookup = <T extends { Name: string }>(rows: T[]) => {
  const byName = new Map<string, T>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const key = normalizeName(row.Name);

    if (byName.has(key)) {
      duplicates.add(key);
      continue;
    }

    byName.set(key, row);
  }

  return { byName, duplicates };
};

// Caught here, per row, rather than only by the database guard: a whole import
// refused for one mistyped year would say nothing about which row to fix.
const toDateResult = (transactionDate: string): ParseResult<string> => (
  isFutureTransactionDate(transactionDate)
    ? { error: futureTransactionDateMessage }
    : { value: transactionDate }
);

const parseRowDate = (cell: XlsxCell, date1904: boolean): ParseResult<string> => {
  if (cell.type === 'number' && cell.number !== null) {
    if (cell.number <= 0) {
      return { error: 'Date is not a real date.' };
    }

    const { day, month, year } = xlsxSerialToDateParts(cell.number, date1904);
    // Back through a local Date so the stored value is a local calendar day,
    // the same convention every other write in the app uses.
    return toDateResult(formatDbDate(new Date(year, month - 1, day)));
  }

  const text = cell.text.trim();
  if (!text) {
    return { error: 'Date is required.' };
  }

  // Two written forms are accepted, and neither is a guess: the column header
  // states DD/MM/YYYY, and YYYY-MM-DD is unambiguous by shape. Day-first is
  // what the template declares, so 03/04/2026 is 3 April — a reader who
  // assumes month-first has been told otherwise by the header and the Info
  // sheet. Separator is free (/, - or .) once the shape is fixed.
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dayFirstMatch = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);

  const parts = isoMatch
    ? { day: isoMatch[3], month: isoMatch[2], year: isoMatch[1] }
    : dayFirstMatch
      ? { day: dayFirstMatch[1], month: dayFirstMatch[2], year: dayFirstMatch[3] }
      : null;

  if (!parts) {
    // Covers a two-digit year too, which is refused rather than assigned a
    // century. The template header and the Info sheet both carry the format,
    // so the message does not repeat it.
    return { error: 'Invalid date format.' };
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { error: `Date ${text} is not a real calendar date.` };
  }

  return toDateResult(formatDbDate(date));
};

// Numeric cells carry their own decimal text in the file, which is used in
// preference to the parsed float: reformatting a float can introduce digits
// that were never typed. Note that a spreadsheet stores full precision and
// formats separately, so a cell displaying 12.57 may well hold 12.5678 — the
// stored value is what gets validated, and the difference is why a computed
// amount column should be wrapped in ROUND().
const getNumericAmountText = (cell: XlsxCell): ParseResult<string> => {
  if (cell.number === null) {
    return {};
  }

  if (/^[-+]?\d+(\.\d+)?$/.test(cell.text)) {
    return { value: cell.text.replace(/^\+/, '') };
  }

  const asText = cell.number.toString();

  // toString only reaches for exponents beyond 1e21, which no realistic
  // amount does. Refused explicitly rather than mangled into digits.
  return /e/i.test(asText)
    ? { error: 'Amount is too large to import.' }
    : { value: asText };
};

const digitsOnly = (value: string) => value.replace(/\D/g, '');

// Separators being discarded as grouping have to have been grouping in the
// first place: every group after the leading one must be exactly three digits.
// Without this, "2.500.37" reads as two grouping marks and imports as 250037 —
// a hundredfold error from what was almost certainly a typo for 2.500,37. It
// is neither a grouped thousand nor a decimal, so it is refused rather than
// silently flattened.
const hasWellFormedGrouping = (wholePart: string) => {
  const groups = wholePart.split(/[.,]/);

  if (groups.length === 1) {
    return true;
  }

  return groups[0].length >= 1
    && groups[0].length <= 3
    && groups.slice(1).every((group) => group.length === 3);
};

// Text amount cells are the only place separators still have to be
// interpreted — a numeric cell was already resolved by the spreadsheet app
// using the OS locale, and reaches us as a plain number. Four rules, applied
// in order:
//
//   1. Both separators present -> the RIGHTMOST is the decimal separator and
//      the other is grouping. "1,257.00" and "1.257,00" are both 1257.
//   2. One kind of separator, more than once -> grouping. "1.234.567" is
//      1234567. The groups must be three digits wide, so a malformed
//      "2.500.37" is refused instead of flattened to 250037.
//   3. One separator, once, NOT followed by exactly three digits -> decimal.
//      "1,25700" is 1.25700, which then fails the precision check.
//   4. One separator, once, followed by exactly three digits -> structurally
//      ambiguous: "1,257" is either 1257 or 1.257. The currency settles it —
//      three decimals is invalid for every currency NettKeeping has (Currencies is
//      seeded read-only at NumberToBasic 1 or 100), so grouping is the only
//      reading that can be valid. A 3-decimal currency would be genuinely
//      ambiguous, so it is refused rather than guessed at.
//
// Deliberately NOT sanitizeMoneyInput: that runs on every keystroke of every
// money field in the app and its convention cannot be changed from here.
const parseSeparatedAmountText = (
  rawText: string,
  currency: { Code: string; NumberToBasic: number }
): ParseResult<string> => {
  // Currency symbols, spaces and non-breaking spaces from pasted values go
  // first; only digits and separators carry meaning.
  const cleaned = rawText.replace(/[^\d.,]/g, '');

  if (!/\d/.test(cleaned)) {
    return {};
  }

  const dotCount = (cleaned.match(/\./g) ?? []).length;
  const commaCount = (cleaned.match(/,/g) ?? []).length;

  if (dotCount === 0 && commaCount === 0) {
    return { value: cleaned };
  }

  let decimalIndex: number | null = null;
  // Set when rule 4 fires. Those are the only rows where the separator could
  // have meant something else, so they are the only ones worth flagging for
  // review — a file of plainly typed numbers flags nothing.
  let wasAmbiguous = false;

  if (dotCount > 0 && commaCount > 0) {
    decimalIndex = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  } else {
    const separatorIndex = dotCount > 0 ? cleaned.lastIndexOf('.') : cleaned.lastIndexOf(',');
    const separatorCount = dotCount > 0 ? dotCount : commaCount;
    const digitsAfter = cleaned.length - separatorIndex - 1;

    if (separatorCount > 1) {
      decimalIndex = null;
    } else if (digitsAfter !== 3) {
      decimalIndex = separatorIndex;
    } else if (getMoneyDecimalPlaces(currency) < 3) {
      decimalIndex = null;
      wasAmbiguous = true;
    } else {
      return {
        error: `Amount "${rawText.trim()}" could be read two ways. Write it without a thousands separator.`,
      };
    }
  }

  const rawWholePart = decimalIndex === null ? cleaned : cleaned.slice(0, decimalIndex);

  if (!hasWellFormedGrouping(rawWholePart)) {
    return {
      error: `Amount "${rawText.trim()}" could not be read. Write it as a plain number, or group it in threes (1.234.567,89 or 1,234,567.89).`,
    };
  }

  const wholePart = digitsOnly(rawWholePart) || '0';
  const decimalPart = decimalIndex === null ? '' : digitsOnly(cleaned.slice(decimalIndex + 1));
  const value = decimalPart ? `${wholePart}.${decimalPart}` : wholePart;

  return {
    note: wasAmbiguous ? `"${rawText.trim()}" read as ${value}` : undefined,
    value,
  };
};

const parseRowAmount = (
  cell: XlsxCell,
  currency: { Code: string; NumberToBasic: number }
): ParseResult<number> => {
  if (cell.type === 'empty') {
    return { error: 'Amount is required.' };
  }

  const amountResult = cell.type === 'number'
    ? getNumericAmountText(cell)
    : parseSeparatedAmountText(cell.text, currency);

  if (amountResult.error) {
    return { error: amountResult.error };
  }

  const amountText = amountResult.value;

  if (!amountText) {
    // Reached by a cell holding something like "n/a" or "TBD", which is a
    // different mistake from leaving it blank.
    return { error: 'Invalid amount.' };
  }

  if (amountText.startsWith('-')) {
    return { error: 'Amount must be greater than zero.' };
  }

  // Precision is judged on the digits that carry value, not on how many the
  // cell happens to print. A spreadsheet writes 1500000.00 for a whole number
  // as readily as 1500000, and refusing the first while accepting the second
  // would be indefensible — the two are the same amount.
  //
  // What is still refused is a fraction the currency cannot hold: IDR 12.5 has
  // a real 5 after the point and would otherwise be stored as 125 by
  // parseMoneyInputToMinorUnits, which strips every non-digit for zero-decimal
  // currencies. The money fields never hit that because they sanitise each
  // keystroke; a spreadsheet cell has had no such filtering.
  //
  // amountText is canonical by this point — a single '.' at most, whatever the
  // cell used — so splitting on it is safe.
  const decimalPlaces = getMoneyDecimalPlaces(currency);
  const [wholeText, decimalText = ''] = amountText.split('.');
  const significantDecimals = decimalText.replace(/0+$/, '');

  if (significantDecimals.length > decimalPlaces) {
    return { error: getMoneyPrecisionError(currency) };
  }

  const normalizedAmount = significantDecimals ? `${wholeText}.${significantDecimals}` : wholeText;

  const minorUnits = parseMoneyInputToMinorUnits(normalizedAmount, currency);

  if (minorUnits === null) {
    return { error: 'Invalid amount.' };
  }

  if (minorUnits <= 0) {
    return { error: 'Amount must be greater than zero.' };
  }

  return { note: amountResult.note, value: minorUnits };
};

const hasTemplateHeaders = (sheet: XlsxSheet) => {
  const headerRow = sheet.rows[templateHeaderRowIndex];

  if (!headerRow) {
    return false;
  }

  const expected = templateHeaders.map(normalizeHeader);
  const matchesBlock = (startColumn: number) =>
    expected.every((header, offset) => normalizeHeader(getCell(headerRow, startColumn + offset).text) === header);

  return matchesBlock(templateIncomeColumn) && matchesBlock(templateSpendingColumn);
};

const hasTransferHeaders = (sheet: XlsxSheet) => {
  const headerRow = sheet.rows[templateHeaderRowIndex];

  if (!headerRow) {
    return false;
  }

  return templateTransferHeaders
    .map(normalizeHeader)
    .every((header, offset) => normalizeHeader(getCell(headerRow, offset).text) === header);
};

// The fallback matches on headers rather than taking the first visible sheet:
// the template ships a visible Info sheet and a visible Transfers sheet, so
// "first visible" would happily pick either if the user renamed the one they
// filled in. Matching on headers also means the two data sheets can never be
// mistaken for one another.
const findSheet = (sheets: XlsxSheet[], name: string, matches: (sheet: XlsxSheet) => boolean) =>
  sheets.find((sheet) => sheet.name === name && matches(sheet))
  ?? sheets.find((sheet) => !sheet.hidden && matches(sheet))
  ?? null;

const findTemplateSheet = (sheets: XlsxSheet[]) =>
  findSheet(sheets, templateSheetName, hasTemplateHeaders);

const hasInvestmentHeaders = (sheet: XlsxSheet) => {
  const headerRow = sheet.rows[templateHeaderRowIndex];

  if (!headerRow) {
    return false;
  }

  return templateInvestmentHeaders
    .map(normalizeHeader)
    .every((header, offset) => normalizeHeader(getCell(headerRow, offset).text) === header);
};

// Absent rather than required: a template downloaded before the Transfers
// sheet existed is still a perfectly good transactions file.
const findTransferSheet = (sheets: XlsxSheet[]) =>
  findSheet(sheets, templateTransferSheetName, hasTransferHeaders);

const findInvestmentSheet = (sheets: XlsxSheet[]) =>
  findSheet(sheets, templateInvestmentSheetName, hasInvestmentHeaders);

// Quantity carries the investment's own decimals (0-8). A number cell is a
// float, so it is scaled and ROUNDED (spreadsheetNumberToScaled) — never
// multiplied and truncated, which turns 0.29 into 0.28 — and refused when it
// has a real digit beyond what the investment allows. A text cell goes through
// the same separator rules as amounts, then the same precision check.
const parseQuantity = (cell: XlsxCell, quantityDecimals: number): ParseResult<number> => {
  if (cell.type === 'empty') {
    return { error: 'Quantity is required.' };
  }

  const decimals = normalizeQuantityDecimals(quantityDecimals);
  let quantity: number | null;

  if (cell.type === 'number' && cell.number !== null) {
    const scaled = spreadsheetNumberToScaled(cell.number, decimals);
    if (scaled === 'too-precise') {
      return { error: getQuantityPrecisionError(decimals) };
    }
    quantity = scaled;
  } else {
    // Only the decimal count matters to the separator rules here.
    const textResult = parseSeparatedAmountText(cell.text, { Code: '', NumberToBasic: 10 ** decimals });
    if (textResult.error) {
      return { error: textResult.error.replace(/^Amount/, 'Quantity') };
    }
    if (!textResult.value) {
      return { error: `Quantity "${cell.text.trim()}" could not be read.` };
    }
    const [wholeText, fractionText = ''] = textResult.value.split('.');
    const significantFraction = fractionText.replace(/0+$/, '');
    if (significantFraction.length > decimals) {
      return { error: getQuantityPrecisionError(decimals) };
    }
    quantity = parseQuantityInput(significantFraction ? `${wholeText}.${significantFraction}` : wholeText, decimals);
  }

  if (quantity === null) {
    return { error: 'Quantity is too large to import.' };
  }

  if (quantity <= 0) {
    return { error: 'Quantity must be greater than zero.' };
  }

  return { value: quantity };
};

const appOwnedDocumentMessage =
  "This file can't be opened directly as it's a document from another app, such as Google Sheets.\n\n" +
  'To use this file, please download or export it as an .xlsx file, and pick that file.';

export const selectBulkInsertFile = async (): Promise<BulkInsertFileResult> => {
  try {
    const pickedFile = await runWithAppLockSuspended(() =>
      File.pickFileAsync({
        mimeTypes: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/octet-stream',
          '*/*',
        ],
      })
    );

    if (pickedFile.canceled) {
      return { Status: 'Cancelled' };
    }

    // Checked before anything is read: the picker accepts any file type.
    if (isAppOwnedDocumentType(pickedFile.result.type)) {
      throw new UserFacingError(appOwnedDocumentMessage);
    }

    assertReadableImportSize(pickedFile.result.size);

    return {
      Status: 'Success',
      Uri: pickedFile.result.uri,
    };
  } catch (error) {
    return {
      Status: 'Error',
      ...describeFileReadError(error, 'Selected file could not be read.', appOwnedDocumentMessage),
    };
  }
};

export const readBulkInsertFile = async (fileUri: string): Promise<BulkInsertPreviewResult> => {
  try {
    // Re-checked rather than trusted from the pick: nothing guarantees this is
    // still the file that was picked.
    const sourceFile = new File(fileUri);
    assertReadableImportSize(sourceFile.size);

    const workbook = await readXlsx(await sourceFile.bytes());
    const sheet = findTemplateSheet(workbook.sheets);

    if (!sheet) {
      throw new UserFacingError(
        'This file does not match the bulk insert template. Download a fresh template and fill that in.'
      );
    }

    const db = await getDBConnection();
    const accountRows = await db.getAllAsync<AccountLookupRow>(
      `SELECT a.Id, a.Name, a.CurrencyId, cur.Code, cur.NumberToBasic
       FROM Accounts a
       INNER JOIN Currencies cur ON cur.Id = a.CurrencyId
       WHERE a.IsActive = 1`
    );
    const categoryRows = await db.getAllAsync<CategoryLookupRow>(
      `SELECT Id, Name, TransactionTypeId
       FROM Categories
       WHERE IsActive = 1`
    );

    const accounts = buildLookup(accountRows);
    // Kept aside so a row naming a transfer or investment category can be told
    // it used the wrong screen, rather than that the name does not exist.
    const reservedCategoryNames = new Set(
      categoryRows
        .filter((category) => isReservedCategoryId(category.Id))
        .map((category) => normalizeName(category.Name))
    );
    const categoriesByType = new Map(
      blocks.map((block) => [
        block.transactionTypeId,
        buildLookup(
          categoryRows.filter(
            (category) =>
              category.TransactionTypeId === block.transactionTypeId && !isReservedCategoryId(category.Id)
          )
        ),
      ])
    );

    const rows: BulkInsertRow[] = [];
    const errors: BulkInsertRowError[] = [];

    for (const block of blocks) {
      const categories = categoriesByType.get(block.transactionTypeId);

      for (let rowIndex = templateFirstDataRowIndex; rowIndex < sheet.rows.length; rowIndex += 1) {
        const sheetRow = sheet.rows[rowIndex];
        const cells = {
          account: getCell(sheetRow, block.startColumn + templateFieldOffsets.account),
          amount: getCell(sheetRow, block.startColumn + templateFieldOffsets.amount),
          category: getCell(sheetRow, block.startColumn + templateFieldOffsets.category),
          date: getCell(sheetRow, block.startColumn + templateFieldOffsets.date),
          description: getCell(sheetRow, block.startColumn + templateFieldOffsets.description),
        };

        // A row is present only if one of its own block's cells carries a
        // value. Husks left by clicking around, and rows filled in on the
        // other block, both read as absent here.
        const isEmptyRow = Object.values(cells).every((cell) => cell.type === 'empty');
        if (isEmptyRow) {
          continue;
        }

        // The number is the spreadsheet's own row number, not a count of
        // filled rows, and it leads so it can be typed straight into Ctrl+G.
        const rowLabel = `Row ${rowIndex + 1} of ${block.label}`;
        const errorCountBefore = errors.length;
        const addError = (message: string) => errors.push({ message, rowLabel });

        const accountName = cells.account.text.trim();
        const categoryName = cells.category.text.trim();

        if (!accountName) {
          addError('Account is required.');
        }

        if (!categoryName) {
          addError('Category is required.');
        }

        const account = accountName ? accounts.byName.get(normalizeName(accountName)) : undefined;
        const category = categoryName ? categories?.byName.get(normalizeName(categoryName)) : undefined;

        if (accountName && accounts.duplicates.has(normalizeName(accountName))) {
          addError(`More than one account is named "${accountName}". Rename one of them first.`);
        } else if (accountName && !account) {
          addError(`"${accountName}" is not a valid account.`);
        }

        if (categoryName && categories?.duplicates.has(normalizeName(categoryName))) {
          addError(`More than one ${block.label.toLowerCase()} category is named "${categoryName}". Rename one of them first.`);
        } else if (categoryName && !category) {
          // A reserved category IS a real category, so "not a valid category"
          // would be misleading and would send the user looking for a typo
          // that isn't there. It gets its own line saying what is actually
          // wrong: right name, wrong screen.
          addError(
            reservedCategoryNames.has(normalizeName(categoryName))
              ? `"${categoryName}" cannot be bulk inserted. Use the transfer or investment screen.`
              : `"${categoryName}" is not a valid category.`
          );
        }

        const dateResult = parseRowDate(cells.date, workbook.date1904);
        if (dateResult.error) {
          addError(dateResult.error);
        }

        // Precision depends on the account's currency, so a missing account
        // makes the amount uncheckable rather than invalid.
        const amountResult = account ? parseRowAmount(cells.amount, account) : null;
        if (amountResult?.error) {
          addError(amountResult.error);
        } else if (!account && cells.amount.type === 'empty') {
          addError('Amount is required.');
        }

        // A row that reported anything is never also accepted, whatever the
        // individual fields happen to hold.
        if (errors.length > errorCountBefore) {
          continue;
        }

        if (!account || !category || !dateResult.value || !amountResult?.value) {
          continue;
        }

        const description = cells.description.text.trim();

        rows.push({
          accountId: account.Id,
          accountName: account.Name,
          amountMinorUnits: amountResult.value,
          amountNote: amountResult.note ?? null,
          categoryId: category.Id,
          categoryName: category.Name,
          currencyCode: account.Code,
          currencyNumberToBasic: account.NumberToBasic,
          description: description || null,
          isIncome: block.isIncome,
          transactionDate: dateResult.value,
          rowLabel,
        });
      }
    }

    const transfers: BulkTransferRow[] = [];
    const transferSheet = findTransferSheet(workbook.sheets);

    for (let rowIndex = templateFirstDataRowIndex; rowIndex < (transferSheet?.rows.length ?? 0); rowIndex += 1) {
      const sheetRow = transferSheet?.rows[rowIndex];
      const cells = {
        date: getCell(sheetRow, templateTransferFieldOffsets.date),
        description: getCell(sheetRow, templateTransferFieldOffsets.description),
        fromAccount: getCell(sheetRow, templateTransferFieldOffsets.fromAccount),
        receivedAmount: getCell(sheetRow, templateTransferFieldOffsets.receivedAmount),
        sentAmount: getCell(sheetRow, templateTransferFieldOffsets.sentAmount),
        toAccount: getCell(sheetRow, templateTransferFieldOffsets.toAccount),
      };

      if (Object.values(cells).every((cell) => cell.type === 'empty')) {
        continue;
      }

      const rowLabel = `Row ${rowIndex + 1} of Transfers`;
      // Counting errors rather than re-testing each field is what stops a row
      // from being both reported AND accepted: a cross-currency row with no
      // Received Amount, for instance, still has a usable sent amount to fall
      // back on, and a field-by-field guard happily let it through.
      const errorCountBefore = errors.length;
      const addError = (message: string) => errors.push({ message, rowLabel });

      const fromAccountName = cells.fromAccount.text.trim();
      const toAccountName = cells.toAccount.text.trim();

      const resolveAccount = (name: string, label: string) => {
        if (!name) {
          addError(`${label} is required.`);
          return undefined;
        }

        if (accounts.duplicates.has(normalizeName(name))) {
          addError(`More than one account is named "${name}". Rename one of them first.`);
          return undefined;
        }

        const account = accounts.byName.get(normalizeName(name));
        if (!account) {
          addError(`"${name}" is not a valid account.`);
        }

        return account;
      };

      const fromAccount = resolveAccount(fromAccountName, 'From Account');
      const toAccount = resolveAccount(toAccountName, 'To Account');

      if (fromAccount && toAccount && fromAccount.Id === toAccount.Id) {
        addError('From Account and To Account must be different.');
      }

      const dateResult = parseRowDate(cells.date, workbook.date1904);
      if (dateResult.error) {
        addError(dateResult.error);
      }

      // Named for the column rather than reusing the transactions sheet's generic
      // "Amount is required", which points at a column that does not exist here.
      const sentResult = cells.sentAmount.type === 'empty' || !fromAccount
        ? null
        : parseRowAmount(cells.sentAmount, fromAccount);

      if (cells.sentAmount.type === 'empty') {
        addError('Sent Amount is required.');
      } else if (sentResult?.error) {
        addError(sentResult.error);
      }

      // Same currency: the two legs are the same number, so Received Amount is
      // noise the user should not have to type — but if they typed one anyway,
      // a mismatch is a mistake worth surfacing rather than quietly ignoring.
      // Different currencies: nothing can be inferred, so it is required.
      const sameCurrency = Boolean(fromAccount && toAccount && fromAccount.CurrencyId === toAccount.CurrencyId);
      const receivedGiven = cells.receivedAmount.type !== 'empty';
      let receivedResult: ParseResult<number> | null = null;

      if (receivedGiven && toAccount) {
        receivedResult = parseRowAmount(cells.receivedAmount, toAccount);
        if (receivedResult.error) {
          addError(receivedResult.error);
        } else if (sameCurrency && receivedResult.value !== sentResult?.value && sentResult?.value) {
          addError(
            `Received Amount must match Sent Amount when both accounts use ${fromAccount?.Code}. Leave it blank to copy the sent amount.`
          );
        }
      } else if (!receivedGiven && fromAccount && toAccount && !sameCurrency) {
        addError(
          `Received Amount is required: ${fromAccount.Name} is in ${fromAccount.Code} and ${toAccount.Name} is in ${toAccount.Code}.`
        );
      }

      const toAmount = receivedGiven ? receivedResult?.value : sentResult?.value;

      if (errors.length > errorCountBefore) {
        continue;
      }

      // Belt and braces: every path above that leaves one of these unset also
      // reports an error, so this only guards against a future validation
      // forgetting to.
      if (!fromAccount || !toAccount || !dateResult.value || !sentResult?.value || !toAmount) {
        continue;
      }

      const description = cells.description.text.trim();
      const notes = [sentResult.note, receivedResult?.note].filter(Boolean);

      transfers.push({
        amountNote: notes.length ? notes.join('; ') : null,
        description: description || null,
        fromAccountId: fromAccount.Id,
        fromAccountName: fromAccount.Name,
        fromAmountMinorUnits: sentResult.value,
        fromCurrencyCode: fromAccount.Code,
        fromCurrencyNumberToBasic: fromAccount.NumberToBasic,
        transactionDate: dateResult.value,
        rowLabel,
        toAccountId: toAccount.Id,
        toAccountName: toAccount.Name,
        toAmountMinorUnits: toAmount,
        toCurrencyCode: toAccount.Code,
        toCurrencyNumberToBasic: toAccount.NumberToBasic,
      });
    }

    const investments: BulkInvestmentRow[] = [];
    const investmentSheet = findInvestmentSheet(workbook.sheets);
    const investmentLookup = investmentSheet
      ? buildLookup(await db.getAllAsync<InvestmentLookupRow>(
        `SELECT i.Id, i.Name, i.Unit, i.CurrencyId, i.QuantityDecimals, cur.Code, cur.NumberToBasic
         FROM Investments i
         INNER JOIN Currencies cur ON cur.Id = i.CurrencyId
         WHERE i.IsActive = 1`
      ))
      : null;

    for (let rowIndex = templateFirstDataRowIndex; rowIndex < (investmentSheet?.rows.length ?? 0); rowIndex += 1) {
      const sheetRow = investmentSheet?.rows[rowIndex];
      const cells = {
        account: getCell(sheetRow, templateInvestmentFieldOffsets.account),
        additionalFees: getCell(sheetRow, templateInvestmentFieldOffsets.additionalFees),
        date: getCell(sheetRow, templateInvestmentFieldOffsets.date),
        description: getCell(sheetRow, templateInvestmentFieldOffsets.description),
        direction: getCell(sheetRow, templateInvestmentFieldOffsets.direction),
        investment: getCell(sheetRow, templateInvestmentFieldOffsets.investment),
        quantity: getCell(sheetRow, templateInvestmentFieldOffsets.quantity),
        unitValue: getCell(sheetRow, templateInvestmentFieldOffsets.unitValue),
      };

      if (Object.values(cells).every((cell) => cell.type === 'empty')) {
        continue;
      }

      const rowLabel = `Row ${rowIndex + 1} of Investments`;
      const errorCountBefore = errors.length;
      const addError = (message: string) => errors.push({ message, rowLabel });

      const directionText = cells.direction.text.trim();
      const isBuy = normalizeName(directionText) === normalizeName(templateBuyLabel);
      const isSell = normalizeName(directionText) === normalizeName(templateSellLabel);

      if (!directionText) {
        addError('Transaction Type is required.');
      } else if (!isBuy && !isSell) {
        addError(`"${directionText}" is not valid. Write ${templateBuyLabel} or ${templateSellLabel}.`);
      }

      const accountName = cells.account.text.trim();
      const investmentName = cells.investment.text.trim();

      if (!accountName) {
        addError('Account is required.');
      }

      if (!investmentName) {
        addError('Investment is required.');
      }

      const account = accountName ? accounts.byName.get(normalizeName(accountName)) : undefined;
      const investment = investmentName
        ? investmentLookup?.byName.get(normalizeName(investmentName))
        : undefined;

      if (accountName && accounts.duplicates.has(normalizeName(accountName))) {
        addError(`More than one account is named "${accountName}". Rename one of them first.`);
      } else if (accountName && !account) {
        addError(`"${accountName}" is not a valid account.`);
      }

      if (investmentName && investmentLookup?.duplicates.has(normalizeName(investmentName))) {
        addError(`More than one investment is named "${investmentName}". Rename one of them first.`);
      } else if (investmentName && !investment) {
        addError(`"${investmentName}" is not a valid investment.`);
      }

      // The database refuses a currency mismatch too, but only once the whole
      // import is under way; catching it in the preview names both sides.
      if (account && investment && account.CurrencyId !== investment.CurrencyId) {
        addError(
          `${investment.Name} is held in ${investment.Code} but ${account.Name} is in ${account.Code}. They must match.`
        );
      }

      const dateResult = parseRowDate(cells.date, workbook.date1904);
      if (dateResult.error) {
        addError(dateResult.error);
      }

      // Without a resolved investment its decimals are unknown; its own
      // error above already covers the row.
      const quantityResult = investment ? parseQuantity(cells.quantity, investment.QuantityDecimals) : null;
      if (quantityResult?.error) {
        addError(quantityResult.error);
      }

      // Unit values carry 4 more decimals than the currency (Rp 1.234,5678).
      const unitValueCurrency = account ? getUnitValueCurrency(account) : undefined;
      const unitValueResult = cells.unitValue.type === 'empty' || !unitValueCurrency
        ? null
        : parseRowAmount(cells.unitValue, unitValueCurrency);

      if (cells.unitValue.type === 'empty') {
        addError('Value per Unit is required.');
      } else if (unitValueResult?.error) {
        addError(unitValueResult.error);
      }

      // Blank fees mean none, which is the common case.
      const feesResult = cells.additionalFees.type === 'empty' || !account
        ? null
        : parseRowAmount(cells.additionalFees, account);

      if (feesResult?.error) {
        addError(feesResult.error);
      }

      if (errors.length > errorCountBefore) {
        continue;
      }

      if (!account || !investment || !dateResult.value || !quantityResult?.value || !unitValueResult?.value) {
        continue;
      }

      const additionalFees = feesResult?.value ?? 0;
      const grossAmount = calculateInvestmentAmount(
        quantityResult.value,
        investment.QuantityDecimals,
        unitValueResult.value
      );
      if (grossAmount === null) {
        addError('This investment amount is too large to record.');
        continue;
      }
      // Selling nets the fees off the proceeds, so a sale whose fees exceed
      // what it raises would move a negative amount into the account.
      const transactionAmount = isBuy ? grossAmount + additionalFees : grossAmount - additionalFees;

      if (transactionAmount <= 0) {
        addError('Total investment amount must be greater than zero.');
        continue;
      }

      const description = cells.description.text.trim();
      const notes = [unitValueResult.note, feesResult?.note].filter(Boolean);

      investments.push({
        accountId: account.Id,
        accountName: account.Name,
        additionalFeesMinorUnits: additionalFees,
        amountNote: notes.length ? notes.join('; ') : null,
        currencyCode: account.Code,
        currencyNumberToBasic: account.NumberToBasic,
        description: description || null,
        investmentId: investment.Id,
        investmentName: investment.Name,
        isBuy,
        transactionAmountMinorUnits: transactionAmount,
        transactionDate: dateResult.value,
        quantity: quantityResult.value,
        quantityDecimals: investment.QuantityDecimals,
        rowLabel,
        unit: investment.Unit,
        unitValueMinorUnits: unitValueResult.value,
      });
    }

    if (rows.length + transfers.length + investments.length + errors.length === 0) {
      return {
        Status: 'Error',
        Message: 'This file has no filled-in rows.',
      };
    }

    // A transfer writes two transaction rows, so it counts double against the cap.
    const writtenRowCount = rows.length + transfers.length * 2 + investments.length;

    if (writtenRowCount > maxImportRows) {
      return {
        Status: 'Error',
        Message: `This file would write ${writtenRowCount} rows. Bulk insert accepts ${maxImportRows} at a time.`,
      };
    }

    // Sorted by date so the preview reads chronologically and the inserted Ids
    // follow the same order as the dates, which is the order the balance
    // rebuild replays them in.
    rows.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate));
    transfers.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate));
    investments.sort((left, right) => left.transactionDate.localeCompare(right.transactionDate));

    return {
      Errors: errors,
      Investments: investments,
      Rows: rows,
      Status: 'Success',
      Transfers: transfers,
    };
  } catch (error) {
    return {
      Status: 'Error',
      ...describeFileReadError(error, 'Failed to read the bulk insert file.', appOwnedDocumentMessage),
    };
  }
};

export const __bulkInsertImportTestUtils = {
  getNumericAmountText,
  normalizeHeader,
  parseQuantity,
  parseRowAmount,
  parseRowDate,
  parseSeparatedAmountText,
};
