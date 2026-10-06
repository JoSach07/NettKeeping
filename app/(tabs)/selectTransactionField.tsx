import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import ConfirmationPopup from '@/components/themed/ConfirmationPopup';
import PickerModal from '@/components/themed/PickerModal';
import { SelectField, TextField } from '@/components/themed/fields';
import { Text } from '@/components/Themed';
import { useAppTheme } from '@/hooks/useAppTheme';
import { getAccounts } from '@/database/tables/accounts';
import { getCategories, getCategoryNameConflict, insertCategory, INVESTMENT_CATEGORY_ID } from '@/database/tables/categories';
import { categoryColorOptions } from '@/constants/Palette';
import { getInvestmentCategories, InvestmentCategory } from '@/database/tables/investmentCategories';
import { getInvestments, insertInvestment } from '@/database/tables/investments';
import { formatQuantityDecimalsLabel, QUANTITY_DECIMAL_OPTIONS } from '@/utils/investmentNumbers';
import { formatDbDate } from '@/utils/dbDate';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type SelectFieldName = 'category' | 'account' | 'fromAccount' | 'toAccount' | 'investment';

type SelectionParams = {
  accountId?: string;
  additionalFees?: string;
  amount?: string;
  categoryId?: string;
  date?: string;
  description?: string;
  editTransactionId?: string;
  field?: SelectFieldName;
  exchangeRate?: string;
  exchangeRateDirection?: string;
  fromAccountId?: string;
  investmentId?: string;
  // Set by selectInvestmentCategory when returning a picked category for the
  // new-investment popup. Consumed (and cleared) here; never forwarded to
  // createTransaction.
  investmentCategoryId?: string;
  transactionTypeId?: string;
  quantity?: string;
  // '1' when returning from selectInvestmentCategory: reopen the popup.
  reopenCreateInvestment?: string;
  toAccountId?: string;
  unitValue?: string;
};

type SelectionOption = {
  id: number;
  label: string;
};

const fieldTitles: Record<SelectFieldName, string> = {
  account: 'Account',
  category: 'Category',
  fromAccount: 'From Account',
  investment: 'Investment',
  toAccount: 'To Account',
};

// Four swatches per row, whatever the screen size or orientation. The row is
// measured instead of using percentage widths so the squares stay square: the
// palette must remain a multiple of four for the last row to align under
// justifyContent: 'space-between'.
const swatchesPerRow = 4;
const swatchGap = 12;

const getSwatchSize = (rowWidth: number) =>
  Math.floor((rowWidth - swatchGap * (swatchesPerRow - 1)) / swatchesPerRow);

const parseParamNumber = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

const parseParamString = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

const parseField = (value: string | string[] | undefined): SelectFieldName => {
  const rawValue = parseParamString(value);
  return rawValue === 'category' ||
    rawValue === 'account' ||
    rawValue === 'fromAccount' ||
    rawValue === 'investment' ||
    rawValue === 'toAccount'
    ? rawValue
    : 'category';
};

