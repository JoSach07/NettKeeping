export type MoneyCurrency = {
  Code: string;
  NumberToBasic: number;
};

// Single source of truth for currency symbols across the app. Currencies
// without an entry fall back to their code.
const currencySymbols: Record<string, string> = {
  AUD: 'A$',
  BRL: 'R$',
  CAD: 'C$',
  CNY: 'CN¥',
  DKK: 'kr',
  EUR: '€',
  GBP: '£',
  HKD: 'HK$',
  IDR: 'Rp.',
  INR: '₹',
  JPY: '¥',
  KRW: '₩',
  MXN: 'MX$',
  MYR: 'RM',
  NOK: 'kr',
  NZD: 'NZ$',
  PHP: '₱',
  SEK: 'kr',
  SGD: 'S$',
  THB: '฿',
  USD: '$',
  VND: '₫',
  ZAR: 'R',
};

export const getMoneyDecimalPlaces = (currency?: MoneyCurrency) => {
  if (!currency || currency.NumberToBasic <= 1) {
    return 0;
  }

  return Math.max(Math.round(Math.log10(currency.NumberToBasic)), 0);
};

export const getMoneyPrefix = (currency?: MoneyCurrency) =>
  currency ? currencySymbols[currency.Code] ?? currency.Code : '';

export const getMoneyPrecisionHelper = (currency?: MoneyCurrency) => {
  if (!currency) {
    return '';
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    return `${currency.Code} does not allow decimals.`;
  }

  return `${currency.Code} allows ${decimalPlaces} decimal${decimalPlaces === 1 ? '' : 's'}.`;
};

export const getMoneyPrecisionError = (currency?: MoneyCurrency) => {
  if (!currency) {
    return '';
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    return `${currency.Code} does not allow decimals.`;
  }

  return `${currency.Code} allows only up to ${decimalPlaces} decimal${decimalPlaces === 1 ? '' : 's'}.`;
};

// Exchange rates are ratios, not amounts, so they are deliberately NOT clamped
// to either currency's precision — an IDR->USD rate needs far more digits than
// USD allows. Six decimals is the shared ceiling between typed input and the
// rate derived from stored amounts when editing a transfer (see
// createTransaction's edit prefill); the direction toggle covers rates that need
// more precision than this in one direction.
export const EXCHANGE_RATE_DECIMAL_PLACES = 6;

// Wording is intentionally literal rather than interpolated; keep these in
// sync with EXCHANGE_RATE_DECIMAL_PLACES if the limit ever changes.
export const EXCHANGE_RATE_PRECISION_HELPER =
  'Exchange rate allows 6 decimals. Use the flip button if you require a more precise rate.';

export const EXCHANGE_RATE_PRECISION_ERROR =
  'Use the flip button to flip your exchange rate if you require a rate more precise than six decimal points.';

export const exchangeRateHasValidPrecision = (value: string) =>
  (value.split('.')[1] ?? '').length <= EXCHANGE_RATE_DECIMAL_PLACES;

// Canonical values always use '.' as the decimal separator internally.
// Users may type either '.' or ',' as the decimal separator; when both
// appear (e.g. a pasted display value like "1.234,56"), dots are treated as
// grouping separators and the comma as the decimal separator.
export const sanitizeMoneyInput = (value: string, currency?: MoneyCurrency) => {
  if (currency && getMoneyDecimalPlaces(currency) === 0) {
    return value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  }

  const rawValue = value.replace(/[^\d.,]/g, '');
  const cleanedValue = rawValue.includes(',')
    ? rawValue.replace(/\./g, '').replace(/,/g, '.')
    : rawValue;
  const [wholePart, ...decimalParts] = cleanedValue.split('.');
  const normalizedWholePart = wholePart.replace(/^0+(?=\d)/, '');

  if (decimalParts.length === 0) {
    return normalizedWholePart;
  }

  return `${normalizedWholePart}.${decimalParts.join('')}`;
};

