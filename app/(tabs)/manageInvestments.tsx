import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import PickerModal from '@/components/themed/PickerModal';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { MoneyField, QuantityField, SelectField, TextField } from '@/components/themed/fields';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { getInvestmentCategories, InvestmentCategory } from '@/database/tables/investmentCategories';
import {
  deleteInvestment,
  getInvestmentHistoryEntryCount,
  getInvestments,
  insertInvestment,
  Investment,
  updateInvestment,
} from '@/database/tables/investments';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useKeepFocusedInputVisible } from '@/hooks/useKeepFocusedInputVisible';
import {
  formatQuantity,
  formatQuantityDecimalsLabel as getQuantityDecimalsLabel,
  formatQuantityToInput,
  formatUnitValueToInput,
  getQuantityPrecisionError,
  getUnitValueCurrency,
  parseQuantityInput,
  parseUnitValueInput,
  QUANTITY_DECIMAL_OPTIONS,
  quantityInputHasValidPrecision,
} from '@/utils/investmentNumbers';
import { getMoneyPrecisionError, moneyInputHasValidPrecision } from '@/utils/moneyInput';
import { formatDbDate } from '@/utils/dbDate';
import { useErrorState } from '@/hooks/useErrorState';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type PopupMessage = {
  detail?: string;
  message: string;
  title?: string;
  variant: 'danger' | 'success' | 'warning';
};

const getCurrencyLabel = (currency?: Currency) => (currency ? `${currency.Code} - ${currency.Name}` : '');

// Drops fraction digits beyond the new decimals, so switching 3 -> 1 decimals
// turns "1.234" into "1.2" instead of leaving an invalid value in the field.
const clampQuantityInput = (value: string, decimals: number) => {
  const [whole, fraction] = value.split('.');
  if (fraction === undefined) {
    return value;
  }
  return decimals === 0 ? whole : `${whole}.${fraction.slice(0, decimals)}`;
};

const parseParamNumber = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

