import JSZip from 'jszip';

import { UserFacingError } from '@/utils/userFacingError';

// Low-level .xlsx reading, the counterpart to utils/xlsxWriter. Turns a
// package into rows of typed cells and stops there — it knows nothing about
// transactions, and deliberately does not evaluate formulas: a formula cell is
// read as its cached value, which is all a spreadsheet app leaves behind.
//
// Parsing is regex-based rather than DOM-based because React Native has no
// XML parser, and pulling one in for four well-known parts is not worth the
// bundle. The shapes matched here are the ones the format actually emits.

export type XlsxCellType = 'empty' | 'number' | 'text';

export type XlsxCell = {
  // Present only for numeric cells whose style carries a date format. The
  // number is still in `number`; this only says how the file meant it to read.
  isDateFormatted: boolean;
  number: number | null;
  text: string;
  type: XlsxCellType;
};

export type XlsxSheet = {
  hidden: boolean;
  name: string;
  // Sparse by nature: trailing empty cells are not padded, and a row the file
  // never wrote is an empty array.
  rows: XlsxCell[][];
};

export type XlsxWorkbook = {
  date1904: boolean;
  sheets: XlsxSheet[];
};

export type XlsxReadLimits = {
  maxCells?: number;
  maxRows?: number;
};

const defaultMaxRows = 20000;
const defaultMaxCells = 200000;

const emptyCell: XlsxCell = {
  isDateFormatted: false,
  number: null,
  text: '',
  type: 'empty',
};

// Built-in number format ids that mean a date or a time. 14-22 and 45-47 are
// fixed by the format and need no numFmt entry to be present in the file.
const builtinDateFormatIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const decodeXmlEntities = (value: string) =>
  value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last: doing it first would re-decode the entities above.
    .replace(/&amp;/g, '&');

const getAttribute = (tag: string, name: string) => {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`));
  return match ? decodeXmlEntities(match[1]) : null;
};

// A shared string is one <si>, but its text may be split across any number of
// <r> runs (formatting changes mid-string). Concatenating every <t> inside the
// <si> is what rebuilds the original value; taking only the first <t> silently
// truncates styled names.
const parseSharedStrings = (xml: string | null) => {
  if (!xml) {
    return [];
  }

  const strings: string[] = [];
  // Self-closing alternatives come first in every pattern here. Matched the
  // other way round, `<si/>` satisfies `<si\b[^>]*>` with the slash inside the
  // attributes and the lazy body then runs on to the NEXT `</si>`, swallowing
  // whole entries.
  const itemPattern = /<si\b[^>]*?\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let itemMatch = itemPattern.exec(xml);

  while (itemMatch) {
    const inner = itemMatch[1] ?? '';
    const textPattern = /<t\b[^>]*?\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let textMatch = textPattern.exec(inner);

    while (textMatch) {
      text += decodeXmlEntities(textMatch[1] ?? '');
      textMatch = textPattern.exec(inner);
    }

    strings.push(text);
    itemMatch = itemPattern.exec(xml);
  }

  return strings;
};

// A custom format counts as a date if it uses a date or time token outside of
// quoted literals. Stripping the quoted runs first stops a currency format
// like `"Mar" #,##0` from being read as March.
const isDateFormatCode = (formatCode: string) => {
  const withoutLiterals = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');

  return /[dmyhs]/i.test(withoutLiterals);
};

// Maps a cell's style index to whether that style formats its number as a
// date. Everything else in styles.xml is irrelevant to reading values.
const parseDateStyles = (xml: string | null) => {
  const dateStyles = new Set<number>();

  if (!xml) {
    return dateStyles;
  }

  const customDateFormatIds = new Set<number>();
  const numFmtPattern = /<numFmt\b[^>]*>/g;
  let numFmtMatch = numFmtPattern.exec(xml);

  while (numFmtMatch) {
    const id = Number(getAttribute(numFmtMatch[0], 'numFmtId'));
    const formatCode = getAttribute(numFmtMatch[0], 'formatCode') ?? '';

    if (Number.isFinite(id) && isDateFormatCode(formatCode)) {
      customDateFormatIds.add(id);
    }

    numFmtMatch = numFmtPattern.exec(xml);
  }

  const cellXfsMatch = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfsMatch) {
    return dateStyles;
  }

  // Only the opening tag is needed; an <xf> with children keeps its
  // attributes there, and `</xf>` cannot match `<xf\b`.
  const xfPattern = /<xf\b[^>]*>/g;
  let xfMatch = xfPattern.exec(cellXfsMatch[1]);
  let styleIndex = 0;

  while (xfMatch) {
    const numFmtId = Number(getAttribute(xfMatch[0], 'numFmtId') ?? '0');

    if (builtinDateFormatIds.has(numFmtId) || customDateFormatIds.has(numFmtId)) {
      dateStyles.add(styleIndex);
    }

    styleIndex += 1;
    xfMatch = xfPattern.exec(cellXfsMatch[1]);
  }

  return dateStyles;
};