// Truncates a canonical money input to the decimals the currency allows.
// Used when the selected currency changes underneath an already-typed value:
// the digits stay put and only the excess decimals fall away, so USD "50.64"
// becomes IDR "50". Deliberately NOT sanitizeMoneyInput, which would strip the
// separator and turn the same value into "5064" — a silent 100x inflation that
// then feeds the insufficient-balance check and the account chart.
// String-only, so no float rounding creeps in.
export const clampMoneyInputPrecision = (value: string, currency?: MoneyCurrency) => {
  if (!value) {
    return value;
  }

  const [wholePart, decimalPart] = value.split('.');
  if (decimalPart === undefined) {
    return value;
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    return wholePart;
  }

  if (decimalPart.length <= decimalPlaces) {
    return value;
  }

  return `${wholePart}.${decimalPart.slice(0, decimalPlaces)}`;
};

export const moneyInputHasValidPrecision = (value: string, currency?: MoneyCurrency) => {
  if (!value || !currency) {
    return true;
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    return /^[\d.,]+$/.test(value);
  }

  const decimalPart = value.split('.')[1] ?? '';
  return decimalPart.length <= decimalPlaces;
};

export const parseMoneyInputToMinorUnits = (value: string, currency?: MoneyCurrency) => {
  if (!value || !currency || !moneyInputHasValidPrecision(value, currency)) {
    return null;
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    const minorUnits = Number(value.replace(/\D/g, ''));
    return Number.isSafeInteger(minorUnits) ? minorUnits : null;
  }

  const [rawWholePart, rawDecimalPart = ''] = value.split('.');
  const wholePart = rawWholePart || '0';
  const decimalPart = rawDecimalPart.padEnd(decimalPlaces, '0');
  const minorUnitsText = `${wholePart}${decimalPart}`.replace(/^0+(?=\d)/, '') || '0';
  const minorUnits = Number(minorUnitsText);

  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
};

export const formatMinorUnitsToMoneyInput = (minorUnits: string | number, currency?: MoneyCurrency) => {
  // Minor units are integers by definition. A fractional number here means a
  // caller skipped calculateInvestmentAmount (utils/investmentNumbers.ts):
  // stripping non-digits would drop the decimal point and inflate the amount
  // by orders of magnitude, so round it and say so instead.
  if (typeof minorUnits === 'number' && !Number.isInteger(minorUnits)) {
    console.warn(`formatMinorUnitsToMoneyInput received a non-integer amount (${minorUnits}); rounding it.`);
    minorUnits = Number.isFinite(minorUnits) ? Math.round(minorUnits) : 0;
  }
  const amountText = minorUnits.toString().replace(/\D/g, '');
  if (!currency) {
    return amountText;
  }

  const decimalPlaces = getMoneyDecimalPlaces(currency);
  if (decimalPlaces === 0) {
    return amountText.replace(/^0+(?=\d)/, '') || '0';
  }

  const paddedAmount = (amountText || '0').padStart(decimalPlaces + 1, '0');
  const wholePart = paddedAmount.slice(0, -decimalPlaces).replace(/^0+(?=\d)/, '') || '0';
  const decimalPart = paddedAmount.slice(-decimalPlaces);

  return `${wholePart}.${decimalPart}`;
};

// Display convention: '.' groups thousands, ',' separates decimals
// (e.g. "1.234,56").
export const groupMoneyThousands = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export const formatMoneyInputForDisplay = (value: string) => {
  if (!value) {
    return value;
  }

  const [wholePart, decimalPart] = value.split('.');
  const groupedWholePart = groupMoneyThousands(wholePart || '0');

  return decimalPart !== undefined ? `${groupedWholePart},${decimalPart}` : groupedWholePart;
};

export const formatMinorUnitsForDisplay = (minorUnits: string | number, currency?: MoneyCurrency) => {
  const moneyInput = formatMinorUnitsToMoneyInput(minorUnits, currency);
  const prefix = getMoneyPrefix(currency);
  const amount = formatMoneyInputForDisplay(moneyInput);

  return prefix ? `${prefix} ${amount}` : amount;
};

// Shared display helpers for amounts stored in minor units.
export const formatCurrencyAmount = (minorUnits: string | number, currency?: MoneyCurrency) =>
  formatMinorUnitsForDisplay(minorUnits, currency);

export const formatHiddenCurrencyAmount = (currency?: MoneyCurrency) => {
  const prefix = getMoneyPrefix(currency);
  return prefix ? `${prefix} ••••••` : '••••••';
};

