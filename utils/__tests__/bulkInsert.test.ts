import JSZip from 'jszip';
import { describe, expect, it } from '@jest/globals';

import { __bulkInsertImportTestUtils } from '@/utils/bulkInsertImport';
import { buildBulkInsertTemplateBytes } from '@/utils/bulkInsertTemplate';
import { readXlsx, XlsxCell, xlsxSerialToDateParts } from '@/utils/xlsxReader';
import { buildXlsxBytes, n, styles, text } from '@/utils/xlsxWriter';

const {
  getNumericAmountText,
  normalizeHeader,
  parseQuantity,
  parseRowAmount,
  parseRowDate,
  parseSeparatedAmountText,
} = __bulkInsertImportTestUtils;

const lists = {
  accounts: [
    { Code: 'IDR', Name: 'BCA', NumberToBasic: 1 },
    { Code: 'IDR', Name: 'CIMB', NumberToBasic: 1 },
    { Code: 'USD', Name: 'Cash & "Wallet"', NumberToBasic: 100 },
  ],
  incomeCategories: ['Salary', 'Bonus'],
  investments: [
    { Code: 'IDR', Name: 'Silver', NumberToBasic: 1, QuantityDecimals: 3, Unit: 'gram' },
    { Code: 'USD', Name: 'Bonds', NumberToBasic: 100, QuantityDecimals: 0, Unit: null },
  ],
  spendingCategories: ['Groceries', 'Rent', 'Transport'],
};

const numberCell = (value: number, cellText = String(value)): XlsxCell => ({
  isDateFormatted: false,
  number: value,
  text: cellText,
  type: 'number',
});

const textCell = (value: string): XlsxCell => ({
  isDateFormatted: false,
  number: null,
  text: value,
  type: 'text',
});

const emptyCell: XlsxCell = { isDateFormatted: false, number: null, text: '', type: 'empty' };

const USD = { Code: 'USD', NumberToBasic: 100 };
const IDR = { Code: 'IDR', NumberToBasic: 1 };
// NettKeeping seeds no 3-decimal currency, but the separator rules have to stay
// honest if one is ever added.
const KWD = { Code: 'KWD', NumberToBasic: 1000 };

const readPart = async (bytes: Uint8Array, path: string) => {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file(path)?.async('string')) ?? '';
};

