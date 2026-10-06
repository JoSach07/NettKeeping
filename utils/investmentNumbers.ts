// Fixed-point numbers for investments. No floats are ever stored:
//
// - Quantity is an INTEGER scaled by 10^QuantityDecimals, a per-investment
//   setting (0-8). 1.5 grams at 3 decimals is stored as 1500. Holdings are
//   summed by the replay, so every row of one investment must share one scale.
// - Unit value is an INTEGER in currency minor units x 10^4, a FIXED scale for
//   every investment (decided 2026-10-04). Unit values are never summed, only
//   multiplied, so they need no per-investment setting. Rp 1.234,5678 is
//   stored as 12345678; $1.23 (2 minor decimals) as 1230000.
// - A total (quantity x unit value) is MONEY: it is rounded once, half-up, to
//   the currency's minor units by calculateInvestmentAmount and is never stored
//   or shown with more precision than the account it moves.
//
// Every quantity x unit value in the app must go through
// calculateInvestmentAmount. A raw product handed to a money formatter is not
// an integer number of minor units, and those formatters used to strip the
// decimal point and show it ~10,000x too large.
//
// Only imports utils/moneyInput (which has no imports), so database modules
// that must not import dbService — investmentReplay — can use it too.

import {
  formatMinorUnitsToMoneyInput,
  getMoneyDecimalPlaces,
  getMoneyPrefix,
  groupMoneyThousands,
  MoneyCurrency,
  parseMoneyInputToMinorUnits,
} from './moneyInput';

export const MAX_QUANTITY_DECIMALS = 8;
export const UNIT_VALUE_EXTRA_DECIMALS = 4;
export const UNIT_VALUE_SCALE = 10 ** UNIT_VALUE_EXTRA_DECIMALS;

export const QUANTITY_DECIMAL_OPTIONS = Array.from({ length: MAX_QUANTITY_DECIMALS + 1 }, (_, index) => index);

// Picker label: "0 (whole units)", "3 (0,001)".
export const formatQuantityDecimalsLabel = (decimals: number): string =>
  decimals === 0 ? '0 (whole units)' : `${decimals} (0,${'0'.repeat(decimals - 1)}1)`;

// Anything outside 0-8 (or not an integer) is treated as 0 rather than trusted.
export const normalizeQuantityDecimals = (decimals: number | null | undefined): number =>
  typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_QUANTITY_DECIMALS
    ? decimals
    : 0;

const trimTrailingFractionZeros = (fraction: string, keep = 0): string => {
  let end = fraction.length;
  while (end > keep && fraction[end - 1] === '0') {
    end -= 1;
  }
  return fraction.slice(0, end);
};

// Scaled integer -> canonical '.'-separated string with exactly `decimals`
// fraction digits. Sign-aware: history deltas can be negative.
const scaledToFixedText = (scaled: number, decimals: number): { sign: string; whole: string; fraction: string } => {
  const value = Number.isFinite(scaled) ? Math.round(scaled) : 0;
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(value).toString();
  if (decimals === 0) {
    return { sign, whole: digits, fraction: '' };
  }
  const padded = digits.padStart(decimals + 1, '0');
  return {
    sign,
    whole: padded.slice(0, -decimals),
    fraction: padded.slice(-decimals),
  };
};

// ---------------------------------------------------------------- quantity

// Same input convention as money (sanitizeMoneyInput): canonical values use
// '.' as the decimal separator; users may type ',' or '.', and when both appear
// dots are grouping and the comma is the decimal separator.
export const sanitizeQuantityInput = (value: string, decimals: number): string => {
  if (normalizeQuantityDecimals(decimals) === 0) {
    return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  }

  const rawValue = value.replace(/[^\d.,]/g, '');
  const cleanedValue = rawValue.includes(',') ? rawValue.replace(/\./g, '').replace(/,/g, '.') : rawValue;
  const [wholePart, ...decimalParts] = cleanedValue.split('.');
  const normalizedWholePart = wholePart.replace(/^0+(?=\d)/, '');

  return decimalParts.length === 0 ? normalizedWholePart : `${normalizedWholePart}.${decimalParts.join('')}`;
};