export default function SelectTransactionFieldScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<SelectionParams>();
  const { colors } = useAppTheme();
  const field = parseField(params.field);
  const selectedTransactionTypeId = parseParamNumber(params.transactionTypeId);
  const selectedAccountId = parseParamNumber(params.accountId);
  const selectedId =
    field === 'category'
      ? parseParamNumber(params.categoryId)
      : field === 'fromAccount'
        ? parseParamNumber(params.fromAccountId)
        : field === 'toAccount'
          ? parseParamNumber(params.toAccountId)
          : field === 'investment'
            ? parseParamNumber(params.investmentId)
            : selectedAccountId;
  // Creating an investment only makes sense when buying into one. A fresh
  // investment holds nothing, so offering it under Investment Liquidation would
  // only ever lead to a rejected save.
  const canCreateInvestment =
    field === 'investment' && parseParamNumber(params.categoryId) === INVESTMENT_CATEGORY_ID;
  // A new category is filed under the transaction type currently being picked for,
  // so there has to be one selected.
  const canCreateCategory = field === 'category' && selectedTransactionTypeId !== null;
  const [options, setOptions] = useState<SelectionOption[]>([]);
  const [message, setMessage] = useErrorState();
  const [query, setQuery] = useState('');
  const [createInvestmentOpen, setCreateInvestmentOpen] = useState(false);
  const [newInvestmentName, setNewInvestmentName] = useState('');
  const [newInvestmentCategoryId, setNewInvestmentCategoryId] = useState<number | null>(null);
  // Chosen here because an investment's decimals lock once its first transaction
  // exists — which, for one created inline, is the transaction about to be saved.
  const [newInvestmentQuantityDecimals, setNewInvestmentQuantityDecimals] = useState(0);
  const [quantityDecimalsPickerOpen, setQuantityDecimalsPickerOpen] = useState(false);
  const [investmentCategories, setInvestmentCategories] = useState<InvestmentCategory[]>([]);
  const [createInvestmentError, setCreateInvestmentError] = useErrorState();
  const [savingInvestment, setSavingInvestment] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState(categoryColorOptions[0]);
  const [createCategoryError, setCreateCategoryError] = useErrorState();
  // Name of the removed category colliding with what is being created. Only
  // informational — the user is always allowed to proceed.
  const [removedCategoryNameWarning, setRemovedCategoryNameWarning] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [swatchRowWidth, setSwatchRowWidth] = useState(0);
  const swatchSize = swatchRowWidth > 0 ? getSwatchSize(swatchRowWidth) : 0;
  // True while the category picker page is pushed on top of this screen; the
  // popup is temporarily closed (its state survives, this screen stays
  // mounted) and reopened on focus/return.
  const categoryPickerActiveRef = useRef(false);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }

    return options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));
  }, [options, query]);

  const loadOptions = useCallback(async () => {
    setMessage('');

    if (field === 'category') {
      if (!selectedTransactionTypeId) {
        setOptions([]);
        setMessage('Choose a transaction type before choosing a category.');
        return;
      }

      const result = await getCategories();
      if (result.Status === 'Success') {
        setOptions(
          result.Data
            .filter((item) => item.IsActive && item.TransactionTypeId === selectedTransactionTypeId)
            .map((item) => ({ id: item.Id, label: item.Name }))
        );
      } else {
        setMessage(result.Message ?? 'Unable to load categories.', result.Detail);
      }
      return;
    }

    if (field === 'investment') {
      if (!selectedAccountId) {
        setOptions([]);
        return;
      }

      const [investmentResult, accountResult] = await Promise.all([getInvestments(), getAccounts()]);
      if (investmentResult.Status === 'Success' && accountResult.Status === 'Success') {
        const selectedAccount = accountResult.Data.find((account) => account.Id === selectedAccountId);

        setOptions(
          investmentResult.Data
            .filter((item) => selectedAccount && item.CurrencyId === selectedAccount.CurrencyId)
            .map((item) => ({ id: item.Id, label: item.Name }))
        );
      } else {
        setMessage(investmentResult.Message ?? accountResult.Message ?? 'Unable to load investments.', investmentResult.Detail ?? accountResult.Detail);
      }
      return;
    }

    const result = await getAccounts();
    if (result.Status === 'Success') {
      setOptions(result.Data.filter((item) => item.IsActive).map((item) => ({ id: item.Id, label: item.Name })));
    } else {
      setMessage(result.Message ?? 'Unable to load accounts.', result.Detail);
    }
  }, [field, selectedAccountId, selectedTransactionTypeId]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const loadInvestmentCategories = useCallback(async () => {
    const result = await getInvestmentCategories();
    if (result.Status === 'Success') {
      setInvestmentCategories(result.Data);
    }
  }, []);

  // Only the create-investment popup needs these, so skip the query when that
  // popup cannot be opened.
  useEffect(() => {
    if (!canCreateInvestment) {
      return;
    }

    loadInvestmentCategories();
  }, [canCreateInvestment, loadInvestmentCategories]);

  // Returning from selectInvestmentCategory with a selection: apply it and
  // reopen the new-investment popup. The typed name survives because this
  // screen stays mounted underneath the picker.
  const reopenCreateInvestment = parseParamString(params.reopenCreateInvestment) === '1';
  useEffect(() => {
    if (!reopenCreateInvestment) {
      return;
    }

    const pickedCategoryId = parseParamNumber(params.investmentCategoryId);
    if (pickedCategoryId) {
      setNewInvestmentCategoryId(pickedCategoryId);
      // The picker can create a category, and the field shows the name by
      // looking the id up in this list — without a refetch a just-created
      // category resolves to nothing and the field looks empty.
      loadInvestmentCategories();
    }

    categoryPickerActiveRef.current = false;
    setCreateInvestmentOpen(true);
    router.setParams({ investmentCategoryId: '', reopenCreateInvestment: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenCreateInvestment]);

  // Returning without a selection (back button): just reopen the popup.
  useFocusEffect(
    useCallback(() => {
      if (categoryPickerActiveRef.current) {
        categoryPickerActiveRef.current = false;
        setCreateInvestmentOpen(true);
      }
    }, [])
  );

  const openCategoryPicker = () => {
    categoryPickerActiveRef.current = true;
    setCreateInvestmentOpen(false);
    router.push({
      pathname: '/selectInvestmentCategory',
      params: {
        ...getNextParams(),
        investmentCategoryId: newInvestmentCategoryId?.toString() ?? '',
        returnTo: 'selectTransactionField',
      },
    });
  };

  const getNextParams = () => ({
      accountId: parseParamString(params.accountId),
      additionalFees: parseParamString(params.additionalFees),
      amount: parseParamString(params.amount),
      categoryId: parseParamString(params.categoryId),
      date: parseParamString(params.date),
      description: parseParamString(params.description),
      editTransactionId: parseParamString(params.editTransactionId),
      exchangeRate: parseParamString(params.exchangeRate),
      exchangeRateDirection: parseParamString(params.exchangeRateDirection),
      fromAccountId: parseParamString(params.fromAccountId),
      investmentId: parseParamString(params.investmentId),
      transactionTypeId: parseParamString(params.transactionTypeId),
      quantity: parseParamString(params.quantity),
      // Makes every return look new to createTransaction's params effect, so
      // re-picking the same value as last time still applies (bug #14).
      selectionNonce: Date.now().toString(),
      toAccountId: parseParamString(params.toAccountId),
      unitValue: parseParamString(params.unitValue),
    });

  const closeCreateCategory = () => {
    if (savingCategory) {
      return;
    }

    setCreateCategoryOpen(false);
    setNewCategoryName('');
    setNewCategoryColor(categoryColorOptions[0]);
    setCreateCategoryError('');
    setRemovedCategoryNameWarning('');
  };

  const saveNewCategory = async () => {
    const trimmedName = newCategoryName.trim();
    setRemovedCategoryNameWarning('');

    if (!trimmedName) {
      setCreateCategoryError('Category name is required.');
      return;
    }

    if (!selectedTransactionTypeId) {
      setCreateCategoryError('Choose a transaction type before creating a category.');
      return;
    }

    setCreateCategoryError('');
    setSavingCategory(true);
    const conflictResult = await getCategoryNameConflict(trimmedName, selectedTransactionTypeId);
    setSavingCategory(false);

    if (conflictResult.Status !== 'Success') {
      setCreateCategoryError(conflictResult.Message ?? 'Failed to check for a duplicate category name.', conflictResult.Detail);
      return;
    }

    const conflictingCategory = conflictResult.ConflictingCategory;

    if (conflictingCategory?.IsActive) {
      setCreateCategoryError(`A category named "${conflictingCategory.Name}" already exists.`);
      return;
    }

    // The loaded options only cover active categories, so a name held by a
    // removed one used to slip through silently. Warn instead of blocking.
    if (conflictingCategory) {
      setRemovedCategoryNameWarning(conflictingCategory.Name);
      return;
    }

    await commitNewCategory();
  };

  const commitNewCategory = async () => {
    const trimmedName = newCategoryName.trim();

    if (!selectedTransactionTypeId) {
      return;
    }

    setRemovedCategoryNameWarning('');
    setCreateCategoryError('');
    setSavingCategory(true);
    const result = await insertCategory(trimmedName, newCategoryColor, selectedTransactionTypeId);
    setSavingCategory(false);

    if (result.Status === 'Success' && result.DataId) {
      const nextParams = getNextParams();
      nextParams.categoryId = result.DataId.toString();

      setCreateCategoryOpen(false);
      setNewCategoryName('');
      setNewCategoryColor(categoryColorOptions[0]);
      setCreateCategoryError('');
      router.dismissTo({
        pathname: '/createTransaction',
        params: nextParams,
      });
      return;
    }

    setCreateCategoryError(result.Message ?? 'Failed to create category.', result.Detail);
  };

  const closeCreateInvestment = () => {
    if (savingInvestment) {
      return;
    }

    setCreateInvestmentOpen(false);
    setNewInvestmentName('');
    setNewInvestmentCategoryId(null);
    setNewInvestmentQuantityDecimals(0);
    setCreateInvestmentError('');
  };

  const chooseOption = (option: SelectionOption) => {
    const nextParams = getNextParams();

    if (field === 'category') {
      nextParams.categoryId = option.id.toString();
    } else if (field === 'fromAccount') {
      nextParams.fromAccountId = option.id.toString();
    } else if (field === 'toAccount') {
      nextParams.toAccountId = option.id.toString();
    } else if (field === 'investment') {
      nextParams.investmentId = option.id.toString();
    } else {
      nextParams.accountId = option.id.toString();
    }

    router.dismissTo({
      pathname: '/createTransaction',
      params: nextParams,
    });
  };

  const saveNewInvestment = async () => {
    const trimmedName = newInvestmentName.trim();

    if (!trimmedName) {
      setCreateInvestmentError('Investment name is required.');
      return;
    }

    setCreateInvestmentError('');
    setSavingInvestment(true);
    const selectedAccountId = parseParamNumber(params.accountId);
    const accountResult = await getAccounts();

    if (accountResult.Status !== 'Success') {
      setSavingInvestment(false);
      setCreateInvestmentError(accountResult.Message ?? 'Failed to load accounts.', accountResult.Detail);
      return;
    }

    const selectedAccount = accountResult.Data.find((account) => account.Id === selectedAccountId);
    if (!selectedAccount) {
      setSavingInvestment(false);
      setCreateInvestmentError('Choose an account before creating an investment.');
      return;
    }

    const result = await insertInvestment(
      trimmedName,
      selectedAccount.CurrencyId,
      0,
      0,
      formatDbDate(new Date()),
      newInvestmentCategoryId,
      null,
      newInvestmentQuantityDecimals
    );
    setSavingInvestment(false);

    if (result.Status === 'Success' && result.DataId) {
      const nextParams = getNextParams();
      nextParams.investmentId = result.DataId.toString();

      setCreateInvestmentOpen(false);
      setNewInvestmentName('');
      setNewInvestmentCategoryId(null);
      setNewInvestmentQuantityDecimals(0);
      setCreateInvestmentError('');
      router.dismissTo({
        pathname: '/createTransaction',
        params: nextParams,
      });
      return;
    }

    setCreateInvestmentError(result.Message ?? 'Failed to create investment.', result.Detail);
  };

  return (
    // Screen-level on purpose: only the search field and the list live here.
    // The modals below are separate native windows that Android resizes for
    // the keyboard itself. 'padding' on both platforms, like every other
    // KeyboardAvoidingView in the app — see the note in AppLockGate.
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton} testID="selectTransactionField.back">
          <FontAwesome name="angle-left" size={28} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{fieldTitles[field]}</Text>
        <View style={styles.backButton} />
      </View>

      <TextField
        autoCapitalize="none"
        autoCorrect={false}
        containerStyle={styles.searchField}
        label="Search:"
        onChangeText={setQuery}
        placeholder={`Search ${fieldTitles[field].toLowerCase()}`}
        prefix={<FontAwesome name="search" size={16} color={colors.textMuted} style={styles.searchIcon} />}
        testID="selectTransactionField.search"
        value={query}
      />

      {field === 'investment' ? (
        <Text style={[styles.disclaimer, { color: colors.textMuted }]}>
          Only investments with the same currency as the selected account can be selected.
        </Text>
      ) : null}

      {message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}

      <FlatList
        contentContainerStyle={styles.list}
        data={filteredOptions}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id.toString()}
        ListHeaderComponent={
          canCreateInvestment ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCreateInvestmentError('');
                setCreateInvestmentOpen(true);
              }}
              testID="selectTransactionField.newInvestment"
              style={({ pressed }) => [
                styles.createRow,
                { borderColor: colors.border },
                pressed && styles.pressed,
              ]}>
              <Text style={styles.createText}>New Investment</Text>
            </Pressable>
          ) : canCreateCategory ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCreateCategoryError('');
                setCreateCategoryOpen(true);
              }}
              testID="selectTransactionField.newCategory"
              style={({ pressed }) => [
                styles.createRow,
                { borderColor: colors.border },
                pressed && styles.pressed,
              ]}>
              <Text style={styles.createText}>New Category</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={!message.message ? <Text style={[styles.message, { color: colors.textMuted }]}>No results found.</Text> : null}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: item.id === selectedId }}
            onPress={() => chooseOption(item)}
            testID={`selectTransactionField.option.${item.label}`}
            style={({ pressed }) => [
              styles.optionRow,
              { borderColor: colors.border },
              pressed && styles.pressed,
            ]}>
            <Text style={styles.optionText}>{item.label}</Text>
            {item.id === selectedId ? <FontAwesome name="check" size={16} color={colors.tint} /> : null}
          </Pressable>
        )}
      />

      <Modal animationType="fade" transparent visible={createCategoryOpen} onRequestClose={closeCreateCategory}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeCreateCategory} />
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>Create Category</Text>
              <TextInput
                autoCapitalize="words"
                onChangeText={setNewCategoryName}
                placeholder="Name"
                placeholderTextColor={colors.textMuted}
                style={[styles.modalInput, { borderColor: colors.border, color: colors.text }]}
                testID="selectTransactionField.newCategory.name"
                value={newCategoryName}
              />
              <Text style={[styles.modalFieldLabel, { color: colors.textMuted }]}>Color:</Text>
              <View
                onLayout={(event) => setSwatchRowWidth(event.nativeEvent.layout.width)}
                style={styles.swatchRow}>
                {swatchSize > 0
                  ? categoryColorOptions.map((color) => (
                      <Pressable
                        accessibilityLabel={`Use color ${color}`}
                        accessibilityRole="button"
                        accessibilityState={{ selected: color === newCategoryColor }}
                        key={color}
                        onPress={() => setNewCategoryColor(color)}
                        testID={`selectTransactionField.newCategory.color.${color.replace('#', '')}`}
                        style={({ pressed }) => [
                          styles.swatch,
                          {
                            backgroundColor: color,
                            borderColor: color === newCategoryColor ? colors.text : 'transparent',
                            borderRadius: swatchSize / 2,
                            height: swatchSize,
                            width: swatchSize,
                          },
                          pressed && styles.pressed,
                        ]}
                      />
                    ))
                  : null}
              </View>
              <Text style={[styles.modalHint, { color: colors.textMuted }]}>
                You can fine-tune the color later from Manage Categories.
              </Text>
              {createCategoryError.message ? (
                <ErrorText
                  align="left"
                  color={colors.dangerText}
                  detail={createCategoryError.detail}
                  message={createCategoryError.message}
                  textStyle={styles.modalError}
                />
              ) : null}
              {removedCategoryNameWarning ? (
                <ConfirmationPopup
                  actionsLayout="spread"
                  confirmLabel="Save anyway"
                  confirmVariant="success"
                  message={`You previously had a category named "${removedCategoryNameWarning}" that was removed. Transactions kept on it still show that name.`}
                  onCancel={() => setRemovedCategoryNameWarning('')}
                  onConfirm={commitNewCategory}
                  style={styles.modalPopup}
                  title="Name used before"
                  variant="warning"
                />
              ) : null}
              <View style={styles.modalActions}>
                <Button disabled={savingCategory} onPress={closeCreateCategory} size="small" testID="selectTransactionField.newCategory.cancel">
                  Cancel
                </Button>
                <Button disabled={savingCategory} onPress={saveNewCategory} size="small" testID="selectTransactionField.newCategory.save" variant="primary">
                  {savingCategory ? 'Saving...' : 'Save'}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <Modal animationType="fade" transparent visible={createInvestmentOpen} onRequestClose={closeCreateInvestment}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeCreateInvestment} />
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>Create Investment</Text>
              <TextInput
                autoCapitalize="words"
                onChangeText={setNewInvestmentName}
                placeholder="Name"
                placeholderTextColor={colors.textMuted}
                style={[styles.modalInput, { borderColor: colors.border, color: colors.text }]}
                testID="selectTransactionField.newInvestment.name"
                value={newInvestmentName}
              />
              <SelectField
                containerStyle={styles.modalCategoryField}
                label="Category:"
                onPress={openCategoryPicker}
                placeholder="Select category (defaults to General)"
                testID="selectTransactionField.newInvestment.category"
                value={investmentCategories.find((category) => category.Id === newInvestmentCategoryId)?.Name ?? ''}
              />
              <SelectField
                containerStyle={styles.modalCategoryField}
                label="Quantity Decimals:"
                onPress={() => setQuantityDecimalsPickerOpen(true)}
                placeholder="0"
                testID="selectTransactionField.newInvestment.decimals"
                value={formatQuantityDecimalsLabel(newInvestmentQuantityDecimals)}
              />
              {createInvestmentError.message ? (
                <ErrorText
                  align="left"
                  color={colors.dangerText}
                  detail={createInvestmentError.detail}
                  message={createInvestmentError.message}
                  textStyle={styles.modalError}
                />
              ) : null}
              <View style={styles.modalActions}>
                <Button disabled={savingInvestment} onPress={closeCreateInvestment} size="small" testID="selectTransactionField.newInvestment.cancel">
                  Cancel
                </Button>
                <Button disabled={savingInvestment} onPress={saveNewInvestment} size="small" testID="selectTransactionField.newInvestment.save" variant="primary">
                  {savingInvestment ? 'Saving...' : 'Save'}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <PickerModal
        items={QUANTITY_DECIMAL_OPTIONS.map((decimals) => ({ id: decimals, label: formatQuantityDecimalsLabel(decimals) }))}
        onClose={() => setQuantityDecimalsPickerOpen(false)}
        onSelect={(item) => {
          setNewInvestmentQuantityDecimals(Number(item.id));
          setQuantityDecimalsPickerOpen(false);
        }}
        selectedId={newInvestmentQuantityDecimals}
        title="Quantity Decimals"
        visible={quantityDecimalsPickerOpen}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  container: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
  },
  disclaimer: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 15,
    paddingTop: 10,
    textAlign: 'center',
  },
  list: {
    paddingBottom: 24,
    paddingHorizontal: 15,
  },
  createRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 52,
  },
  createText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  message: {
    fontSize: 13,
    paddingHorizontal: 15,
    paddingTop: 14,
    textAlign: 'center',
  },
  optionRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  modalCategoryField: {
    marginTop: 12,
  },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  modalBackdropPressable: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  modalInput: {
    borderRadius: 5,
    borderWidth: 1,
    fontSize: 18,
    height: 54,
    paddingHorizontal: 12,
  },
  modalError: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  modalPopup: {
    marginTop: 10,
  },
  modalFieldLabel: {
    fontSize: 14,
    marginTop: 14,
  },
  modalHint: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  // Size is measured at runtime rather than declared: a percentage width with
  // aspectRatio collapsed to nothing but the border, and a fixed pixel size
  // wrapped to 7 + 1 on narrower screens. See swatchGap / the onLayout handler.
  swatch: {
    borderWidth: 2,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 10,
    rowGap: swatchGap,
  },
  modalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 360,
    padding: 16,
    width: '90%',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
  optionText: {
    flex: 1,
    fontSize: 15,
  },
  pressed: {
    opacity: 0.65,
  },
  searchField: {
    marginHorizontal: 15,
    marginTop: 14,
  },
  searchIcon: {
    marginLeft: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '400',
  },
});