describe('Bulk insert template', () => {
  it('puts the dropdown ranges, defined names and fills where the format requires them', async () => {
    const bytes = await buildBulkInsertTemplateBytes(lists);
    const workbookXml = await readPart(bytes, 'xl/workbook.xml');
    const sheetXml = await readPart(bytes, 'xl/worksheets/sheet1.xml');

    // definedNames out of order between sheets and calcPr is rejected outright.
    expect(workbookXml.indexOf('</sheets>')).toBeLessThan(workbookXml.indexOf('<definedNames>'));
    expect(workbookXml.indexOf('<definedNames>')).toBeLessThan(workbookXml.indexOf('<calcPr'));
    // Ranges are sized to the list; a longer range shows blank options.
    expect(workbookXml).toContain('!$A$2:$A$3');
    expect(workbookXml).toContain('!$C$2:$C$4');
    expect(workbookXml).toMatch(/name="_Lists"[^>]*state="hidden"/);

    expect(sheetXml.indexOf('</sheetData>')).toBeLessThan(sheetXml.indexOf('<dataValidations'));
    expect(sheetXml).toContain('sqref="C3:C502"><formula1>NettKeepingIncomeCategories');
    expect(sheetXml).toContain('sqref="I3:I502"><formula1>NettKeepingSpendingCategories');
    expect(sheetXml).toContain('sqref="E3:E502"');
    expect(sheetXml).toContain('sqref="K3:K502"');
    // Warning, not stop: the lists are a snapshot, so a category added after
    // the download must still be typeable.
    expect(sheetXml).toContain('errorStyle="warning"');
    expect(sheetXml).toContain(`s="${styles.incomeHeader}"`);
    expect(sheetXml).toContain(`s="${styles.spendingHeader}"`);
    // Only the group and header rows exist. Styling the 500 empty data rows
    // would materialise 5,000 cells that carry nothing.
    expect(sheetXml.match(/<row /g)).toHaveLength(2);
  });

  it('leaves the report export untouched', async () => {
    const bytes = await buildXlsxBytes([{ name: 'Sheet', rows: [[text('Label', styles.tableHeader), n(42)]] }]);

    expect(await readPart(bytes, 'xl/worksheets/sheet1.xml')).not.toContain('dataValidations');
    expect(await readPart(bytes, 'xl/workbook.xml')).not.toContain('definedNames');
  });

  it('ships a Transfers sheet with its own headers and account dropdowns', async () => {
    const bytes = await buildBulkInsertTemplateBytes(lists);
    const workbook = await readXlsx(bytes);
    const sheetXml = await readPart(bytes, 'xl/worksheets/sheet2.xml');

    expect(workbook.sheets[1].name).toBe('Transfers');
    expect(workbook.sheets[1].rows[1].map((cell) => cell.text)).toEqual([
      'Date (DD/MM/YYYY)*', 'Description', 'From Account*', 'To Account*', 'Sent Amount*', 'Received Amount',
    ]);
    // No category column: both legs use the reserved transfer categories,
    // which the importer supplies.
    expect(sheetXml).toContain('sqref="C3:C502"><formula1>NettKeepingAccounts');
    expect(sheetXml).toContain('sqref="D3:D502"><formula1>NettKeepingAccounts');
    expect(sheetXml).toContain(`s="${styles.transferHeader}"`);
    expect(sheetXml.match(/<row /g)).toHaveLength(2);
  });

  it('ships an Investments sheet with a Buy/Sell list and an investment dropdown', async () => {
    const bytes = await buildBulkInsertTemplateBytes(lists);
    const workbook = await readXlsx(bytes);
    const sheetXml = await readPart(bytes, 'xl/worksheets/sheet3.xml');

    expect(workbook.sheets[2].name).toBe('Investments');
    expect(workbook.sheets[2].rows[1].map((cell) => cell.text)).toEqual([
      'Date (DD/MM/YYYY)*', 'Description', 'Transaction Type*', 'Account*', 'Investment*',
      'Quantity*', 'Value per Unit*', 'Additional Fees',
    ]);
    // Two fixed values are not data, so the direction list is inline rather
    // than a range on _Lists. The quotes arrive XML-escaped.
    expect(sheetXml).toContain('sqref="C3:C502"><formula1>&quot;Buy,Sell&quot;');
    expect(sheetXml).toContain('sqref="D3:D502"><formula1>NettKeepingAccounts');
    expect(sheetXml).toContain('sqref="E3:E502"><formula1>NettKeepingInvestments');
    expect(sheetXml).toContain(`s="${styles.investmentHeader}"`);
    // No amount column: the amount is derived from quantity, unit value and fees.
    expect(workbook.sheets[2].rows[1]).toHaveLength(8);
  });

  it('tells the user which currency each investment is held in', async () => {
    // The sheet requires the investment and the account to share a currency,
    // and the accounts table gives one half of that. Without this table the
    // file states a rule it gives no way to follow.
    const workbook = await readXlsx(await buildBulkInsertTemplateBytes(lists));
    const rows = workbook.sheets[3].rows.map((row) => row.map((cell) => cell.text));

    expect(rows).toContainEqual(expect.arrayContaining(['Investment', 'Currency', 'Unit']));
    expect(rows).toContainEqual(expect.arrayContaining(['Silver', 'IDR', 'gram']));
    // An investment with no unit still gets a row, with a dash rather than a gap.
    expect(rows).toContainEqual(expect.arrayContaining(['Bonds', 'USD', '—']));
  });

  it('leaves the Transfers sheet out entirely when there is only one account', async () => {
    // One account cannot transfer to itself, so every row on that sheet would
    // fail the same check. Not a size or speed measure: the sheet costs 16
    // microseconds to build.
    const workbook = await readXlsx(await buildBulkInsertTemplateBytes({
      ...lists,
      accounts: [lists.accounts[0]],
    }));
    const infoRows = workbook.sheets[2].rows.map((row) => row.map((cell) => cell.text));

    expect(workbook.sheets.map((sheet) => sheet.name))
      .toEqual(['Bulk Insert', 'Investments', 'Info', '_Lists']);
    expect(infoRows.some((row) => row[0]?.includes('Not included: transfers need two accounts'))).toBe(true);
  });

  it('leaves the Investments sheet out entirely when there are no investments', async () => {
    // A sheet whose only dropdown is empty is worse than no sheet: every row
    // the user fills can only come back rejected.
    const workbook = await readXlsx(await buildBulkInsertTemplateBytes({ ...lists, investments: [] }));
    const listsSheet = workbook.sheets[workbook.sheets.length - 1];
    const infoRows = workbook.sheets[2].rows.map((row) => row.map((cell) => cell.text));

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Bulk Insert', 'Transfers', 'Info', '_Lists']);
    // No column pointing at a range that was never written.
    expect(listsSheet.rows[0].map((cell) => cell.text)).toEqual([
      'Income Categories', 'Spending Categories', 'Accounts',
    ]);
    expect(infoRows.some((row) => row[0]?.includes('Not included: there are no investments'))).toBe(true);
    expect(infoRows.some((row) => row[0]?.includes('Transaction Type is Buy or Sell'))).toBe(false);
  });

  it('ships a visible Info sheet that states what each account accepts', async () => {
    const workbook = await readXlsx(await buildBulkInsertTemplateBytes(lists));
    const info = workbook.sheets[3];
    const rows = info.rows.map((row) => row.map((cell) => cell.text));

    expect(workbook.sheets.map((sheet) => sheet.name))
      .toEqual(['Bulk Insert', 'Transfers', 'Investments', 'Info', '_Lists']);
    // Info is for the user to read; _Lists feeds the dropdowns and stays hidden.
    expect(info.hidden).toBe(false);
    expect(workbook.sheets[4].hidden).toBe(true);
    expect(rows.some((row) => row[0] === 'Transfers sheet')).toBe(true);
    expect(rows.some((row) => row[0] === 'Investments sheet')).toBe(true);
    expect(rows).toContainEqual(expect.arrayContaining(['BCA', 'IDR', '0', '1257']));
    // Both separator conventions are accepted, so the example shows both
    // rather than being wrong on half the world's locales.
    expect(rows).toContainEqual(expect.arrayContaining(['Cash & "Wallet"', 'USD', '2', '12.57 or 12,57']));
    expect(rows.some((row) => row[0]?.includes('YYYY-MM-DD'))).toBe(true);
    expect(rows.some((row) => row[0]?.includes('ROUND()'))).toBe(true);
  });

  it('round trips through the reader', async () => {
    const bytes = await buildBulkInsertTemplateBytes(lists);
    const workbook = await readXlsx(bytes);

    expect(workbook.sheets).toHaveLength(5);
    expect(workbook.sheets[4].hidden).toBe(true);
    expect(workbook.sheets[0].rows[1].map((cell) => cell.text)).toEqual([
      'Date (DD/MM/YYYY)*', 'Description', 'Category*', 'Amount*', 'Account*',
      '',
      'Date (DD/MM/YYYY)*', 'Description', 'Category*', 'Amount*', 'Account*',
    ]);
    expect(workbook.sheets[0].rows[0][0].text).toBe('Income');
    expect(workbook.sheets[0].rows[0][6].text).toBe('Spending');
    // Escaping survives: the name contains both an ampersand and quotes.
    expect(workbook.sheets[4].rows[3][2].text).toBe('Cash & "Wallet"');
    // The lists sheet gained a fourth column for investment names.
    expect(workbook.sheets[4].rows[0][3].text).toBe('Investments');
    expect(workbook.sheets[4].rows[1][3].text).toBe('Silver');
  });
});