export default function ManageInvestmentsScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  // Scrolls the focused field back into view when the keyboard shrinks the form.
  const investmentFormScroll = useKeepFocusedInputVisible();
  const router = useRouter();
  const params = useLocalSearchParams<{ investmentCategoryId?: string }>();
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [investmentCategories, setInvestmentCategories] = useState<InvestmentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [editingInvestment, setEditingInvestment] = useState<Investment | null>(null);
  const [editLocked, setEditLocked] = useState(false);
  const [deletingInvestment, setDeletingInvestment] = useState<Investment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState('');
  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [investmentCategoryId, setInvestmentCategoryId] = useState<number | null>(null);
  // True while the category picker page is open; the form modal is temporarily
  // closed so the pushed page is visible, and reopened on focus/return.
  const categoryPickerActiveRef = useRef(false);
  const [quantity, setQuantity] = useState('');
  const [quantityDecimals, setQuantityDecimals] = useState(0);
  const [quantityDecimalsPickerOpen, setQuantityDecimalsPickerOpen] = useState(false);
  const [unit, setUnit] = useState('');
  const [unitValue, setUnitValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [unitValueFieldError, setUnitValueFieldError] = useState(false);
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);
  // Errors raised while the form modal is open must render inside it: the
  // screen-level popup sits behind an open RN Modal and can't be seen.
  const [investmentFormError, setInvestmentFormError] = useErrorState();

  const loadData = useCallback(async () => {
    setLoading(true);

    const [investmentResult, currencyResult, categoryResult] = await Promise.all([
      getInvestments(),
      getCurrencies(),
      getInvestmentCategories(),
    ]);
    const messages: ErrorMessage[] = [];

    setLoading(false);

    if (investmentResult.Status === 'Success') {
      setInvestments(investmentResult.Data);
    } else {
      messages.push(toErrorMessage(investmentResult, 'Failed to load investments.'));
    }

    if (categoryResult.Status === 'Success') {
      setInvestmentCategories(categoryResult.Data);
    } else {
      messages.push(toErrorMessage(categoryResult, 'Failed to load investment categories.'));
    }

    if (currencyResult.Status === 'Success') {
      const activeCurrencies = currencyResult.Data.filter((currency) => currency.IsActive);
      setCurrencies(activeCurrencies);
      setCurrencyId((current) => current ?? activeCurrencies[0]?.Id ?? null);
    } else {
      messages.push(toErrorMessage(currencyResult, 'Failed to load currencies.'));
    }

    if (messages.length > 0) {
      setPopupMessage({ ...joinErrorMessages(messages), variant: 'danger' });
    }
  }, []);

  const loadInvestmentCategories = useCallback(async () => {
    const result = await getInvestmentCategories();
    if (result.Status === 'Success') {
      setInvestmentCategories(result.Data);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Returning from the category picker with a selection: apply it and reopen
  // the form. The screen stays mounted while the picker is pushed, so all
  // other form state survives untouched.
  const pickedCategoryId = parseParamNumber(params.investmentCategoryId);
  useEffect(() => {
    if (!pickedCategoryId) {
      return;
    }

    categoryPickerActiveRef.current = false;
    setInvestmentCategoryId(pickedCategoryId);
    setFormOpen(true);
    // The picker can create a category, and the form shows the name by looking
    // the id up in this list — without a refetch a just-created category
    // resolves to nothing and the field looks empty.
    loadInvestmentCategories();
    router.setParams({ investmentCategoryId: '' });
  }, [loadInvestmentCategories, pickedCategoryId, router]);

  // Returning without a selection (back button): just reopen the form.
  useFocusEffect(
    useCallback(() => {
      if (categoryPickerActiveRef.current) {
        categoryPickerActiveRef.current = false;
        setFormOpen(true);
      }
    }, [])
  );

  const openCategoryPicker = () => {
    categoryPickerActiveRef.current = true;
    setFormOpen(false);
    router.push({
      pathname: '/selectInvestmentCategory',
      params: {
        investmentCategoryId: investmentCategoryId?.toString() ?? '',
        returnTo: 'manageInvestments',
      },
    });
  };

  const closeForm = () => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingInvestment(null);
    setEditLocked(false);
    setName('');
    setInvestmentCategoryId(null);
    setCurrencyId(currencies[0]?.Id ?? null);
    setQuantity('');
    setQuantityDecimals(0);
    setUnit('');
    setUnitValue('');
    setUnitValueFieldError(false);
    setInvestmentFormError('');
  };

  // The Investments screen holds the charts and history this used to summarise
  // in a popup, so viewing means going there. dismissTo pops back to the
  // existing Investments screen rather than stacking a second copy; if this
  // screen was somehow reached without it below, push instead.
  const viewInvestment = (investment: Investment) => {
    const target = {
      params: { investmentId: investment.Id.toString() },
      pathname: '/investments' as const,
    };

    if (router.canDismiss()) {
      router.dismissTo(target);
      return;
    }

    router.push(target);
  };

  const openEdit = async (investment: Investment) => {
    const countResult = await getInvestmentHistoryEntryCount(investment.Id);
    if (countResult.Status !== 'Success') {
      setPopupMessage({ detail: countResult.Detail, message: countResult.Message ?? 'Failed to load investment details.', variant: 'danger' });
      return;
    }

    const currency = currencies.find((item) => item.Id === investment.CurrencyId);
    setEditingInvestment(investment);
    setEditLocked(countResult.Count > 0);
    setName(investment.Name);
    setInvestmentCategoryId(investment.InvestmentCategoryId);
    setCurrencyId(investment.CurrencyId);
    setQuantityDecimals(investment.QuantityDecimals ?? 0);
    setQuantity(formatQuantityToInput(investment.Quantity, investment.QuantityDecimals ?? 0));
    setUnit(investment.Unit ?? '');
    setUnitValue(formatUnitValueToInput(investment.UnitValue, currency));
    setUnitValueFieldError(false);
    setFormOpen(true);
  };

  const saveInvestment = async () => {
    const trimmedName = name.trim();
    const numericQuantity = parseQuantityInput(quantity || '0', quantityDecimals);
    const selectedCurrency = currencies.find((currency) => currency.Id === currencyId);
    const unitValueCurrency = getUnitValueCurrency(selectedCurrency);
    const numericUnitValue = parseUnitValueInput(unitValue || '0', selectedCurrency);
    setUnitValueFieldError(false);

    if (!trimmedName) {
      setInvestmentFormError('Name is required.');
      return;
    }

    if (!currencyId) {
      setInvestmentFormError('Currency is required.');
      return;
    }

    if (!quantityInputHasValidPrecision(quantity, quantityDecimals)) {
      setInvestmentFormError(getQuantityPrecisionError(quantityDecimals));
      return;
    }

    if (numericQuantity === null || numericQuantity < 0) {
      setInvestmentFormError('Quantity must be zero or higher.');
      return;
    }

    if (!moneyInputHasValidPrecision(unitValue, unitValueCurrency)) {
      setUnitValueFieldError(true);
      setInvestmentFormError(getMoneyPrecisionError(unitValueCurrency));
      return;
    }

    if (numericUnitValue === null || numericUnitValue < 0) {
      setUnitValueFieldError(true);
      setInvestmentFormError('Value per unit must be zero or higher.');
      return;
    }

    setInvestmentFormError('');
    setSaving(true);
    // Stored as NULL rather than '' so every "does this investment have a
    // unit" check stays a single null test.
    const trimmedUnit = unit.trim() || null;
    const result = editingInvestment
      ? await updateInvestment(
          editingInvestment.Id,
          trimmedName,
          currencyId,
          numericQuantity,
          numericUnitValue,
          investmentCategoryId,
          trimmedUnit,
          quantityDecimals
        )
      : await insertInvestment(
          trimmedName,
          currencyId,
          numericQuantity,
          numericUnitValue,
          formatDbDate(new Date()),
          investmentCategoryId,
          trimmedUnit,
          quantityDecimals
        );
    setSaving(false);

    if (result.Status === 'Success') {
      const wasEditing = editingInvestment !== null;
      closeForm();
      await loadData();
      setPopupMessage({
        message: wasEditing ? 'Investment updated.' : 'Investment added.',
        title: 'Saved',
        variant: 'success',
      });
      return;
    }

    setInvestmentFormError(result.Message ?? 'Failed to save investment.', result.Detail);
  };

  const confirmDelete = async () => {
    if (!deletingInvestment || deleting) {
      return;
    }

    setDeleting(true);
    const result = await deleteInvestment(deletingInvestment.Id, deletingInvestment.Quantity > 0);
    setDeleting(false);
    setDeletingInvestment(null);

    if (result.Status === 'Success') {
      await loadData();
      setPopupMessage({ message: 'Investment deleted.', title: 'Deleted', variant: 'success' });
      return;
    }

    setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Failed to delete investment.', variant: 'danger' });
  };

  const selectedCurrency = currencies.find((currency) => currency.Id === currencyId);
  // Fall back to the joined name for categories not in the active list
  // (e.g. an investment still pointing at a soft-deleted category).
  const selectedCategoryName =
    investmentCategories.find((category) => category.Id === investmentCategoryId)?.Name ??
    (editingInvestment && investmentCategoryId === editingInvestment.InvestmentCategoryId
      ? editingInvestment.InvestmentCategoryName ?? ''
      : '');

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton} testID="manageInvestments.back">
            <FontAwesome name="angle-left" size={28} color={colors.text} />
          </Pressable>
          <Text style={styles.title}>Investments</Text>
          <View style={styles.iconButton} />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => setFormOpen(true)}
          testID="manageInvestments.add"
          style={({ pressed }) => [
            styles.addTextButton,
            { backgroundColor: colors.buttonPrimaryBackground, borderColor: colors.buttonPrimaryBorder },
            pressed && styles.pressed,
          ]}>
          <Text style={styles.addTextButtonLabel}>Add New Investment</Text>
        </Pressable>

        <View style={styles.list}>
          {investments.map((investment) => (
            <View key={investment.Id} style={[styles.itemRow, { borderColor: colors.border }]}>
              <View style={styles.itemText}>
                <Text style={styles.itemTitle}>{investment.Name}</Text>
                {investment.InvestmentCategoryName ? (
                  <Text style={[styles.itemSubtitle, { color: colors.textMuted }]}>{investment.InvestmentCategoryName}</Text>
                ) : null}
              </View>
              <Pressable
                accessibilityLabel={`View ${investment.Name}`}
                accessibilityRole="button"
                onPress={() => viewInvestment(investment)}
                testID={`manageInvestments.view.${investment.Name}`}
                style={styles.rowAction}>
                <FontAwesome name="eye" size={18} color={colors.text} />
              </Pressable>
              <Pressable
                accessibilityLabel={`Edit ${investment.Name}`}
                accessibilityRole="button"
                onPress={() => openEdit(investment)}
                testID={`manageInvestments.edit.${investment.Name}`}
                style={styles.rowAction}>
                <FontAwesome name="pencil" size={18} color={colors.text} />
              </Pressable>
              <Pressable
                accessibilityLabel={`Delete ${investment.Name}`}
                accessibilityRole="button"
                onPress={() => setDeletingInvestment(investment)}
                testID={`manageInvestments.delete.${investment.Name}`}
                style={styles.rowAction}>
                <FontAwesome name="trash-o" size={18} color={colors.dangerText} />
              </Pressable>
            </View>
          ))}
          {loading ? <LoadingSpinner /> : null}
          {!loading && investments.length === 0 ? <Text style={[styles.emptyText, { color: colors.textMuted }]}>No investments yet.</Text> : null}
        </View>
      </ScrollView>

      {popupMessage ? (
        <Popup
          detail={popupMessage.detail}
          message={popupMessage.message}
          onClose={() => setPopupMessage(null)}
          style={styles.popup}
          title={popupMessage.title}
          variant={popupMessage.variant}
        />
      ) : null}

      <Modal animationType="fade" transparent visible={formOpen} onRequestClose={closeForm}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeForm} />
            {/* Tallest form in the app: with the keyboard up it cannot fit, so the
                panel shrinks (flexShrink) and its content scrolls. */}
            <View style={[styles.formModalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <ScrollView
                contentContainerStyle={styles.formModalContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                {...investmentFormScroll.scrollViewProps}
                style={styles.formModalScroll}>
                <Text style={styles.modalTitle}>{editingInvestment ? 'Edit Investment' : 'Add Investment'}</Text>
                <TextField label="Name:" onChangeText={setName} testID="manageInvestments.form.name" value={name} />
                <SelectField
                  label="Category:"
                  onPress={openCategoryPicker}
                  placeholder="Select category (defaults to General)"
                  testID="manageInvestments.form.category"
                  value={selectedCategoryName}
                />
                {editLocked ? (
                  <Text style={[styles.lockedNote, { color: colors.textMuted }]}>
                    Quantity, decimals, value per unit and currency are locked because this investment already has
                    history. Use Adjust on the Investments screen to change its quantity or value per unit.
                  </Text>
                ) : null}
                <SelectField
                  disabled={editLocked}
                  label="Currency:"
                  onPress={() => setCurrencyPickerOpen(true)}
                  placeholder="Select currency"
                  testID="manageInvestments.form.currency"
                  value={getCurrencyLabel(selectedCurrency)}
                />
                <TextField
                  label="Unit:"
                  maxLength={24}
                  onChangeText={setUnit}
                  placeholder="Optional (e.g. gram, lot)"
                  testID="manageInvestments.form.unit"
                  value={unit}
                />
                <SelectField
                  disabled={editLocked}
                  label="Quantity Decimals:"
                  onPress={() => setQuantityDecimalsPickerOpen(true)}
                  placeholder="0"
                  testID="manageInvestments.form.decimals"
                  value={getQuantityDecimalsLabel(quantityDecimals)}
                />
                <QuantityField
                  decimals={quantityDecimals}
                  editable={!editLocked}
                  label="Quantity:"
                  onChangeText={setQuantity}
                  placeholder="0"
                  testID="manageInvestments.form.quantity"
                  value={quantity}
                />
                <MoneyField
                  currency={getUnitValueCurrency(selectedCurrency)}
                  editable={!editLocked}
                  error={unitValueFieldError}
                  label="Value Per Unit:"
                  onChangeText={(value) => {
                    setUnitValue(value);
                    setUnitValueFieldError(false);
                  }}
                  testID="manageInvestments.form.unitValue"
                  value={unitValue}
                />
                <View style={styles.modalActions}>
                  <Button disabled={saving} onPress={closeForm} size="small" testID="manageInvestments.form.cancel">
                    Cancel
                  </Button>
                  <Button disabled={saving} onPress={saveInvestment} size="small" testID="manageInvestments.form.save" variant="primary">
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </View>
              </ScrollView>
              {/* Outside the ScrollView, as in Manage Categories: visible whatever
                  the scroll position, and mounting it doesn't change the scroll
                  content's height. */}
              {investmentFormError.message ? (
                <View style={styles.formModalFooter}>
                  <Popup
                    detail={investmentFormError.detail} message={investmentFormError.message}
                    onClose={() => setInvestmentFormError('')}
                    variant="danger"
                  />
                </View>
              ) : null}
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <PickerModal
        emptyText="No currencies available."
        items={[...currencies]
          .sort((a, b) => a.Code.localeCompare(b.Code))
          .map((currency) => ({ id: currency.Id, label: getCurrencyLabel(currency) }))}
        onClose={() => setCurrencyPickerOpen(false)}
        onSelect={(item) => {
          setCurrencyId(Number(item.id));
          setCurrencyPickerOpen(false);
        }}
        searchable
        selectedId={currencyId}
        title="Currency"
        visible={currencyPickerOpen}
      />

      <PickerModal
        items={QUANTITY_DECIMAL_OPTIONS.map((decimals) => ({ id: decimals, label: getQuantityDecimalsLabel(decimals) }))}
        onClose={() => setQuantityDecimalsPickerOpen(false)}
        onSelect={(item) => {
          const decimals = Number(item.id);
          setQuantityDecimals(decimals);
          setQuantity((current) => clampQuantityInput(current, decimals));
          setQuantityDecimalsPickerOpen(false);
        }}
        selectedId={quantityDecimals}
        title="Quantity Decimals"
        visible={quantityDecimalsPickerOpen}
      />

      <Modal
        animationType="fade"
        transparent
        visible={deletingInvestment !== null}
        onRequestClose={() => (deleting ? undefined : setDeletingInvestment(null))}>
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.modalBackdropPressable}
            onPress={() => (deleting ? undefined : setDeletingInvestment(null))}
          />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Delete {deletingInvestment?.Name}</Text>
            <Text style={styles.modalText}>
              {deletingInvestment && deletingInvestment.Quantity > 0
                ? `This investment still holds ${formatQuantity(deletingInvestment.Quantity, deletingInvestment.QuantityDecimals)} ${deletingInvestment.Unit ?? 'unit(s)'}. ` +
                  'If you sold it, create an Investment Liquidation transaction instead so the money reaches an account. ' +
                  'If it is lost or worthless, deleting will write off the remaining units without moving any money.'
                : 'Delete this investment? Its history will be kept, but it will no longer appear anywhere.'}
            </Text>
            <View style={styles.modalActions}>
              <Button disabled={deleting} onPress={() => setDeletingInvestment(null)} size="small" testID="manageInvestments.deleteCancel">
                Cancel
              </Button>
              <Button disabled={deleting} onPress={confirmDelete} size="small" testID="manageInvestments.deleteConfirm" variant="danger">
                {deleting
                  ? 'Deleting...'
                  : deletingInvestment && deletingInvestment.Quantity > 0
                    ? 'Write Off & Delete'
                    : 'Delete'}
              </Button>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  addTextButton: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 22,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  addTextButtonLabel: {
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 15,
  },
  emptyText: {
    fontSize: 16,
    paddingTop: 24,
    textAlign: 'center',
  },
  currencyPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: '78%',
    maxWidth: 390,
    padding: 16,
    width: '92%',
  },
  formModalContent: {
    padding: 16,
  },
  formModalFooter: {
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  // flexShrink on both lets the panel give up height when the keyboard
  // makes room (window resize or ModalKeyboardAvoider), and the ScrollView
  // take up the difference — see formModalPanel in manageCategories.
  formModalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 1,
    maxHeight: '92%',
    maxWidth: 390,
    width: '92%',
  },
  formModalScroll: {
    flexShrink: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  iconButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  itemRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 74,
    paddingVertical: 12,
  },
  itemSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  itemText: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  list: {
    paddingTop: 20,
  },
  lockedNote: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
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
  modalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 390,
    padding: 16,
    width: '92%',
  },
  modalText: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
  optionLabel: {
    flex: 1,
    fontSize: 18,
  },
  optionRow: {
    alignItems: 'center',
    borderRadius: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 12,
  },
  popup: {
    bottom: 16,
    left: 15,
    position: 'absolute',
    right: 15,
  },
  pressed: {
    opacity: 0.65,
  },
  rowAction: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  screen: {
    flex: 1,
  },
  title: {
    flex: 1,
    fontSize: 26,
    fontWeight: '400',
    textAlign: 'center',
  },
});