export const quantityInputHasValidPrecision = (value: string, decimals: number): boolean => {
  if (!value) {
    return true;
  }
  const fraction = value.split('.')[1] ?? '';
  return fraction.length <= normalizeQuantityDecimals(decimals);
};

export const getQuantityPrecisionHelper = (decimals: number): string => {
  const places = normalizeQuantityDecimals(decimals);
  return places === 0
    ? 'This investment does not allow decimal quantities.'
    : `This investment allows ${places} decimal${places === 1 ? '' : 's'}.`;
};

export const getQuantityPrecisionError = (decimals: number): string => {
  const places = normalizeQuantityDecimals(decimals);
  return places === 0
    ? 'This investment does not allow decimal quantities.'
    : `This investment allows only up to ${places} decimal${places === 1 ? '' : 's'}.`;
};

// Canonical input -> scaled integer, or null when empty-invalid, too precise,
// or too large to store exactly.
export const parseQuantityInput = (value: string, decimals: number): number | null => {
  const places = normalizeQuantityDecimals(decimals);
  if (!value || !/^\d*(\.\d*)?$/.test(value) || !quantityInputHasValidPrecision(value, places)) {
    return null;
  }

  const [rawWhole, rawFraction = ''] = value.split('.');
  const text = `${rawWhole || '0'}${rawFraction.padEnd(places, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  const scaled = Number(text);
  return Number.isSafeInteger(scaled) ? scaled : null;
};

// Scaled integer -> canonical input string, trailing zeros trimmed ("1.5", "3").
export const formatQuantityToInput = (scaled: number, decimals: number): string => {
  const { sign, whole, fraction } = scaledToFixedText(scaled, normalizeQuantityDecimals(decimals));
  const trimmed = trimTrailingFractionZeros(fraction);
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
};

// Canonical input -> display while the field is blurred ("1.234,5").
export const formatQuantityInputForDisplay = (value: string): string => {
  if (!value) {
    return value;
  }
  const [wholePart, fractionPart] = value.split('.');
  const grouped = groupMoneyThousands(wholePart || '0');
  return fractionPart !== undefined ? `${grouped},${fractionPart}` : grouped;
};

// Scaled integer -> display ("1.234,5"), trailing zeros trimmed. Used for
// every investment quantity.
export const formatQuantity = (scaled: number, decimals: number): string => {
  const { sign, whole, fraction } = scaledToFixedText(scaled, normalizeQuantityDecimals(decimals));
  const trimmed = trimTrailingFractionZeros(fraction);
  const grouped = groupMoneyThousands(whole);
  return trimmed ? `${sign}${grouped},${trimmed}` : `${sign}${grouped}`;
};

// Scaled integer -> plain JS number, for spreadsheet cells and chart axes only.
// Never use the result in arithmetic that is stored.
export const quantityToNumber = (scaled: number, decimals: number): number =>
  scaled / 10 ** normalizeQuantityDecimals(decimals);

// ------------------------------------------------------------- unit value

// A MoneyCurrency whose minor unit is 10^4 times smaller, so the existing
// money helpers (MoneyField, parse/format) handle unit values unchanged:
// IDR (NumberToBasic 1) becomes 4 decimals, USD (100) becomes 6.
export const getUnitValueCurrency = (currency?: MoneyCurrency): MoneyCurrency | undefined =>
  currency ? { ...currency, NumberToBasic: Math.max(currency.NumberToBasic, 1) * UNIT_VALUE_SCALE } : undefined;

export const parseUnitValueInput = (value: string, currency?: MoneyCurrency): number | null =>
  parseMoneyInputToMinorUnits(value, getUnitValueCurrency(currency));

// Stored unit value -> canonical input, trimming the extra zeros but keeping
// the currency's own decimals ("2000000", "1.50", "1234.5678").
export const formatUnitValueToInput = (unitValue: number, currency?: MoneyCurrency): string => {
  const unitCurrency = getUnitValueCurrency(currency);
  const raw = formatMinorUnitsToMoneyInput(Math.round(unitValue), unitCurrency);
  if (!currency) {
    return raw;
  }
  const [whole, fraction = ''] = raw.split('.');
  const trimmed = trimTrailingFractionZeros(fraction, getMoneyDecimalPlaces(currency));
  return trimmed ? `${whole}.${trimmed}` : whole;
};

// Stored unit value -> display with currency prefix ("Rp. 1.234,5678").
export const formatUnitValue = (unitValue: number, currency?: MoneyCurrency): string => {
  const input = formatUnitValueToInput(unitValue, currency);
  const [whole, fraction] = input.split('.');
  const amount = fraction !== undefined ? `${groupMoneyThousands(whole)},${fraction}` : groupMoneyThousands(whole);
  const prefix = getMoneyPrefix(currency);
  return prefix ? `${prefix} ${amount}` : amount;
};

// Stored unit value -> plain JS number in the currency's major unit, for
// spreadsheet cells only.
export const unitValueToNumber = (unitValue: number, currency?: MoneyCurrency): number =>
  unitValue / (Math.max(currency?.NumberToBasic ?? 1, 1) * UNIT_VALUE_SCALE);

// ------------------------------------------------------------------ totals

const bigPow10 = (exponent: number): bigint => {
  let result = BigInt(1);
  const ten = BigInt(10);
  for (let index = 0; index < exponent; index += 1) {
    result *= ten;
  }
  return result;
};

// quantity x unit value in currency MINOR UNITS, rounded half-up (away from
// zero for negatives). BigInt because the scaled product can pass 2^53 long
// before the result does: 1,000,000 units at 8 decimals is 1e14 already.
// Returns null when an input is not an integer or the result cannot be held
// exactly — callers refuse the write rather than store a wrong amount.
export const calculateInvestmentAmount = (
  quantity: number,
  quantityDecimals: number,
  unitValue: number
): number | null => {
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitValue)) {
    return null;
  }

  const divisor = bigPow10(normalizeQuantityDecimals(quantityDecimals) + UNIT_VALUE_EXTRA_DECIMALS);
  const product = BigInt(quantity) * BigInt(unitValue);
  const negative = product < BigInt(0);
  const magnitude = negative ? -product : product;
  const rounded = (magnitude + divisor / BigInt(2)) / divisor;
  const result = Number(negative ? -rounded : rounded);

  return Number.isSafeInteger(result) ? result : null;
};

// Display-only variant: charts and lists must not crash on a value that is
// too large, so they get 0 instead of null. Never use for stored amounts.
export const calculateInvestmentAmountForDisplay = (
  quantity: number,
  quantityDecimals: number,
  unitValue: number
): number => calculateInvestmentAmount(quantity, quantityDecimals, unitValue) ?? 0;

// ------------------------------------------------------------ spreadsheets

// A spreadsheet number (a float) -> scaled integer at `decimals` places.
// Never multiply-and-truncate: 0.29 * 100 is 28.999999999999996. The float is
// scaled and ROUNDED, and only accepted when it was within float noise of an
// exact value — a real extra digit (1.234 at 2 decimals) returns
// 'too-precise' so the caller can report it instead of silently rounding.
export const spreadsheetNumberToScaled = (
  value: number,
  decimals: number
): number | 'too-precise' | null => {
  if (!Number.isFinite(value)) {
    return null;
  }

  const scaledFloat = value * 10 ** decimals;
  const rounded = Math.round(scaledFloat);
  const tolerance = Math.max(1e-6, Math.abs(scaledFloat) * 1e-12);
  if (Math.abs(scaledFloat - rounded) > tolerance) {
    return 'too-precise';
  }

  return Number.isSafeInteger(rounded) ? rounded : null;
};