describe('xlsx reader', () => {
  // The app's own writer only emits inlineStr cells, so shared strings, date
  // formats, husks and skipped rows are only ever produced by other
  // spreadsheet apps and have to be exercised against a hand-built package.
  const buildExcelLikeWorkbook = async () => {
    const zip = new JSZip();

    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.folder('_rels')?.file('.rels', '<?xml version="1.0"?><Relationships/>');
    zip.folder('xl')?.file(
      'workbook.xml',
      '<?xml version="1.0"?><workbook><sheets><sheet name="Bulk Insert" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.folder('xl')?.folder('_rels')?.file(
      'workbook.xml.rels',
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    );
    zip.folder('xl')?.file(
      'sharedStrings.xml',
      '<?xml version="1.0"?><sst><si><t>Groceries</t></si><si><r><t>Sal</t></r><r><t>ary</t></r></si><si/><si><t>Cash &amp; "Wallet"</t></si></sst>'
    );
    zip.folder('xl')?.file(
      'styles.xml',
      '<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="170" formatCode="&quot;Mar&quot; #,##0"/></numFmts>'
      + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="0"><alignment horizontal="left"/></xf></cellXfs></styleSheet>'
    );
    zip.folder('xl')?.folder('worksheets')?.file(
      'sheet1.xml',
      '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
      + '<row r="3"><c r="A3" s="3"/><c r="B3" s="1"><v>46255</v></c><c r="C3" s="2"><v>1500</v></c><c r="D3"><v>12.5</v></c></row>'
      + '<row r="4"/>'
      + '<row r="5"><c r="B5" t="inlineStr"><is><t>2026-08-21</t></is></c><c r="C5" t="str"><v>formula text</v></c></row>'
      + '</sheetData></worksheet>'
    );

    return zip.generateAsync({ type: 'uint8array' });
  };

  it('reads what other spreadsheet apps write', async () => {
    const workbook = await readXlsx(await buildExcelLikeWorkbook());
    const rows = workbook.sheets[0].rows;

    expect(workbook.sheets[0].name).toBe('Bulk Insert');
    expect(rows[0][0].text).toBe('Groceries');
    // A styled run splits one string across several <t> elements.
    expect(rows[0][1].text).toBe('Salary');
    // An empty <si/> must not swallow the entry after it.
    expect(rows[0][2].type).toBe('empty');
    expect(rows[0][3].text).toBe('Cash & "Wallet"');
    // Row 2 was never written, so row 3 must still land at index 2.
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveLength(0);
    expect(rows[3]).toHaveLength(0);
    // A husk left behind by clicking around, followed by real cells.
    expect(rows[2][0].type).toBe('empty');
    expect(rows[2][3].number).toBe(12.5);
    expect(rows[2][1].isDateFormatted).toBe(true);
    // A quoted "Mar" inside a currency format is not a date token.
    expect(rows[2][2].isDateFormatted).toBe(false);
    expect(rows[4][1].text).toBe('2026-08-21');
    expect(rows[4][2].text).toBe('formula text');
  });

  it('converts date serials, including the 1900 leap bug and the 1904 epoch', () => {
    const asText = (serial: number, date1904 = false) => {
      const { day, month, year } = xlsxSerialToDateParts(serial, date1904);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };

    expect(asText(46255)).toBe('2026-08-21');
    expect(asText(1)).toBe('1900-01-01');
    expect(asText(61)).toBe('1900-03-01');
    expect(asText(44793, true)).toBe('2026-08-21');
  });

  it('refuses input that is not a package', async () => {
    await expect(readXlsx(new TextEncoder().encode('not a zip'))).rejects.toThrow(/readable \.xlsx/);
  });
});

