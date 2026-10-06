import JSZip from 'jszip';

// Low-level .xlsx writing, shared by the report export (utils/excelExport) and
// the bulk insert template (utils/bulkInsertTemplate). Nothing in here knows
// about transactions, accounts or currencies: it turns rows of cells into a
// SpreadsheetML package and stops there.

export type SheetCell = {
  f?: string;
  s?: number;
  t?: 'n' | 'str';
  v?: string | number | null;
};

// A list dropdown bound to a cell range. `formula` is either an inline literal
// list — `"Income,Spending"`, quotes included, which the format caps at 255
// characters — or a reference to a range, normally through a defined name so
// older spreadsheet apps that reject cross-sheet references in validation
// still resolve it.
//
// errorStyle is deliberately 'warning' rather than the default 'stop': the
// lists are a snapshot taken when the template was generated, so a category
// added in the app afterwards must still be typeable. The import preview is
// what actually rejects unknown names.
export type SheetValidation = {
  error?: string;
  errorTitle?: string;
  formula: string;
  sqref: string;
};

export type WorkbookSheet = {
  cols?: number[];
  hidden?: boolean;
  name: string;
  rows: SheetCell[][];
  validations?: SheetValidation[];
};

export type WorkbookDefinedName = {
  name: string;
  refersTo: string;
};

// Indexes into the cellXfs list built by buildStylesXml. Adding a style means
// adding a <fill>/<font> if it needs one, an <xf> entry, and bumping the
// matching count attribute.
export const styles = {
  default: 0,
  title: 1,
  gray: 2,
  incomeHeader: 3,
  spendingHeader: 4,
  nett: 5,
  account: 6,
  investment: 7,
  currency: 8,
  percent: 9,
  tableHeader: 10,
  date: 11,
  transferHeader: 12,
  investmentHeader: 13,
};

export const text = (v: string | null | undefined, s = styles.default): SheetCell => ({ s, t: 'str', v: v ?? '' });
export const n = (v: number | null | undefined, s = styles.currency): SheetCell => ({ s, t: 'n', v: v ?? 0 });
export const formula = (f: string, s = styles.currency): SheetCell => ({ f, s });
export const blank = (s = styles.default): SheetCell => ({ s, v: null });

export const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const escapeFormulaString = (value: string) => value.replace(/"/g, '""');

export const quoteSheet = (sheetName: string) => `'${sheetName.replace(/'/g, "''")}'`;

export const colName = (index: number) => {
  let dividend = index + 1;
  let name = '';

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return name;
};

export const cellRef = (row: number, col: number) => `${colName(col)}${row + 1}`;

const buildDataValidationsXml = (validations: SheetValidation[] | undefined) => {
  if (!validations?.length) {
    return '';
  }

  const entries = validations
    .map((validation) => {
      const errorTitle = validation.errorTitle ? ` errorTitle="${escapeXml(validation.errorTitle)}"` : '';
      const error = validation.error ? ` error="${escapeXml(validation.error)}"` : '';

      return `<dataValidation type="list" errorStyle="warning" allowBlank="1" showInputMessage="1" showErrorMessage="1"${errorTitle}${error} sqref="${escapeXml(validation.sqref)}"><formula1>${escapeXml(validation.formula)}</formula1></dataValidation>`;
    })
    .join('');

  return `<dataValidations count="${validations.length}">${entries}</dataValidations>`;
};

export const buildSheetXml = (sheet: WorkbookSheet) => {
  const cols = sheet.cols?.length
    ? `<cols>${sheet.cols.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rowXml = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => {
          if (!cell || (cell.v === null || cell.v === undefined) && !cell.f) {
            return '';
          }

          const ref = cellRef(rowIndex, colIndex);
          const style = cell.s ? ` s="${cell.s}"` : '';
          if (cell.f) {
            return `<c r="${ref}"${style}><f>${escapeXml(cell.f)}</f></c>`;
          }
          if (cell.t === 'n') {
            return `<c r="${ref}"${style}><v>${cell.v}</v></c>`;
          }

          return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(String(cell.v ?? ''))}</t></is></c>`;
        })
        .join('');

      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  // dataValidations must follow sheetData in the schema, not precede it.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rowXml}</sheetData>${buildDataValidationsXml(sheet.validations)}</worksheet>`;
};

export const buildStylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="Rp #,##0"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="9"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FFFF"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0070C0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7030A0"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="5" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="8" borderId="1" xfId="0" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export const buildWorkbookXml = (sheets: WorkbookSheet[], definedNames: WorkbookDefinedName[] = []) => {
  const sheetXml = sheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${index + 1}"/>`)
    .join('');
  // definedNames sits between sheets and calcPr; out of order it is rejected.
  const definedNameXml = definedNames.length
    ? `<definedNames>${definedNames.map((definedName) => `<definedName name="${escapeXml(definedName.name)}">${escapeXml(definedName.refersTo)}</definedName>`).join('')}</definedNames>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets>${definedNameXml}<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`;
};

const buildWorkbookRelsXml = (sheets: WorkbookSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const buildRootRelsXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const buildContentTypesXml = (sheets: WorkbookSheet[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;

const yieldToUiThread = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const buildXlsxBytes = async (sheets: WorkbookSheet[], definedNames: WorkbookDefinedName[] = []) => {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', buildContentTypesXml(sheets));
  zip.folder('_rels')?.file('.rels', buildRootRelsXml());
  zip.folder('xl')?.file('workbook.xml', buildWorkbookXml(sheets, definedNames));
  zip.folder('xl')?.file('styles.xml', buildStylesXml());
  zip.folder('xl')?.folder('_rels')?.file('workbook.xml.rels', buildWorkbookRelsXml(sheets));

  // Sheet XML generation is the heaviest synchronous work in the export;
  // yield between sheets so the UI can keep painting during large exports.
  for (const [index, sheet] of sheets.entries()) {
    zip.folder('xl')?.folder('worksheets')?.file(`sheet${index + 1}.xml`, buildSheetXml(sheet));
    await yieldToUiThread();
  }

  return zip.generateAsync({
    compression: 'DEFLATE',
    type: 'uint8array',
  });
};