const columnIndexFromRef = (ref: string | null) => {
  if (!ref) {
    return null;
  }

  const letters = ref.match(/^([A-Z]+)/)?.[1];
  if (!letters) {
    return null;
  }

  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }

  return index - 1;
};

const parseCell = (
  tag: string,
  inner: string,
  sharedStrings: string[],
  dateStyles: Set<number>
): XlsxCell => {
  const cellType = getAttribute(tag, 't') ?? 'n';
  const styleIndex = Number(getAttribute(tag, 's') ?? '0');

  if (cellType === 'inlineStr') {
    const textPattern = /<t\b[^>]*?\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let text = '';
    let textMatch = textPattern.exec(inner);

    while (textMatch) {
      text += decodeXmlEntities(textMatch[1] ?? '');
      textMatch = textPattern.exec(inner);
    }

    return { ...emptyCell, text: text.trim(), type: text.trim() ? 'text' : 'empty' };
  }

  const rawValue = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (rawValue === undefined) {
    return emptyCell;
  }

  const value = decodeXmlEntities(rawValue);

  if (cellType === 's') {
    const text = (sharedStrings[Number(value)] ?? '').trim();
    return { ...emptyCell, text, type: text ? 'text' : 'empty' };
  }

  // 'str' is a formula's cached string result; 'e' is an error value such as
  // #REF!, which is text as far as reading goes and will fail validation
  // later with the user seeing what the cell actually said.
  if (cellType === 'str' || cellType === 'e') {
    const text = value.trim();
    return { ...emptyCell, text, type: text ? 'text' : 'empty' };
  }

  if (cellType === 'b') {
    return { ...emptyCell, text: value === '1' ? 'TRUE' : 'FALSE', type: 'text' };
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return emptyCell;
  }

  return {
    isDateFormatted: dateStyles.has(styleIndex),
    number: numberValue,
    text: value.trim(),
    type: 'number',
  };
};

const parseSheet = (
  xml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
  limits: Required<XlsxReadLimits>
) => {
  const rows: XlsxCell[][] = [];
  const rowPattern = /<row\b([^>]*?)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch = rowPattern.exec(xml);
  let cellCount = 0;

  while (rowMatch) {
    const rowAttributes = rowMatch[1] ?? rowMatch[2] ?? '';
    const rowInner = rowMatch[3] ?? '';
    // The r attribute is authoritative: a file may omit empty rows entirely,
    // so counting <row> elements would shift every later row up.
    const rowNumber = Number(getAttribute(`<row ${rowAttributes}>`, 'r') ?? '0');
    const rowIndex = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber - 1 : rows.length;

    if (rowIndex >= limits.maxRows) {
      throw new UserFacingError(
        `This file has more rows than bulk insert can read (limit ${limits.maxRows}).`
      );
    }

    const cells: XlsxCell[] = [];
    const cellPattern = /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch = cellPattern.exec(rowInner);

    while (cellMatch) {
      const isSelfClosing = cellMatch[1] !== undefined;
      const attributes = isSelfClosing ? cellMatch[1] : cellMatch[2];
      const tag = `<c ${attributes}>`;
      const columnIndex = columnIndexFromRef(getAttribute(tag, 'r')) ?? cells.length;

      cellCount += 1;
      if (cellCount > limits.maxCells) {
        throw new UserFacingError('This file has more cells than bulk insert can read.');
      }

      if (columnIndex >= 0) {
        while (cells.length < columnIndex) {
          cells.push(emptyCell);
        }

        cells[columnIndex] = isSelfClosing
          ? emptyCell
          : parseCell(tag, cellMatch[3] ?? '', sharedStrings, dateStyles);
      }

      cellMatch = cellPattern.exec(rowInner);
    }

    while (rows.length < rowIndex) {
      rows.push([]);
    }

    rows[rowIndex] = cells;
    rowMatch = rowPattern.exec(xml);
  }

  return rows;
};