describe('Bulk insert row parsing', () => {
  it('resolves separators in text cells without guessing', () => {
    // Numeric cells never reach this: the spreadsheet app already settled the
    // separators using the OS locale. These are text cells only.

    // Rule 1 — both separators present, the rightmost is the decimal.
    expect(parseSeparatedAmountText('1,257.00', USD).value).toBe('1257.00');
    expect(parseSeparatedAmountText('1.257,00', USD).value).toBe('1257.00');

    // Rule 2 — a repeated separator is grouping, but only if it really was
    // grouping: the groups have to be three digits wide.
    expect(parseSeparatedAmountText('1.234.567', USD).value).toBe('1234567');
    // Without this check "2.500.37" flattens to 250037 — a hundredfold error
    // from what is almost certainly a typo for 2.500,37.
    expect(parseSeparatedAmountText('2.500.37', USD).error).toMatch(/group it in threes/);
    expect(parseSeparatedAmountText('1.25,700', USD).error).toMatch(/group it in threes/);
    // Indian lakh grouping is the deliberate casualty: 12,34,567 is refused
    // rather than accepted by accident. A numeric cell is unaffected.
    expect(parseSeparatedAmountText('12,34,567', USD).error).toMatch(/group it in threes/);

    // Rule 3 — one separator whose tail is not three digits is a decimal.
    expect(parseSeparatedAmountText('1,25700', USD).value).toBe('1.25700');
    expect(parseSeparatedAmountText('12,57', USD).value).toBe('12.57');
    expect(parseSeparatedAmountText('.50', USD).value).toBe('0.50');

    // Rule 4 — one separator with a three-digit tail is structurally
    // ambiguous, and the currency settles it: three decimals is invalid for
    // every currency NettKeeping has, so grouping is the only valid reading.
    expect(parseSeparatedAmountText('1.257', USD).value).toBe('1257');
    expect(parseSeparatedAmountText('1,257', IDR).value).toBe('1257');
    // A 3-decimal currency leaves it genuinely ambiguous, so it is refused.
    expect(parseSeparatedAmountText('1.257', KWD).error).toMatch(/two ways/);
    expect(parseSeparatedAmountText('1.2575', KWD).value).toBe('1.2575');

    // Symbols and spacing are noise.
    expect(parseSeparatedAmountText('$ 1,257.00', USD).value).toBe('1257.00');
    expect(parseSeparatedAmountText('n/a', USD).value).toBeUndefined();
  });

  it('reads investment quantities at the investment\'s own decimals', () => {
    // Whole-unit investments (0 decimals) refuse fractions.
    expect(parseQuantity(numberCell(10), 0).value).toBe(10);
    // A spreadsheet writes whole numbers with a trailing .0 readily enough.
    expect(parseQuantity(numberCell(10, '10.0'), 0).value).toBe(10);
    expect(parseQuantity(numberCell(2.5), 0).error).toMatch(/does not allow decimal/);
    expect(parseQuantity(numberCell(0), 0).error).toMatch(/greater than zero/);
    expect(parseQuantity(textCell('ten'), 0).error).toMatch(/could not be read/);
    expect(parseQuantity(emptyCell, 0).error).toMatch(/required/);
    // Decimal investments store scaled integers. 0.29 * 100 is
    // 28.999999999999996 as a float: it must round to 29, not truncate to 28.
    expect(parseQuantity(numberCell(0.29), 2).value).toBe(29);
    expect(parseQuantity(numberCell(1.5), 3).value).toBe(1500);
    expect(parseQuantity(numberCell(1.234), 2).error).toMatch(/only up to 2 decimals/);
    expect(parseQuantity(textCell('1,5'), 3).value).toBe(1500);
    expect(parseQuantity(textCell('0,00000001'), 8).value).toBe(1);
  });

  it('flags only the readings that were a judgement call', () => {
    // Rule 4 is the one place a separator could have meant something else, so
    // it is the only one the preview marks. 12.500 in a two-decimal currency
    // is the case worth catching: it is a valid grouped thousand and a
    // plausible typo for 12.50.
    expect(parseRowAmount(textCell('12.500'), USD).note).toBe('"12.500" read as 12500');
    expect(parseRowAmount(textCell('1.257'), IDR).note).toBe('"1.257" read as 1257');
    // Everything unambiguous stays unmarked, or the marker means nothing.
    expect(parseRowAmount(textCell('1,257.00'), USD).note).toBeUndefined();
    expect(parseRowAmount(textCell('12,57'), USD).note).toBeUndefined();
    expect(parseRowAmount(numberCell(12.57), USD).note).toBeUndefined();
  });

  it('reads amounts without inventing or losing precision', () => {
    // The file's own text is preferred over the parsed float, which can carry
    // digits nobody typed.
    expect(getNumericAmountText(numberCell(0.30000000000000004, '0.3')).value).toBe('0.3');
    expect(parseRowAmount(numberCell(12.5), USD).value).toBe(1250);
    expect(parseRowAmount(numberCell(12), USD).value).toBe(1200);
    expect(parseRowAmount(textCell('1.234,56'), USD).value).toBe(123456);
    // Refused rather than rounded to 12.57.
    expect(parseRowAmount(numberCell(12.567), USD).error).toMatch(/decimal/i);
    // Trailing zeros are not precision. A spreadsheet writes 1500000.00 for a
    // whole number as readily as 1500000, and refusing one while accepting the
    // other would be indefensible — they are the same amount.
    expect(parseRowAmount(numberCell(1500000, '1500000.00'), IDR).value).toBe(1500000);
    expect(parseRowAmount(textCell('1.500.000,00'), IDR).value).toBe(1500000);
    expect(parseRowAmount(numberCell(12.5, '12.5000'), USD).value).toBe(1250);
    // A fraction the currency cannot hold is still refused.
    expect(parseRowAmount(textCell('1.500.000,50'), IDR).error).toBe('IDR does not allow decimals.');
    // The one that would silently multiply by ten: parseMoneyInputToMinorUnits
    // strips non-digits for zero-decimal currencies, so 12.5 would store 125.
    expect(parseRowAmount(numberCell(12.5), IDR).error).toBeDefined();
    expect(parseRowAmount(numberCell(1500), IDR).value).toBe(1500);
    expect(parseRowAmount(numberCell(-5, '-5'), USD).error).toBe('Amount must be greater than zero.');
    expect(parseRowAmount(numberCell(0), USD).error).toBeDefined();
    // A blank cell and a cell holding "n/a" are different mistakes.
    expect(parseRowAmount(emptyCell, USD).error).toBe('Amount is required.');
    expect(parseRowAmount(textCell('n/a'), USD).error).toBe('Invalid amount.');
  });

  it('reads dates in the two forms the template declares', () => {
    expect(parseRowDate(numberCell(46255), false).value).toBe('2026-08-21');
    expect(parseRowDate(numberCell(44793), true).value).toBe('2026-08-21');
    expect(parseRowDate(textCell('2026-08-21'), false).value).toBe('2026-08-21');
    expect(parseRowDate(textCell('2026-8-1'), false).value).toBe('2026-08-01');
    // Day first, as the column header states. Not a guess: 03/04/2026 is
    // 3 April because the template says DD/MM/YYYY.
    expect(parseRowDate(textCell('21/08/2026'), false).value).toBe('2026-08-21');
    expect(parseRowDate(textCell('3/4/2026'), false).value).toBe('2026-04-03');
    expect(parseRowDate(textCell('21-08-2026'), false).value).toBe('2026-08-21');
    expect(parseRowDate(textCell('21.08.2026'), false).value).toBe('2026-08-21');
    // A two-digit year is refused rather than assigned a century. It reports
    // as a format problem, which is what it is — the format is on the column
    // header and the Info sheet, so the message does not repeat it.
    expect(parseRowDate(textCell('21/08/26'), false).error).toBe('Invalid date format.');
    expect(parseRowDate(textCell('not a date'), false).error).toBe('Invalid date format.');
    // A well-formed date that does not exist is a different mistake, and says so.
    expect(parseRowDate(textCell('2026-02-30'), false).error).toMatch(/not a real calendar date/);
    expect(parseRowDate(textCell('31/02/2026'), false).error).toMatch(/not a real calendar date/);
    expect(parseRowDate(emptyCell, false).error).toMatch(/required/);
  });

  it('refuses future dates, on local calendar days', () => {
    // Balances replay every transaction whatever its date, while every history
    // view stops at today — so a future-dated row moves the balance and then
    // hides itself. Refused at the row rather than the file, so the preview
    // can say which row.
    const localDay = (offsetDays: number) => {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
    };
    const asDayMonthYear = (date: Date) =>
      `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    // Built from UTC parts of a LOCAL day: going through toISOString() would
    // shift the day for anyone east of UTC, which is the bug this guards.
    const asSerial = (date: Date) =>
      Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);

    expect(parseRowDate(textCell(asDayMonthYear(localDay(0))), false).error).toBeUndefined();
    expect(parseRowDate(textCell(asDayMonthYear(localDay(-1))), false).error).toBeUndefined();
    expect(parseRowDate(textCell(asDayMonthYear(localDay(1))), false).error).toBe('Date cannot be in the future.');
    expect(parseRowDate(numberCell(asSerial(localDay(0))), false).error).toBeUndefined();
    expect(parseRowDate(numberCell(asSerial(localDay(1))), false).error).toBe('Date cannot be in the future.');
  });

  it('matches headers regardless of the decoration on the label', () => {
    // The label carries an asterisk and a format hint; neither is part of the
    // contract, so a template saved before the label changed still reads.
    expect(normalizeHeader('Date (DD/MM/YYYY)*')).toBe('date');
    expect(normalizeHeader('Date*')).toBe('date');
    expect(normalizeHeader(' ACCOUNT * ')).toBe('account');
  });
});

// Kept out of the suite: readBulkInsertFile and insertBulkImport both need
// a database. They were exercised end to end against a stubbed connection
// while this was built, and need manual testing in the app.
