import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import BulkInsertModal from '@/components/BulkInsertModal';
import Button from '@/components/themed/Button';
import CalendarPickerModal from '@/components/themed/CalendarPickerModal';
import ConfirmationPopup from '@/components/themed/ConfirmationPopup';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { FieldLabel, MoneyField, QuantityField, SelectField, TextAreaField, TextField } from '@/components/themed/fields';
import { useAppTheme } from '@/hooks/useAppTheme';
import { Account, getAllAccounts } from '@/database/tables/accounts';
import {
  Category,
  getCategories,
  isInvestmentCategoryId,
  isTransferCategoryId,
  TRANSFER_FROM_CATEGORY_ID,
  TRANSFER_INTO_CATEGORY_ID,
} from '@/database/tables/categories';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { Investment, getInvestments } from '@/database/tables/investments';
import {
  getMostUsedCategoryId,
  getMostUsedTransactionTypeId,
  getTransactionEditDetails,
  insertInvestmentTransaction,
  insertTransaction,
  insertTransferTransaction,
  TransactionEditDetails,
  updateInvestmentTransaction,
  updateTransaction,
  updateTransferTransaction,
} from '@/database/tables/transactions';
import { getTransactionTypes, TransactionType } from '@/database/tables/transactionTypes';
import {
  EXCHANGE_RATE_DECIMAL_PLACES,
  EXCHANGE_RATE_PRECISION_ERROR,
  EXCHANGE_RATE_PRECISION_HELPER,
  exchangeRateHasValidPrecision,
  formatMinorUnitsForDisplay,
  formatMinorUnitsToMoneyInput,
  formatMoneyInputForDisplay,
  getMoneyPrecisionError,
  getMoneyPrefix,
  moneyInputHasValidPrecision,
  parseMoneyInputToMinorUnits,
  sanitizeMoneyInput,
} from '@/utils/moneyInput';
import {
  calculateInvestmentAmount,
  formatQuantityToInput,
  formatUnitValueToInput,
  getQuantityPrecisionError,
  getUnitValueCurrency,
  parseQuantityInput,
  parseUnitValueInput,
  quantityInputHasValidPrecision,
} from '@/utils/investmentNumbers';
import { formatDbDate, parseDbDate, startOfDbDate } from '@/utils/dbDate';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';

type SelectFieldName = 'category' | 'account' | 'fromAccount' | 'toAccount' | 'investment';
type ExchangeRateDirection = 'fromTo' | 'toFrom';
type ConfirmationAction = 'clear' | 'save' | null;
type FieldErrorName = 'amount' | 'quantity' | 'unitValue' | 'additionalFees';
// The message is shown under the field as well as in the popup: the popup
// hides itself, the field keeps it until edited.
type FieldError = { field: FieldErrorName; message: string } | null;
type PopupMessage = {
  // Raw technical text behind a generic message, shown under the popup's
  // Details toggle. Only failures that were not already phrased for the user
  // carry one.
  detail?: string;
  message: string;
  title?: string;
  variant: 'danger' | 'info' | 'success' | 'warning';
};

type CreateTransactionParams = {
  accountId?: string;
  amount?: string;
  categoryId?: string;
  date?: string;
  description?: string;
  editTransactionId?: string;
  exchangeRate?: string;
  exchangeRateDirection?: string;
  fromAccountId?: string;
  investmentId?: string;
  transactionTypeId?: string;
  additionalFees?: string;
  quantity?: string;
  // Fresh on every return from selectTransactionField, so the params effect runs
  // even when the picked value equals the previous return's (bug #14).
  selectionNonce?: string;
  toAccountId?: string;
  unitValue?: string;
};

const actionAreaHorizontalOffset = 15;
const actionMaxGap = 32;
const clearButtonMinWidth = 92;
// Matches Button's regular minWidth, which wins over a smaller width anyway.
const saveButtonWidth = 144;

const pad = (value: number) => value.toString().padStart(2, '0');

const parseParamNumber = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

const parseParamString = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

const hasParam = (value: string | string[] | undefined) => value !== undefined;

const parseExchangeRateDirection = (value: string | string[] | undefined): ExchangeRateDirection =>
  parseParamString(value) === 'toFrom' ? 'toFrom' : 'fromTo';

const parseDateParam = (value: string | string[] | undefined) => {
  const rawValue = parseParamString(value);
  const parsedDate = rawValue ? parseDbDate(rawValue) : new Date();
  return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
};