// Serial 0 is 1899-12-30, which absorbs the format's deliberate 1900 leap year
// bug for every date from 1900-03-01 on. Serials below 61 predate that bug and
// are one day out; they are 1900 dates and cannot be a real transaction, but the
// correction is one line so it is made rather than explained away.
export const xlsxSerialToDateParts = (serial: number, date1904: boolean) => {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const wholeDays = Math.floor(serial);
  const correction = !date1904 && wholeDays < 61 ? 1 : 0;
  const date = new Date(epoch + (wholeDays + correction) * 86400000);

  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
};

export const readXlsx = async (
  bytes: Uint8Array,
  limits: XlsxReadLimits = {}
): Promise<XlsxWorkbook> => {
  const resolvedLimits = {
    maxCells: limits.maxCells ?? defaultMaxCells,
    maxRows: limits.maxRows ?? defaultMaxRows,
  };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new UserFacingError('This file is not a readable .xlsx file.');
  }

  const readPart = async (path: string) => {
    const entry = zip.file(path);
    return entry ? entry.async('string') : null;
  };

  const workbookXml = await readPart('xl/workbook.xml');
  if (!workbookXml) {
    throw new UserFacingError('This file is not a readable .xlsx file.');
  }

  const relsXml = await readPart('xl/_rels/workbook.xml.rels');
  const sharedStrings = parseSharedStrings(await readPart('xl/sharedStrings.xml'));
  const dateStyles = parseDateStyles(await readPart('xl/styles.xml'));
  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(workbookXml);

  const relationships = new Map<string, string>();
  const relPattern = /<Relationship\b[^>]*>/g;
  let relMatch = relPattern.exec(relsXml ?? '');

  while (relMatch) {
    const id = getAttribute(relMatch[0], 'Id');
    const target = getAttribute(relMatch[0], 'Target');

    if (id && target) {
      relationships.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }

    relMatch = relPattern.exec(relsXml ?? '');
  }

  const sheets: XlsxSheet[] = [];
  const sheetPattern = /<sheet\b[^>]*>/g;
  let sheetMatch = sheetPattern.exec(workbookXml);
  let sheetOrdinal = 0;

  while (sheetMatch) {
    sheetOrdinal += 1;
    const name = getAttribute(sheetMatch[0], 'name') ?? `Sheet${sheetOrdinal}`;
    const relationshipId = getAttribute(sheetMatch[0], 'r:id');
    const state = getAttribute(sheetMatch[0], 'state');
    // Falling back to sheetN.xml covers files whose rels use a path shape the
    // map above did not produce; the ordinal is the same one the writer uses.
    const target = (relationshipId ? relationships.get(relationshipId) : null)
      ?? `worksheets/sheet${sheetOrdinal}.xml`;
    const sheetXml = await readPart(`xl/${target}`);

    sheets.push({
      hidden: state === 'hidden' || state === 'veryHidden',
      name,
      rows: sheetXml ? parseSheet(sheetXml, sharedStrings, dateStyles, resolvedLimits) : [],
    });

    sheetMatch = sheetPattern.exec(workbookXml);
  }

  return { date1904, sheets };
};