const formatDisplayDate = (date: Date) =>
  `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;

// Local midnight of the row's calendar day.
const parseDateOnly = (rawDate: string | Date) => startOfDbDate(rawDate);

const isBeforeBalanceAnchor = (transactionDate: Date, account?: Account) => {
  if (!account) {
    return false;
  }

  return parseDateOnly(transactionDate).getTime() < parseDateOnly(account.BalanceAnchorDate).getTime();
};

const getNextAccountAfterTransaction = (
  account: Account,
  amount: number,
  isIncome: boolean,
  transactionDate: Date
): Account => {
  const balanceChange = isIncome ? amount : -amount;

  if (isBeforeBalanceAnchor(transactionDate, account)) {
    const transactionTime = parseDateOnly(transactionDate).getTime();
    const openingTime = parseDateOnly(account.OpeningBalanceDate).getTime();

    return {
      ...account,
      OpeningBalance: account.OpeningBalance - balanceChange,
      OpeningBalanceDate: transactionTime < openingTime ? formatDbDate(transactionDate) : account.OpeningBalanceDate,
    };
  }

  return {
    ...account,
    Balance: account.Balance + balanceChange,
  };
};


const getTransferToAmount = (
  fromAmount: number,
  fromCurrency: Currency,
  toCurrency: Currency,
  exchangeRateValue: number,
  exchangeRateDirection: ExchangeRateDirection
) => {
  const fromBasicAmount = fromAmount / fromCurrency.NumberToBasic;
  const toBasicAmount =
    exchangeRateDirection === 'fromTo' ? fromBasicAmount * exchangeRateValue : fromBasicAmount / exchangeRateValue;

  return Math.round(toBasicAmount * toCurrency.NumberToBasic);
};

export default function CreateTransactionScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<CreateTransactionParams>();
  const { colors, leftHandedMode } = useAppTheme();
  const { width } = useWindowDimensions();
  const saveButtonLeft = Math.max((width - saveButtonWidth) / 2, 0);
  const actionGap = Math.min(Math.max((saveButtonLeft - clearButtonMinWidth) / 2, 0), actionMaxGap);
  const clearButtonWidth = Math.max(saveButtonLeft - actionGap * 2, clearButtonMinWidth);
  const initialDate = useMemo(() => parseDateParam(params.date), [params.date]);
  const scrollViewRef = useRef<ScrollView>(null);
  const [transactionTypes, setTransactionTypes] = useState<TransactionType[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [selectedTransactionTypeId, setSelectedTransactionTypeId] = useState<number | null>(parseParamNumber(params.transactionTypeId));
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(parseParamNumber(params.categoryId));
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(parseParamNumber(params.accountId));
  const [selectedFromAccountId, setSelectedFromAccountId] = useState<number | null>(parseParamNumber(params.fromAccountId));
  const [selectedToAccountId, setSelectedToAccountId] = useState<number | null>(parseParamNumber(params.toAccountId));
  const [selectedInvestmentId, setSelectedInvestmentId] = useState<number | null>(parseParamNumber(params.investmentId));
  const [amount, setAmount] = useState(sanitizeMoneyInput(parseParamString(params.amount)));
  // Canonical quantity input ('.' decimal). Params carry this screen's own
  // canonical value back from the selection page, so only digits and '.' are kept.
  const [investmentQuantity, setInvestmentQuantity] = useState(parseParamString(params.quantity).replace(/[^\d.]/g, ''));
  // Decimals of the investment being edited, for when it is not in the active
  // list (e.g. deleted since). Normally selectedInvestment provides them.
  const [editQuantityDecimals, setEditQuantityDecimals] = useState<number | null>(null);
  const [investmentUnitValue, setInvestmentUnitValue] = useState(sanitizeMoneyInput(parseParamString(params.unitValue)));
  const [investmentAdditionalFees, setInvestmentAdditionalFees] = useState(sanitizeMoneyInput(parseParamString(params.additionalFees)));
  const [exchangeRate, setExchangeRate] = useState(parseParamString(params.exchangeRate).replace(/[^\d.]/g, ''));
  const [exchangeRateDirection, setExchangeRateDirection] = useState<ExchangeRateDirection>(
    parseExchangeRateDirection(params.exchangeRateDirection)
  );
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  // Not truncated to 255 here or in the params effect below: the field allows
  // overshooting on purpose, and slicing would silently delete the user's
  // overflow every time they opened a dropdown and came back. Save-time
  // validation is what rejects an over-length description.
  const [description, setDescription] = useState(parseParamString(params.description));
  const [descriptionFocused, setDescriptionFocused] = useState(false);
  const [exchangeRateFocused, setExchangeRateFocused] = useState(false);
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);
  const [bulkInsertOpen, setBulkInsertOpen] = useState(false);
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>(null);
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [saving, setSaving] = useState(false);
  const editTransactionId = parseParamNumber(params.editTransactionId);
  const isEditMode = editTransactionId !== null;
  const [editDetails, setEditDetails] = useState<TransactionEditDetails | null>(null);
  const [editPrefilled, setEditPrefilled] = useState(false);
  // Tracks the investment whose value we last auto-filled, and what we wrote,
  // so the suggestion can be replaced when the investment changes but never
  // overwrites a value the user typed themselves.
  const autoFilledUnitValueRef = useRef<{ investmentId: number; value: string } | null>(null);

  const categoryOptions = useMemo(
    () => categories.filter((item) => item.TransactionTypeId === selectedTransactionTypeId && item.IsActive),
    [categories, selectedTransactionTypeId]
  );

  // Income first, regardless of seed order.
  const transactionTypeOptions = useMemo(
    () => [...transactionTypes].sort((a, b) => Number(b.IsIncome) - Number(a.IsIncome)),
    [transactionTypes]
  );

  const selectedTransactionType = useMemo(
    () => transactionTypes.find((item) => item.Id === selectedTransactionTypeId),
    [transactionTypes, selectedTransactionTypeId]
  );

  const selectedCategory = useMemo(
    () => categoryOptions.find((item) => item.Id === selectedCategoryId),
    [categoryOptions, selectedCategoryId]
  );

  // Resolved by Id alone. `accounts` comes from getAllAccounts, so a removed
  // account referenced by the transaction being edited still resolves and keeps
  // its name and currency. Filtering on IsActive here used to blank the field
  // AND drop the currency, and without a currency the amount could not be
  // parsed back into minor units — those transactions could not be re-saved at
  // all. New selections stay restricted to active accounts by the picker on
  // selectTransactionField, which is a separate query.
  const selectedAccount = useMemo(
    () => accounts.find((item) => item.Id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const selectedFromAccount = useMemo(
    () => accounts.find((item) => item.Id === selectedFromAccountId),
    [accounts, selectedFromAccountId]
  );

  const selectedToAccount = useMemo(
    () => accounts.find((item) => item.Id === selectedToAccountId),
    [accounts, selectedToAccountId]
  );

  const removedAccountNotice = (account?: Account) =>
    account && !account.IsActive ? 'This account has been removed.' : undefined;

  const selectedInvestment = useMemo(
    () => investments.find((item) => item.Id === selectedInvestmentId),
    [investments, selectedInvestmentId]
  );
  const investmentQuantityDecimals = selectedInvestment?.QuantityDecimals ?? editQuantityDecimals ?? 0;

  const selectedCurrency = useMemo(
    () => currencies.find((item) => item.Id === selectedAccount?.CurrencyId && item.IsActive),
    [currencies, selectedAccount]
  );

  const selectedFromCurrency = useMemo(
    () => currencies.find((item) => item.Id === selectedFromAccount?.CurrencyId && item.IsActive),
    [currencies, selectedFromAccount]
  );

  const selectedToCurrency = useMemo(
    () => currencies.find((item) => item.Id === selectedToAccount?.CurrencyId && item.IsActive),
    [currencies, selectedToAccount]
  );

  const isTransferCategory = selectedCategory ? isTransferCategoryId(selectedCategory.Id) : false;
  const isInvestmentCategory = selectedCategory ? isInvestmentCategoryId(selectedCategory.Id) : false;
  const transferFromCategory = useMemo(
    () => categories.find((item) => item.IsActive && item.Id === TRANSFER_FROM_CATEGORY_ID),
    [categories]
  );
  const transferIntoCategory = useMemo(
    () => categories.find((item) => item.IsActive && item.Id === TRANSFER_INTO_CATEGORY_ID),
    [categories]
  );
  const transferUsesDifferentCurrencies =
    Boolean(selectedFromCurrency && selectedToCurrency && selectedFromCurrency.Id !== selectedToCurrency.Id);
  const amountCurrency = isTransferCategory ? selectedFromCurrency : selectedCurrency;
  const exchangeRateCurrency = exchangeRateDirection === 'fromTo' ? selectedToCurrency : selectedFromCurrency;
  // Unit values carry 4 more decimals than the currency (utils/investmentNumbers).
  const unitValueCurrency = getUnitValueCurrency(amountCurrency);
  const investmentTotalAmount = useMemo(() => {
    const quantity = parseQuantityInput(investmentQuantity, investmentQuantityDecimals);
    const unitValue = parseUnitValueInput(investmentUnitValue, amountCurrency);
    const additionalFees = investmentAdditionalFees ? parseMoneyInputToMinorUnits(investmentAdditionalFees, amountCurrency) : 0;

    if (quantity === null || unitValue === null || additionalFees === null) {
      return 0;
    }

    const grossAmount = calculateInvestmentAmount(quantity, investmentQuantityDecimals, unitValue);
    if (grossAmount === null) {
      return 0;
    }
    return selectedTransactionType?.IsIncome ? grossAmount - additionalFees : grossAmount + additionalFees;
  }, [
    amountCurrency,
    investmentAdditionalFees,
    investmentQuantity,
    investmentQuantityDecimals,
    investmentUnitValue,
    selectedTransactionType?.IsIncome,
  ]);
  const displayedInvestmentTotalAmount = useMemo(
    () => (investmentTotalAmount > 0 ? formatMinorUnitsForDisplay(investmentTotalAmount, amountCurrency) : ''),
    [amountCurrency, investmentTotalAmount]
  );
  const exchangeRatePrefix = getMoneyPrefix(exchangeRateCurrency);
  // Grouping separators are shown only while the field is not being edited,
  // matching MoneyField. Displaying them during typing feeds them straight back
  // into the change handler: "1.600" + "0" reads as one-point-six-thousand, so
  // any rate of 1000 or more became impossible to enter.
  const displayedExchangeRate = useMemo(
    () => (exchangeRateFocused ? exchangeRate : formatMoneyInputForDisplay(exchangeRate)),
    [exchangeRate, exchangeRateFocused]
  );
  const exchangeRateHasPrecisionError = !exchangeRateHasValidPrecision(exchangeRate);
  // Surfaces the amount actually credited to the destination account. The
  // conversion rounds to the destination currency's precision, and for
  // currencies with no minor unit (IDR, JPY) that rounding is to a whole unit —
  // invisible until now, since only the source amount was ever shown.
  const previewTransferToAmount = useMemo(() => {
    if (!isTransferCategory || !transferUsesDifferentCurrencies || !selectedFromCurrency || !selectedToCurrency) {
      return null;
    }

    const fromAmount = parseMoneyInputToMinorUnits(amount, selectedFromCurrency);
    const numericRate = Number(exchangeRate);

    if (fromAmount === null || fromAmount <= 0 || !Number.isFinite(numericRate) || numericRate <= 0) {
      return null;
    }

    return getTransferToAmount(
      fromAmount,
      selectedFromCurrency,
      selectedToCurrency,
      numericRate,
      exchangeRateDirection
    );
  }, [
    amount,
    exchangeRate,
    exchangeRateDirection,
    isTransferCategory,
    selectedFromCurrency,
    selectedToCurrency,
    transferUsesDifferentCurrencies,
  ]);
  // Named "preview" to stay clear of the identically-derived local inside
  // handleSave, which recomputes from the validated amount.
  const displayedTransferToAmount =
    previewTransferToAmount !== null && previewTransferToAmount > 0
      ? formatMinorUnitsForDisplay(previewTransferToAmount, selectedToCurrency)
      : '';

  const loadInvestments = useCallback(async () => {
    const result = await getInvestments();
    if (result.Status === 'Success') {
      setInvestments(result.Data);
      return;
    }

    setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Failed to load investments.', variant: 'danger' });
  }, []);

  const loadFormData = useCallback(async () => {
    const [transactionTypeResult, categoryResult, accountResult, currencyResult, investmentResult, mostUsedTransactionTypeResult] = await Promise.all([
      getTransactionTypes(),
      getCategories(),
      getAllAccounts(),
      getCurrencies(),
      getInvestments(),
      getMostUsedTransactionTypeId(),
    ]);
    const failedMessages: ErrorMessage[] = [];

    if (transactionTypeResult.Status === 'Success') {
      setTransactionTypes(transactionTypeResult.Data);
    } else {
      failedMessages.push(toErrorMessage(transactionTypeResult, 'Failed to load transaction types.'));
    }

    if (categoryResult.Status === 'Success') {
      setCategories(categoryResult.Data);
    } else {
      failedMessages.push(toErrorMessage(categoryResult, 'Failed to load categories.'));
    }

    if (accountResult.Status === 'Success') {
      setAccounts(accountResult.Data);
    } else {
      failedMessages.push(toErrorMessage(accountResult, 'Failed to load accounts.'));
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    } else {
      failedMessages.push(toErrorMessage(currencyResult, 'Failed to load currencies.'));
    }

    if (investmentResult.Status === 'Success') {
      setInvestments(investmentResult.Data);
    } else {
      failedMessages.push(toErrorMessage(investmentResult, 'Failed to load investments.'));
    }

    if (transactionTypeResult.Status === 'Success' && categoryResult.Status === 'Success') {
      const paramTransactionTypeId = parseParamNumber(params.transactionTypeId);
      const preferredTransactionTypeId =
        paramTransactionTypeId ?? mostUsedTransactionTypeResult.DataId ?? transactionTypeResult.Data[0]?.Id ?? null;

      setSelectedTransactionTypeId((current) => current ?? preferredTransactionTypeId);

      if (preferredTransactionTypeId) {
        const mostUsedCategoryResult = await getMostUsedCategoryId(preferredTransactionTypeId);
        const paramCategoryId = parseParamNumber(params.categoryId);
        const fallbackCategoryId =
          categoryResult.Data.find((item) => item.IsActive && item.TransactionTypeId === preferredTransactionTypeId)?.Id ??
          null;

        setSelectedCategoryId(
          (current) => current ?? paramCategoryId ?? mostUsedCategoryResult.DataId ?? fallbackCategoryId
        );
      }
    }

    if (failedMessages.length > 0) {
      setPopupMessage({ ...joinErrorMessages(failedMessages), variant: 'danger' });
    }
  }, [params.categoryId, params.transactionTypeId]);

  useEffect(() => {
    loadFormData();
  }, [loadFormData]);

  useEffect(() => {
    if (!editTransactionId) {
      setEditDetails(null);
      setEditPrefilled(false);
      return;
    }

    let isActive = true;
    getTransactionEditDetails(editTransactionId).then((result) => {
      if (!isActive) {
        return;
      }

      if (result.Status === 'Success' && result.Data) {
        setEditDetails(result.Data);
      } else {
        setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Unable to load transaction.', variant: 'danger' });
      }
    });

    return () => {
      isActive = false;
    };
  }, [editTransactionId]);

  // Prefills the form once edit details AND reference data are available.
  // Money fields need the account currency to convert minor units back into
  // editable input strings.
  useEffect(() => {
    if (!editDetails || editPrefilled || accounts.length === 0 || currencies.length === 0) {
      return;
    }

    const findCurrency = (accountId?: number) => {
      const account = accounts.find((item) => item.Id === accountId);
      return currencies.find((item) => item.Id === account?.CurrencyId);
    };

    setSelectedTransactionTypeId(editDetails.TransactionTypeId);
    setSelectedCategoryId(editDetails.CategoryId);
    setDescription(editDetails.Description ?? '');

    const transactionDate = parseDateOnly(editDetails.TransactionDate);
    setSelectedDate(transactionDate);

    if (editDetails.Kind === 'transfer') {
      setSelectedFromAccountId(editDetails.FromAccountId ?? null);
      setSelectedToAccountId(editDetails.ToAccountId ?? null);

      const fromCurrency = findCurrency(editDetails.FromAccountId);
      const toCurrency = findCurrency(editDetails.ToAccountId);
      setAmount(formatMinorUnitsToMoneyInput(editDetails.FromAmount ?? 0, fromCurrency));

      if (fromCurrency && toCurrency && fromCurrency.Id !== toCurrency.Id && editDetails.FromAmount) {
        const fromBasicAmount = editDetails.FromAmount / fromCurrency.NumberToBasic;
        const toBasicAmount = (editDetails.ToAmount ?? 0) / toCurrency.NumberToBasic;
        const derivedRate = fromBasicAmount > 0 ? toBasicAmount / fromBasicAmount : 0;
        // No rate is stored, so it is re-derived from the two amounts and needs
        // rounding to avoid float noise like 1.2345600000000001. This must use
        // the same ceiling the input enforces, or reopening a transfer would
        // silently change its rate.
        setExchangeRate(derivedRate > 0 ? String(Number(derivedRate.toFixed(EXCHANGE_RATE_DECIMAL_PLACES))) : '');
        setExchangeRateDirection('fromTo');
      }
    } else if (editDetails.Kind === 'investment') {
      setSelectedAccountId(editDetails.AccountId);
      setSelectedInvestmentId(editDetails.InvestmentId ?? null);

      const currency = findCurrency(editDetails.AccountId);
      setEditQuantityDecimals(editDetails.QuantityDecimals ?? 0);
      setInvestmentQuantity(formatQuantityToInput(editDetails.Quantity ?? 0, editDetails.QuantityDecimals ?? 0));
      setInvestmentUnitValue(formatUnitValueToInput(editDetails.UnitValue ?? 0, currency));
      setInvestmentAdditionalFees(
        editDetails.AdditionalFees ? formatMinorUnitsToMoneyInput(editDetails.AdditionalFees, currency) : ''
      );
    } else {
      setSelectedAccountId(editDetails.AccountId);
      setAmount(formatMinorUnitsToMoneyInput(editDetails.Amount, findCurrency(editDetails.AccountId)));
    }

    setEditPrefilled(true);
  }, [accounts, currencies, editDetails, editPrefilled]);

  useEffect(() => {
    if (hasParam(params.investmentId)) {
      loadInvestments();
    }
  }, [loadInvestments, params.investmentId]);

  // A category id the loaded list doesn't know yet (one just created in
  // selectTransactionField) is applied together with the refreshed list, so the
  // defaultCategory effect never sees it against a stale list and replaces it
  // (bug #15). The ref drops a late response if a newer return came in.
  const categoryParamRequestRef = useRef(0);
  useEffect(() => {
    if (hasParam(params.transactionTypeId)) {
      setSelectedTransactionTypeId(parseParamNumber(params.transactionTypeId));
    }

    if (hasParam(params.categoryId)) {
      const paramCategoryId = parseParamNumber(params.categoryId);
      const requestId = ++categoryParamRequestRef.current;

      if (paramCategoryId === null || categories.some((item) => item.Id === paramCategoryId)) {
        setSelectedCategoryId(paramCategoryId);
      } else {
        getCategories().then((result) => {
          if (requestId !== categoryParamRequestRef.current) {
            return;
          }

          if (result.Status === 'Success') {
            setCategories(result.Data);
          }
          setSelectedCategoryId(paramCategoryId);
        });
      }
    }

    if (hasParam(params.accountId)) {
      setSelectedAccountId(parseParamNumber(params.accountId));
    }

    if (hasParam(params.fromAccountId)) {
      setSelectedFromAccountId(parseParamNumber(params.fromAccountId));
    }

    if (hasParam(params.toAccountId)) {
      setSelectedToAccountId(parseParamNumber(params.toAccountId));
    }

    if (hasParam(params.investmentId)) {
      setSelectedInvestmentId(parseParamNumber(params.investmentId));
    }

    if (hasParam(params.amount)) {
      setAmount(sanitizeMoneyInput(parseParamString(params.amount)));
    }

    if (hasParam(params.quantity)) {
      setInvestmentQuantity(parseParamString(params.quantity).replace(/[^\d.]/g, ''));
    }

    if (hasParam(params.unitValue)) {
      setInvestmentUnitValue(sanitizeMoneyInput(parseParamString(params.unitValue)));
    }

    if (hasParam(params.additionalFees)) {
      setInvestmentAdditionalFees(sanitizeMoneyInput(parseParamString(params.additionalFees)));
    }

    if (hasParam(params.exchangeRate)) {
      setExchangeRate(parseParamString(params.exchangeRate).replace(/[^\d.]/g, ''));
    }

    if (hasParam(params.exchangeRateDirection)) {
      setExchangeRateDirection(parseExchangeRateDirection(params.exchangeRateDirection));
    }

    if (hasParam(params.description)) {
      setDescription(parseParamString(params.description));
    }

    if (hasParam(params.date)) {
      const nextDate = parseDateParam(params.date);
      setSelectedDate(nextDate);
    }
  }, [
    params.accountId,
    params.amount,
    params.categoryId,
    params.date,
    params.description,
    params.exchangeRate,
    params.exchangeRateDirection,
    params.fromAccountId,
    params.investmentId,
    params.transactionTypeId,
    params.additionalFees,
    params.quantity,
    params.selectionNonce,
    params.toAccountId,
    params.unitValue,
  ]);

  useEffect(() => {
    let isActive = true;

    const defaultCategory = async () => {
      if (!selectedTransactionTypeId) {
        setSelectedCategoryId(null);
        return;
      }

      const currentIsValid =
        selectedCategoryId !== null && categoryOptions.some((item) => item.Id === selectedCategoryId);

      if (currentIsValid) {
        return;
      }

      const mostUsedCategoryResult = await getMostUsedCategoryId(selectedTransactionTypeId);
      if (!isActive) {
        return;
      }

      const fallbackCategoryId = categoryOptions[0]?.Id ?? null;
      setSelectedCategoryId(mostUsedCategoryResult.DataId ?? fallbackCategoryId);
    };

    defaultCategory();

    return () => {
      isActive = false;
    };
  }, [categoryOptions, selectedCategoryId, selectedTransactionTypeId]);

  // Suggests the investment's latest recorded value per unit. It is only a
  // starting point — for a buy the user will usually replace it with today's
  // price — so it never overwrites anything typed by hand, and it re-suggests
  // when the selected investment changes.
  useEffect(() => {
    if (isEditMode || !isInvestmentCategory || !selectedInvestment || !amountCurrency) {
      return;
    }

    // A newly created investment has no recorded value yet. Filling in 0 would
    // only trip the "value per unit must be positive" check on save.
    if (selectedInvestment.UnitValue <= 0) {
      return;
    }

    const autoFilled = autoFilledUnitValueRef.current;
    const isUserEdited = investmentUnitValue !== '' && autoFilled?.value !== investmentUnitValue;

    if (isUserEdited || autoFilled?.investmentId === selectedInvestment.Id) {
      return;
    }

    const suggestedValue = formatUnitValueToInput(selectedInvestment.UnitValue, amountCurrency);
    autoFilledUnitValueRef.current = { investmentId: selectedInvestment.Id, value: suggestedValue };
    setInvestmentUnitValue(suggestedValue);
    setFieldError((current) => (current?.field === 'unitValue' ? null : current));
  }, [amountCurrency, investmentUnitValue, isEditMode, isInvestmentCategory, selectedInvestment]);

  const failField = (field: FieldErrorName, message: string) => {
    setFieldError({ field, message });
    setPopupMessage({ message, variant: 'danger' });
  };

  const handleAmountChange = (value: string) => {
    setFieldError((current) => (current?.field === 'amount' ? null : current));
    setAmount(value);
  };

  const handleInvestmentQuantityChange = (value: string) => {
    setFieldError((current) => (current?.field === 'quantity' ? null : current));
    setInvestmentQuantity(value);
  };

  const handleInvestmentUnitValueChange = (value: string) => {
    setFieldError((current) => (current?.field === 'unitValue' ? null : current));
    setInvestmentUnitValue(value);
  };

  const handleInvestmentAdditionalFeesChange = (value: string) => {
    setFieldError((current) => (current?.field === 'additionalFees' ? null : current));
    setInvestmentAdditionalFees(value);
  };

  // The field renders a display-formatted value ("1,5"), so the raw text coming
  // back here uses ',' as the decimal separator. Stripping it — as this used to
  // do — silently turned "1,5" into "15" on the very next keystroke, which is
  // why decimals never survived. sanitizeMoneyInput is the same round-trip
  // MoneyField relies on and handles both separators.
  const handleExchangeRateChange = (value: string) => {
    // Some native inputs echo the display-only value back after blur; that
    // grouped text must not be re-parsed as a new entry.
    if (!exchangeRateFocused && value === displayedExchangeRate) {
      return;
    }

    setExchangeRate(sanitizeMoneyInput(value));
  };

  const toggleExchangeRateDirection = () => {
    setExchangeRateDirection((current) => (current === 'fromTo' ? 'toFrom' : 'fromTo'));
  };

  const getSelectionParams = (field: SelectFieldName) => ({
    accountId: selectedAccountId?.toString() ?? '',
    amount,
    categoryId: selectedCategoryId?.toString() ?? '',
    date: formatDbDate(selectedDate),
    description,
    editTransactionId: editTransactionId?.toString() ?? '',
    exchangeRate,
    exchangeRateDirection,
    field,
    fromAccountId: selectedFromAccountId?.toString() ?? '',
    investmentId: selectedInvestmentId?.toString() ?? '',
    transactionTypeId: selectedTransactionTypeId?.toString() ?? '',
    additionalFees: investmentAdditionalFees,
    quantity: investmentQuantity,
    toAccountId: selectedToAccountId?.toString() ?? '',
    unitValue: investmentUnitValue,
  });

  // Switching type resolves the new type's default category (most used, else
  // the first active one) BEFORE committing anything, then sets type and
  // category together. Clearing the category first and letting the
  // defaultCategory effect refill it caused one render with no category,
  // which flashed the plain form between two investment forms.
  // Re-tapping the selected type is a no-op; the ref makes rapid taps
  // resolve to the last one only.
  const transactionTypeRequestRef = useRef(0);
  const selectTransactionType = async (transactionTypeId: number) => {
    if (transactionTypeId === selectedTransactionTypeId) {
      return;
    }

    const requestId = ++transactionTypeRequestRef.current;
    const mostUsedCategoryResult = await getMostUsedCategoryId(transactionTypeId);
    if (requestId !== transactionTypeRequestRef.current) {
      return;
    }

    const fallbackCategoryId =
      categories.find((item) => item.IsActive && item.TransactionTypeId === transactionTypeId)?.Id ?? null;
    setSelectedTransactionTypeId(transactionTypeId);
    setSelectedCategoryId(mostUsedCategoryResult.DataId ?? fallbackCategoryId);
  };

  const openSelection = (field: SelectFieldName) => {
    router.push({
      pathname: '/selectTransactionField',
      params: getSelectionParams(field),
    });
  };

  const validateSaveForm = () => {
    const amountMinorUnits = parseMoneyInputToMinorUnits(amount, amountCurrency);
    const numericAmount = isInvestmentCategory ? investmentTotalAmount : amountMinorUnits;
    const numericInvestmentQuantity = parseQuantityInput(investmentQuantity, investmentQuantityDecimals);
    const investmentUnitValueMinorUnits = parseUnitValueInput(investmentUnitValue, amountCurrency);
    const investmentAdditionalFeesMinorUnits = investmentAdditionalFees
      ? parseMoneyInputToMinorUnits(investmentAdditionalFees, amountCurrency)
      : 0;
    setFieldError(null);

    if (!selectedTransactionTypeId) {
      setPopupMessage({ message: 'Transaction type is required.', variant: 'danger' });
      return false;
    }

    if (!selectedCategoryId) {
      setPopupMessage({ message: 'Category is required.', variant: 'danger' });
      return false;
    }

    if (!isTransferCategory && !selectedAccountId) {
      setPopupMessage({ message: 'Account is required.', variant: 'danger' });
      return false;
    }

    if (isInvestmentCategory && !selectedInvestmentId) {
      setPopupMessage({ message: 'Investment is required.', variant: 'danger' });
      return false;
    }

    if (
      isInvestmentCategory &&
      selectedAccount &&
      selectedInvestment &&
      selectedInvestment.CurrencyId !== selectedAccount.CurrencyId
    ) {
      setPopupMessage({ message: 'Investment currency must match the selected account currency.', variant: 'danger' });
      return false;
    }

    if (isTransferCategory && !selectedFromAccountId) {
      setPopupMessage({ message: 'From account is required.', variant: 'danger' });
      return false;
    }

    if (isTransferCategory && !selectedToAccountId) {
      setPopupMessage({ message: 'To account is required.', variant: 'danger' });
      return false;
    }

    if (isTransferCategory && selectedFromAccountId === selectedToAccountId) {
      setPopupMessage({ message: 'From and To accounts must be different.', variant: 'danger' });
      return false;
    }

    if (isInvestmentCategory) {
      if (!quantityInputHasValidPrecision(investmentQuantity, investmentQuantityDecimals)) {
        failField('quantity', getQuantityPrecisionError(investmentQuantityDecimals));
        return false;
      }

      if (!investmentQuantity || numericInvestmentQuantity === null || numericInvestmentQuantity <= 0) {
        failField('quantity', 'Quantity must be a positive number.');
        return false;
      }

      if (!moneyInputHasValidPrecision(investmentUnitValue, unitValueCurrency)) {
        failField('unitValue', getMoneyPrecisionError(unitValueCurrency));
        return false;
      }

      if (!investmentUnitValue || investmentUnitValueMinorUnits === null || investmentUnitValueMinorUnits <= 0) {
        failField('unitValue', 'Value per unit must be a positive number.');
        return false;
      }

      // In edit mode the stored transaction already contributes to the current
      // quantity, so this client-side check would be wrong; the database
      // validates the full timeline on save instead.
      if (!isEditMode && selectedTransactionType?.IsIncome && selectedInvestment && numericInvestmentQuantity > selectedInvestment.Quantity) {
        failField('quantity', 'Liquidation quantity cannot be higher than current investment quantity.');
        return false;
      }

      if (
        investmentAdditionalFees &&
        !moneyInputHasValidPrecision(investmentAdditionalFees, amountCurrency)
      ) {
        failField('additionalFees', getMoneyPrecisionError(amountCurrency));
        return false;
      }

      if (
        investmentAdditionalFees &&
        (investmentAdditionalFeesMinorUnits === null || investmentAdditionalFeesMinorUnits < 0)
      ) {
        failField('additionalFees', 'Additional fees must be zero or a positive number.');
        return false;
      }
    }

    if (!isInvestmentCategory && !moneyInputHasValidPrecision(amount, amountCurrency)) {
      failField('amount', getMoneyPrecisionError(amountCurrency));
      return false;
    }

    if (!isInvestmentCategory && (!amount || numericAmount === null || numericAmount <= 0)) {
      failField('amount', 'Amount must be a positive number.');
      return false;
    }

    if (isInvestmentCategory && (numericAmount === null || numericAmount <= 0)) {
      setPopupMessage({ message: 'Total amount must be greater than zero.', variant: 'danger' });
      return false;
    }

    const validatedAmount = numericAmount ?? 0;

    // The balance checks below are skipped in edit mode: current balances
    // still include the original transaction, so comparing against them would
    // give false results. The database rebuild rejects negative balances.
    if (
      !isEditMode &&
      isTransferCategory &&
      selectedFromAccount &&
      selectedFromCurrency &&
      selectedToCurrency &&
      !isBeforeBalanceAnchor(selectedDate, selectedFromAccount) &&
      validatedAmount > selectedFromAccount.Balance
    ) {
      failField('amount', 'The inputted amount cannot be higher than the current account balance.');
      return false;
    }

    if (
      !isEditMode &&
      !isTransferCategory &&
      selectedTransactionType &&
      !selectedTransactionType.IsIncome &&
      selectedAccount &&
      !isBeforeBalanceAnchor(selectedDate, selectedAccount) &&
      validatedAmount > selectedAccount.Balance
    ) {
      failField(isInvestmentCategory ? 'unitValue' : 'amount', 'The inputted amount cannot be higher than the current account balance.');
      return false;
    }

    const numericExchangeRate = Number(exchangeRate);

    if (isTransferCategory && transferUsesDifferentCurrencies && (!exchangeRate || !Number.isFinite(numericExchangeRate) || numericExchangeRate <= 0)) {
      setPopupMessage({ message: 'Exchange rate must be a positive number.', variant: 'danger' });
      return false;
    }

    if (isTransferCategory && transferUsesDifferentCurrencies && !exchangeRateHasValidPrecision(exchangeRate)) {
      setPopupMessage({ message: EXCHANGE_RATE_PRECISION_ERROR, variant: 'danger' });
      return false;
    }

    // The description field deliberately lets the user type past 255 so that
    // overshooting is visible (it turns red) rather than the input silently
    // dropping keystrokes. Nothing else stops an over-length value, so this is
    // a real check, not a formality.
    if (description.trim().length > 255) {
      setPopupMessage({ message: 'Description cannot exceed 255 characters.', variant: 'danger' });
      return false;
    }

    return true;
  };

  const requestSaveConfirmation = () => {
    if (validateSaveForm()) {
      setPopupMessage(null);
      setConfirmationAction('save');
    }
  };

  const handleSave = async () => {
    const trimmedDescription = description.trim();
    const savedDescription = trimmedDescription || null;
    const amountMinorUnits = parseMoneyInputToMinorUnits(amount, amountCurrency);
    const numericAmount = isInvestmentCategory ? investmentTotalAmount : amountMinorUnits;
    const investmentUnitValueMinorUnits = parseUnitValueInput(investmentUnitValue, amountCurrency);
    const investmentQuantityScaled = parseQuantityInput(investmentQuantity, investmentQuantityDecimals);
    const investmentAdditionalFeesMinorUnits = investmentAdditionalFees
      ? parseMoneyInputToMinorUnits(investmentAdditionalFees, amountCurrency)
      : 0;
    const numericExchangeRate = Number(exchangeRate);

    if (numericAmount === null) {
      setPopupMessage({ message: getMoneyPrecisionError(amountCurrency) || 'Money value is invalid.', variant: 'danger' });
      return;
    }

    setSaving(true);
    setPopupMessage({ message: 'Saving transaction...', title: 'Saving', variant: 'info' });

    let transferToAmount: number | null = null;
    let result;

    if (isTransferCategory) {
      if (!transferFromCategory || !transferIntoCategory || !selectedFromAccountId || !selectedToAccountId || !selectedFromCurrency || !selectedToCurrency) {
        setSaving(false);
        setPopupMessage({ message: 'Transfer form is incomplete.', variant: 'danger' });
        return;
      }

      transferToAmount = transferUsesDifferentCurrencies
        ? getTransferToAmount(
            numericAmount,
            selectedFromCurrency,
            selectedToCurrency,
            numericExchangeRate,
            exchangeRateDirection
          )
        : numericAmount;

      if (transferToAmount <= 0) {
        setSaving(false);
        setPopupMessage({ message: 'Converted transfer amount must be greater than zero.', variant: 'danger' });
        return;
      }

      result = isEditMode && editDetails
        ? await updateTransferTransaction(
            editDetails.Id,
            savedDescription,
            numericAmount,
            transferToAmount,
            selectedFromAccountId,
            selectedToAccountId,
            formatDbDate(selectedDate)
          )
        : await insertTransferTransaction(
            savedDescription,
            transferFromCategory.Id,
            transferIntoCategory.Id,
            numericAmount,
            transferToAmount,
            selectedFromAccountId,
            selectedToAccountId,
            formatDbDate(selectedDate)
          );
    } else if (isInvestmentCategory) {
      if (!selectedCategoryId || !selectedAccountId || !selectedInvestmentId) {
        setSaving(false);
        setPopupMessage({ message: 'Investment form is incomplete.', variant: 'danger' });
        return;
      }

      if (investmentUnitValueMinorUnits === null || investmentAdditionalFeesMinorUnits === null) {
        setSaving(false);
        setPopupMessage({ message: getMoneyPrecisionError(amountCurrency) || 'Money value is invalid.', variant: 'danger' });
        return;
      }

      if (investmentQuantityScaled === null) {
        setSaving(false);
        setPopupMessage({ message: getQuantityPrecisionError(investmentQuantityDecimals), variant: 'danger' });
        return;
      }

      result = isEditMode && editDetails
        ? await updateInvestmentTransaction(
            editDetails.Id,
            savedDescription,
            investmentQuantityScaled,
            investmentUnitValueMinorUnits,
            investmentAdditionalFeesMinorUnits,
            selectedAccountId,
            formatDbDate(selectedDate)
          )
        : await insertInvestmentTransaction(
            savedDescription,
            selectedCategoryId,
            selectedAccountId,
            selectedInvestmentId,
            investmentQuantityScaled,
            investmentUnitValueMinorUnits,
            investmentAdditionalFeesMinorUnits,
            formatDbDate(selectedDate)
          );
    } else {
      if (!selectedCategoryId || !selectedAccountId) {
        setSaving(false);
        setPopupMessage({ message: 'Transaction form is incomplete.', variant: 'danger' });
        return;
      }

      result = isEditMode && editDetails
        ? await updateTransaction(
            editDetails.Id,
            savedDescription,
            selectedCategoryId,
            numericAmount,
            selectedAccountId,
            formatDbDate(selectedDate)
          )
        : await insertTransaction(
            savedDescription,
            selectedCategoryId,
            numericAmount,
            selectedAccountId,
            formatDbDate(selectedDate)
          );
    }

    setSaving(false);

    if (result.Status === 'Success' && isEditMode) {
      // Balances and histories were rebuilt by the database; the previous
      // screen reloads on focus, so just leave.
      router.back();
      return;
    }

    if (result.Status === 'Success') {
      if (isTransferCategory && selectedFromAccountId && selectedToAccountId && transferToAmount) {
        const committedFromAccountId = selectedFromAccountId;
        const committedToAccountId = selectedToAccountId;
        const committedTransferToAmount = transferToAmount;

        setAccounts((currentAccounts) =>
          currentAccounts.map((account) =>
            account.Id === committedFromAccountId
              ? getNextAccountAfterTransaction(account, numericAmount, false, selectedDate)
              : account.Id === committedToAccountId
                ? getNextAccountAfterTransaction(account, committedTransferToAmount, true, selectedDate)
                : account
          )
        );
      } else if (selectedTransactionType) {
        setAccounts((currentAccounts) =>
          currentAccounts.map((account) =>
            account.Id === selectedAccountId
              ? getNextAccountAfterTransaction(account, numericAmount, selectedTransactionType.IsIncome, selectedDate)
              : account
          )
        );

        if (isInvestmentCategory && selectedInvestmentId) {
          const savedQuantity = investmentQuantityScaled ?? 0;
          const nextQuantity = selectedTransactionType.IsIncome
            ? (selectedInvestment?.Quantity ?? 0) - savedQuantity
            : (selectedInvestment?.Quantity ?? 0) + savedQuantity;

          setInvestments((currentInvestments) =>
            currentInvestments.map((investment) =>
              investment.Id === selectedInvestmentId
                ? {
                    ...investment,
                    Quantity: nextQuantity,
                    // Investment.UnitValue is in minor units; investmentUnitValue
                    // is the raw major-unit input string. Number() on it would
                    // store 12.5 where 1250 belongs.
                    UnitValue: investmentUnitValueMinorUnits ?? investment.UnitValue,
                  }
                : investment
            )
          );
        }
      }

      setAmount('');
      setInvestmentQuantity('');
      setInvestmentUnitValue('');
      setInvestmentAdditionalFees('');
      setExchangeRate('');
      setDescription('');
      // The investment stays selected for the next entry, so let the value per
      // unit be suggested again from its now-updated value.
      autoFilledUnitValueRef.current = null;
      setPopupMessage({ message: 'Transaction saved successfully.', title: 'Saved', variant: 'success' });
      return;
    }

    setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Failed to save transaction.', variant: 'danger' });
  };

  const handleClear = () => {
    const today = new Date();

    setSelectedTransactionTypeId(null);
    setSelectedCategoryId(null);
    setSelectedAccountId(null);
    setSelectedFromAccountId(null);
    setSelectedToAccountId(null);
    setSelectedInvestmentId(null);
    setAmount('');
    setInvestmentQuantity('');
    setInvestmentUnitValue('');
    setInvestmentAdditionalFees('');
    setExchangeRate('');
    setExchangeRateDirection('fromTo');
    setSelectedDate(today);
    setDescription('');
    setPopupMessage(null);
    setConfirmationAction(null);
    setFieldError(null);
    autoFilledUnitValueRef.current = null;
  };

  const handleConfirmAction = () => {
    const action = confirmationAction;
    setConfirmationAction(null);

    if (action === 'clear') {
      handleClear();
      return;
    }

    if (action === 'save') {
      handleSave();
    }
  };

  const keepDescriptionCursorVisible = () => {
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });
  };

  const clearButton = (
    <Button
      onPress={() => setConfirmationAction('clear')}
      size="small"
      testID="createTransaction.clear"
      style={{ minWidth: clearButtonWidth, width: clearButtonWidth }}
      variant="danger">
      Clear
    </Button>
  );

  const saveButton = (
    <Button
      disabled={saving}
      onPress={requestSaveConfirmation}
      style={{ width: saveButtonWidth }}
      testID="createTransaction.save"
      variant="primary">
      Save
    </Button>
  );
  const clearButtonPosition = leftHandedMode ? 'right' : 'left';

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={0}
      style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive">
        {/* Order matches Home, Accounts and Investments: the spacer leads and
            the button trails, and headerReversed moves the button to the left
            in left-handed mode instead of away from the thumb. Bulk insert is
            hidden while editing — it only ever creates new rows. */}
        <View style={[styles.header, leftHandedMode && styles.headerReversed]}>
          <View style={styles.headerSpacer} />
          <Text style={styles.title}>{isEditMode ? 'Edit Transaction' : 'Create Transaction'}</Text>
          {isEditMode ? (
            <View style={styles.headerSpacer} />
          ) : (
            <Pressable
              accessibilityLabel="Bulk insert transactions"
              accessibilityRole="button"
              onPress={() => setBulkInsertOpen(true)}
              testID="createTransaction.bulkInsert"
              style={({ pressed }) => [
                styles.iconButton,
                { borderColor: colors.border },
                pressed && styles.pressed,
              ]}>
              <FontAwesome name="upload" size={18} color={colors.text} />
            </Pressable>
          )}
        </View>

        <View style={styles.form}>
          <FieldLabel label="Transaction Type:" />
          <View style={styles.transactionTypeRow}>
            {transactionTypeOptions.map((transactionType) => {
              const isSelected = transactionType.Id === selectedTransactionTypeId;

              return (
                <Button
                  disabled={isEditMode}
                  key={transactionType.Id}
                  onPress={() => selectTransactionType(transactionType.Id)}
                  size="small"
                  testID={transactionType.IsIncome ? 'createTransaction.type.income' : 'createTransaction.type.spending'}
                  style={[styles.transactionTypeButton, isSelected && styles.transactionTypeSelected]}
                  variant={isSelected ? (transactionType.IsIncome ? 'primary' : 'danger') : 'default'}>
                  {transactionType.Name}
                </Button>
              );
            })}
          </View>

          <SelectField
            disabled={isEditMode || !selectedTransactionTypeId}
            label="Category:"
            testID="createTransaction.category"
            onPress={() => openSelection('category')}
            placeholder="Select category"
            value={selectedCategory?.Name}
          />

          {isTransferCategory ? (
            <>
              <SelectField
                helperText={removedAccountNotice(selectedFromAccount)}
                label="From Account:"
                testID="createTransaction.transferFromAccount"
                onPress={() => openSelection('fromAccount')}
                placeholder="Select source account"
                value={selectedFromAccount?.Name}
              />

              <SelectField
                helperText={removedAccountNotice(selectedToAccount)}
                label="To Account:"
                testID="createTransaction.transferToAccount"
                onPress={() => openSelection('toAccount')}
                placeholder="Select destination account"
                value={selectedToAccount?.Name}
              />
            </>
          ) : (
            <>
              <SelectField
                helperText={removedAccountNotice(selectedAccount)}
                label="Account:"
                testID="createTransaction.account"
                onPress={() => openSelection('account')}
                placeholder="Select account"
                value={selectedAccount?.Name}
              />

              {isInvestmentCategory ? (
                <SelectField
                  disabled={isEditMode || !selectedAccountId}
                  label="Investment:"
                  testID="createTransaction.investment"
                  onPress={() => openSelection('investment')}
                  placeholder={selectedAccountId ? 'Select investment' : 'Select account first'}
                  value={selectedInvestment?.Name}
                />
              ) : null}
            </>
          )}

          {isInvestmentCategory ? (
            <>
              <QuantityField
                decimals={investmentQuantityDecimals}
                error={fieldError?.field === 'quantity'}
                errorText={fieldError?.field === 'quantity' ? fieldError.message : undefined}
                label="Quantity:"
                testID="createTransaction.investmentQuantity"
                onChangeText={handleInvestmentQuantityChange}
                placeholder="0"
                value={investmentQuantity}
              />

              <MoneyField
                currency={unitValueCurrency}
                error={fieldError?.field === 'unitValue'}
                errorText={fieldError?.field === 'unitValue' ? fieldError.message : undefined}
                label="Value Per Unit:"
                testID="createTransaction.investmentUnitValue"
                onChangeText={handleInvestmentUnitValueChange}
                value={investmentUnitValue}
              />

              <MoneyField
                currency={amountCurrency}
                error={fieldError?.field === 'additionalFees'}
                errorText={fieldError?.field === 'additionalFees' ? fieldError.message : undefined}
                label="Additional Fees:"
                testID="createTransaction.investmentFees"
                onChangeText={handleInvestmentAdditionalFeesChange}
                value={investmentAdditionalFees}
              />

              <TextField
                editable={false}
                label="Total Amount:"
                testID="createTransaction.investmentTotalAmount"
                value={displayedInvestmentTotalAmount}
              />
            </>
          ) : (
            <MoneyField
              currency={amountCurrency}
              error={fieldError?.field === 'amount'}
              errorText={fieldError?.field === 'amount' ? fieldError.message : undefined}
              label="Amount:"
              testID="createTransaction.amount"
              onChangeText={handleAmountChange}
              value={amount}
            />
          )}

          {isTransferCategory && transferUsesDifferentCurrencies && selectedFromCurrency && selectedToCurrency ? (
            <TextField
              inputMode="decimal"
              keyboardType="decimal-pad"
              error={exchangeRateHasPrecisionError}
              helperText={
                exchangeRateHasPrecisionError ? EXCHANGE_RATE_PRECISION_ERROR : EXCHANGE_RATE_PRECISION_HELPER
              }
              label={`Exchange Rate (${
                exchangeRateDirection === 'fromTo' ? selectedFromCurrency.Code : selectedToCurrency.Code
              } 1 = ${exchangeRateDirection === 'fromTo' ? selectedToCurrency.Code : selectedFromCurrency.Code}):`}
              onBlur={() => setExchangeRateFocused(false)}
              onChangeText={handleExchangeRateChange}
              onFocus={() => setExchangeRateFocused(true)}
              testID="createTransaction.transferExchangeRate"
              placeholder="0"
              prefix={
                <Text style={[styles.exchangeRatePrefix, { color: colors.text }]}>
                  {exchangeRatePrefix}
                </Text>
              }
              suffix={
                <Pressable
                  accessibilityLabel="Swap exchange rate direction"
                  accessibilityRole="button"
                  onPress={toggleExchangeRateDirection}
                  testID="createTransaction.transferExchangeSwap"
                  style={({ pressed }) => [
                    styles.exchangeSwapButton,
                    {
                      borderColor: colors.border,
                    },
                    pressed && styles.pressed,
                  ]}>
                  <FontAwesome name="exchange" size={18} color={colors.text} />
                </Pressable>
              }
              value={displayedExchangeRate}
            />
          ) : null}

          {isTransferCategory && transferUsesDifferentCurrencies && selectedToCurrency ? (
            <TextField
              editable={false}
              helperText={`Rounded to ${selectedToCurrency.Code} precision.`}
              label="To Account Receives:"
              testID="createTransaction.transferToAmount"
              value={displayedTransferToAmount}
            />
          ) : null}

          <View style={styles.field}>
            <FieldLabel label="Date:" />
            <Pressable
              accessibilityRole="button"
              onPress={() => setDatePickerOpen(true)}
              testID="createTransaction.date"
              style={({ pressed }) => [
                styles.dateButton,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                },
                pressed && styles.pressed,
            ]}>
              <Text style={styles.dateText}>{formatDisplayDate(selectedDate)}</Text>
            </Pressable>
          </View>

          <TextAreaField
            label="Description:"
            testID="createTransaction.description"
            maxLength={255}
            onBlur={() => setDescriptionFocused(false)}
            onContentSizeChange={() => {
              if (descriptionFocused) {
                keepDescriptionCursorVisible();
              }
            }}
            onChangeText={setDescription}
            onFocus={() => {
              setDescriptionFocused(true);
              keepDescriptionCursorVisible();
            }}
            showCounter
            softLimit
            value={description}
          />

          <View style={styles.actionArea}>
            <View style={styles.actionRow}>
              <View
                style={[
                  styles.clearActionSlot,
                  clearButtonPosition === 'right' ? { right: actionGap } : { left: actionGap },
                ]}>
                {isEditMode ? null : clearButton}
              </View>
              <View style={styles.actionCenter}>{saveButton}</View>
            </View>
          </View>
        </View>
      </ScrollView>

      <BulkInsertModal
        onClose={() => setBulkInsertOpen(false)}
        // Imported rows change account balances, which the amount check on
        // this form reads from the accounts it already loaded.
        onImported={() => { void loadFormData(); }}
        onResult={(message, variant, title, detail) => setPopupMessage({ detail, message, title, variant })}
        visible={bulkInsertOpen}
      />

      {/* Screen level and outside the ScrollView, the same way Home shows its
          export result. Both used to sit inside the form over the Save button,
          so anything that grew the form above it (e.g. a field error wrapping
          to more lines) pushed them below the fold, behind the bottom nav.
          One slot: a confirmation takes priority over a message, so the two
          never stack. Bulk insert only reports its successes here — failures
          are shown inside the modal, which would otherwise cover them. */}
      {confirmationAction ? (
        <ConfirmationPopup
          confirmLabel={confirmationAction === 'clear' ? 'Clear' : 'Save'}
          confirmVariant={confirmationAction === 'clear' ? 'danger' : 'primary'}
          message={
            confirmationAction === 'clear'
              ? 'Clear all fields? This cannot be undone.'
              : isEditMode && editDetails?.Kind === 'transfer'
                ? 'Save changes to this transfer? Both halves will be updated.'
                : isEditMode
                  ? 'Save changes to this transaction?'
                  : 'Save this transaction?'
          }
          onCancel={() => setConfirmationAction(null)}
          onConfirm={handleConfirmAction}
          style={styles.screenPopup}
          title={confirmationAction === 'clear' ? 'Confirm Clear' : 'Confirm Save'}
          variant={confirmationAction === 'clear' ? 'warning' : 'info'}
        />
      ) : popupMessage ? (
        <Popup
          detail={popupMessage.detail}
          message={popupMessage.message}
          onClose={() => setPopupMessage(null)}
          style={styles.screenPopup}
          title={popupMessage.title}
          variant={popupMessage.variant}
        />
      ) : null}

      {/* Future days are disabled (CalendarPickerModal's default). Balances
          replay every transaction whatever its date while every history view
          stops at today, so a future-dated row would move the balance and
          then hide itself. */}
      <CalendarPickerModal
        onClose={() => setDatePickerOpen(false)}
        onSelect={setSelectedDate}
        value={selectedDate}
        visible={datePickerOpen}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  actionArea: {
    marginHorizontal: -actionAreaHorizontalOffset,
    position: 'relative',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
    paddingBottom: 30,
    position: 'relative',
  },
  actionCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearActionSlot: {
    alignItems: 'center',
    bottom: 30,
    justifyContent: 'center',
    position: 'absolute',
    top: 0,
  },
  container: {
    flexGrow: 1,
  },
  dateButton: {
    borderRadius: 5,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  dateText: {
    fontSize: 18,
  },
  exchangeSwapButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderLeftWidth: 1,
    justifyContent: 'center',
    width: 54,
  },
  exchangeRatePrefix: {
    fontSize: 18,
    paddingLeft: 12,
  },
  field: {
    marginBottom: 15,
  },
  form: {
    paddingHorizontal: 15,
    paddingTop: 21,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    // Matches the form's horizontal padding below it, so the button lines up
    // with the fields instead of sitting against the screen edge.
    paddingHorizontal: 15,
    width: '100%',
  },
  headerReversed: {
    flexDirection: 'row-reverse',
  },
  headerSpacer: {
    width: 42,
  },
  iconButton: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  transactionTypeButton: {
    flex: 1,
  },
  transactionTypeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  transactionTypeSelected: {
    borderWidth: 2,
  },
  pressed: {
    opacity: 0.65,
  },
  screen: {
    flex: 1,
  },
  // Mirrors Home's popup placement so results and errors read the same way
  // there and here.
  screenPopup: {
    bottom: 16,
    left: 15,
    position: 'absolute',
    right: 15,
  },
  title: {
    fontSize: 30,
    fontWeight: '400',
    textAlign: 'center',
  },
});
