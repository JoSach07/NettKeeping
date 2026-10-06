import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import ConfirmationPopup from '@/components/themed/ConfirmationPopup';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import PickerModal from '@/components/themed/PickerModal';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { MoneyField, SelectField, TextField } from '@/components/themed/fields';
import {
  Account,
  deleteAccount,
  getAccountTransactionCount,
  getAccountNameConflict,
  getAccounts,
  insertAccount,
  updateAccount,
} from '@/database/tables/accounts';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { useAppTheme } from '@/hooks/useAppTheme';
import {
  clampMoneyInputPrecision,
  formatCurrencyAmount,
  formatHiddenCurrencyAmount,
  formatMinorUnitsToMoneyInput,
  getMoneyPrecisionError,
  moneyInputHasValidPrecision,
  parseMoneyInputToMinorUnits,
} from '@/utils/moneyInput';
import { useErrorState } from '@/hooks/useErrorState';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';
import { useKeepFocusedInputVisible } from '@/hooks/useKeepFocusedInputVisible';

type PopupMessage = {
  detail?: string;
  message: string;
  title?: string;
  variant: 'danger' | 'success' | 'warning';
};

const getCurrencyLabel = (currency?: Currency) => (currency ? `${currency.Code} - ${currency.Name}` : '');

export default function ManageAccountsScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const accountFormScroll = useKeepFocusedInputVisible();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [currencyId, setCurrencyId] = useState<number | null>(null);
  const [balanceLocked, setBalanceLocked] = useState(false);
  const [visibleBalanceIds, setVisibleBalanceIds] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [accountFormError, setAccountFormError] = useErrorState();
  // Name of the removed account colliding with what is being created. Only
  // informational — the user is always allowed to proceed.
  const [removedNameWarning, setRemovedNameWarning] = useState('');
  const [balanceFieldError, setBalanceFieldError] = useState(false);
  const [accountDeleteError, setAccountDeleteError] = useErrorState();
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);

  const currencyById = useMemo(
    () => new Map(currencies.map((currency) => [currency.Id, currency])),
    [currencies]
  );
  const selectedCurrency = currencies.find((currency) => currency.Id === currencyId);
  const balanceIsEditable = !editingAccount || !balanceLocked;

  const loadData = useCallback(async () => {
    setLoading(true);

    const [accountResult, currencyResult] = await Promise.all([getAccounts(), getCurrencies()]);
    const messages: ErrorMessage[] = [];

    setLoading(false);

    if (accountResult.Status === 'Success') {
      setAccounts(accountResult.Data);
    } else {
      messages.push(toErrorMessage(accountResult, 'Failed to load accounts.'));
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data.filter((currency) => currency.IsActive));
    } else {
      messages.push(toErrorMessage(currencyResult, 'Failed to load currencies.'));
    }

    if (messages.length > 0) {
      setPopupMessage({ ...joinErrorMessages(messages), variant: 'danger' });
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openForm = async (account?: Account) => {
    let nextBalanceLocked = false;
    let nextFormError = '';
    let nextFormErrorDetail: string | undefined;

    if (account) {
      const usageResult = await getAccountTransactionCount(account.Id);
      if (usageResult.Status === 'Success') {
        nextBalanceLocked = usageResult.Count > 0;
      } else {
        nextFormError = usageResult.Message ?? 'Failed to check account usage.';
        nextFormErrorDetail = usageResult.Detail;
      }
    }

    setFormOpen(true);
    setEditingAccount(account ?? null);
    setName(account?.Name ?? '');
    const nextCurrencyId = account?.CurrencyId ?? currencies[0]?.Id ?? null;
    const nextCurrency = currencies.find((currency) => currency.Id === nextCurrencyId);

    setBalance(account ? formatMinorUnitsToMoneyInput(account.Balance, nextCurrency) : '');
    setCurrencyId(nextCurrencyId);
    setBalanceLocked(nextBalanceLocked);
    setAccountFormError(nextFormError, nextFormErrorDetail);
    setBalanceFieldError(false);
    setRemovedNameWarning('');
  };

  const closeForm = () => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingAccount(null);
    setName('');
    setBalance('');
    setCurrencyId(null);
    setBalanceLocked(false);
    setAccountFormError('');
    setBalanceFieldError(false);
    setRemovedNameWarning('');
  };

  const toggleBalanceVisibility = (accountId: number) => {
    setVisibleBalanceIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }

      return next;
    });
  };

  const commitAccount = async () => {
    const trimmedName = name.trim();
    const numericBalance = editingAccount && balanceLocked
      ? editingAccount.Balance
      : parseMoneyInputToMinorUnits(balance || '0', selectedCurrency);

    if (!currencyId) {
      return;
    }

    setRemovedNameWarning('');
    setAccountFormError('');
    const savedBalance = numericBalance ?? 0;
    setSaving(true);
    const result = editingAccount
      ? await updateAccount(editingAccount.Id, trimmedName, savedBalance, currencyId)
      : await insertAccount(trimmedName, savedBalance, currencyId);
    setSaving(false);

    if (result.Status === 'Success') {
      closeForm();
      await loadData();
      setPopupMessage({
        message: `Account ${editingAccount ? 'updated' : 'added'}.`,
        title: 'Saved',
        variant: 'success',
      });
      return;
    }

    setAccountFormError(result.Message ?? 'Failed to save account.', result.Detail);
  };

  const saveAccount = async () => {
    const trimmedName = name.trim();
    const numericBalance = editingAccount && balanceLocked
      ? editingAccount.Balance
      : parseMoneyInputToMinorUnits(balance || '0', selectedCurrency);
    setBalanceFieldError(false);
    setRemovedNameWarning('');

    if (!trimmedName) {
      setAccountFormError('Name is required.');
      return;
    }

    if (!balanceLocked && !moneyInputHasValidPrecision(balance, selectedCurrency)) {
      setBalanceFieldError(true);
      setAccountFormError(getMoneyPrecisionError(selectedCurrency));
      return;
    }

    if (!balanceLocked && (numericBalance === null || numericBalance < 0)) {
      setBalanceFieldError(true);
      setAccountFormError('Balance must be zero or higher.');
      return;
    }

    if (!currencyId) {
      setAccountFormError('Currency is required.');
      return;
    }

    setSaving(true);
    const conflictResult = await getAccountNameConflict(trimmedName, editingAccount?.Id);
    setSaving(false);

    if (conflictResult.Status !== 'Success') {
      setAccountFormError(conflictResult.Message ?? 'Failed to check for a duplicate account name.', conflictResult.Detail);
      return;
    }

    const conflictingAccount = conflictResult.ConflictingAccount;

    // An active name is a hard block whether creating or editing — two live
    // accounts must never share a name.
    if (conflictingAccount?.IsActive) {
      setAccountFormError(`An account named "${conflictingAccount.Name}" already exists.`);
      return;
    }

    // A removed account holding the name is not a blocker — it is invisible in
    // the list, so refusing the name would look arbitrary. Warn and let the
    // user decide, since the old name still shows on that account's historical
    // transactions and two identically named entries there could confuse.
    //
    // Only on creation, though. Once the user has accepted the name, editing
    // anything else on that account (its balance, say) would re-raise the same
    // popup on every save, asking about a decision already made.
    if (conflictingAccount && !editingAccount) {
      setAccountFormError('');
      setRemovedNameWarning(conflictingAccount.Name);
      return;
    }

    await commitAccount();
  };

  const confirmDelete = async () => {
    if (!deletingAccount) {
      return;
    }

    setAccountDeleteError('');
    setSaving(true);
    const result = await deleteAccount(deletingAccount.Id);
    setSaving(false);

    if (result.Status === 'Success') {
      setDeletingAccount(null);
      await loadData();
      setPopupMessage({ message: 'Account removed.', title: 'Removed', variant: 'success' });
      return;
    }

    setAccountDeleteError(result.Message ?? 'Failed to remove account.', result.Detail);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton} testID="manageAccounts.back">
            <FontAwesome name="angle-left" size={28} color={colors.text} />
          </Pressable>
          <Text style={styles.title}>Accounts</Text>
          <View style={styles.iconButton} />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => openForm()}
          testID="manageAccounts.add"
          style={({ pressed }) => [
            styles.addTextButton,
            { backgroundColor: colors.buttonPrimaryBackground, borderColor: colors.buttonPrimaryBorder },
            pressed && styles.pressed,
          ]}>
          <Text style={styles.addTextButtonLabel}>Add New Account</Text>
        </Pressable>

        <View style={styles.list}>
          {accounts.map((account) => {
            const currency = currencyById.get(account.CurrencyId);
            const balanceIsVisible = visibleBalanceIds.has(account.Id);

            return (
              <View
                collapsable={false}
                key={account.Id}
                style={[styles.itemRow, { borderColor: colors.border }]}
                testID={`manageAccounts.row.${account.Name}`}>
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{account.Name}</Text>
                  <Text style={[styles.itemMeta, { color: colors.textMuted }]}>
                    {balanceIsVisible ? formatCurrencyAmount(account.Balance, currency) : formatHiddenCurrencyAmount(currency)}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel={balanceIsVisible ? `Hide ${account.Name} balance` : `Show ${account.Name} balance`}
                  accessibilityRole="button"
                  onPress={() => toggleBalanceVisibility(account.Id)}
                  testID={`manageAccounts.balanceToggle.${account.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name={balanceIsVisible ? 'eye-slash' : 'eye'} size={18} color={colors.text} />
                </Pressable>
                <Pressable
                  accessibilityLabel={`Edit ${account.Name}`}
                  accessibilityRole="button"
                  onPress={() => openForm(account)}
                  testID={`manageAccounts.edit.${account.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name="pencil" size={18} color={colors.text} />
                </Pressable>
                <Pressable
                  accessibilityLabel={`Delete ${account.Name}`}
                  accessibilityRole="button"
                  onPress={() => setDeletingAccount(account)}
                  testID={`manageAccounts.delete.${account.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name="trash" size={18} color={colors.dangerText} />
                </Pressable>
              </View>
            );
          })}
          {loading ? <LoadingSpinner /> : null}
          {!loading && accounts.length === 0 ? <Text style={[styles.emptyText, { color: colors.textMuted }]}>No accounts yet.</Text> : null}
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
            <View style={[styles.formModalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              {/* Same scroll layout as the Add/Edit Category form: the panel
                  shrinks to the room above the keyboard and the fields scroll,
                  with the focused one kept in view. */}
              <ScrollView
                contentContainerStyle={styles.formModalContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                {...accountFormScroll.scrollViewProps}
                style={styles.formModalScroll}>
                <Text style={styles.modalTitle}>{editingAccount ? 'Edit Account' : 'Add Account'}</Text>
                <TextField
                  label="Name:"
                  onChangeText={(value) => {
                    setName(value);
                    setRemovedNameWarning('');
                  }}
                  testID="manageAccounts.form.name"
                  value={name}
                />
                <SelectField
                  disabled={Boolean(editingAccount) && balanceLocked}
                  label="Currency:"
                  onPress={() => setCurrencyPickerOpen(true)}
                  placeholder="Select currency"
                  testID="manageAccounts.form.currency"
                  value={getCurrencyLabel(selectedCurrency)}
                />
                <MoneyField
                  currency={selectedCurrency}
                  editable={balanceIsEditable}
                  error={balanceFieldError}
                  label="Balance:"
                  onChangeText={(value) => {
                    setBalance(value);
                    setBalanceFieldError(false);
                  }}
                  style={!balanceIsEditable && styles.disabledInput}
                  testID="manageAccounts.form.balance"
                  value={balance}
                />
                {balanceLocked ? (
                  <Text style={[styles.lockedText, { color: colors.textMuted }]}>
                    Balance and currency are locked because this account already has transactions.
                  </Text>
                ) : null}
                <View style={styles.modalActions}>
                  <Button disabled={saving} onPress={closeForm} size="small" testID="manageAccounts.form.cancel">Cancel</Button>
                  <Button disabled={saving} onPress={saveAccount} size="small" testID="manageAccounts.form.save" variant="primary">{saving ? 'Saving...' : 'Save'}</Button>
                </View>
              </ScrollView>
              {/* Outside the ScrollView, as in the Category form: visible at
                  any scroll position, and mounting/unmounting them does not
                  change the scroll content's height. */}
              {accountFormError.message ? (
                <View style={styles.formModalFooter}>
                  <Popup
                    detail={accountFormError.detail} message={accountFormError.message}
                    onClose={() => setAccountFormError('')}
                    variant="danger"
                  />
                </View>
              ) : null}
              {removedNameWarning ? (
                <View style={styles.formModalFooter}>
                  <ConfirmationPopup
                    actionsLayout="spread"
                    confirmLabel="Save anyway"
                    confirmVariant="success"
                    message={`You previously had an account named "${removedNameWarning}" that was removed. Its old transactions still show that name.`}
                    onCancel={() => setRemovedNameWarning('')}
                    onConfirm={commitAccount}
                    title="Name used before"
                    variant="warning"
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
          const nextCurrencyId = Number(item.id);
          const nextCurrency = currencies.find((currency) => currency.Id === nextCurrencyId);

          // The typed balance is a bare digit string; it carries no currency of
          // its own. Switching to a currency with fewer decimals would leave
          // "50.64" on screen while parseMoneyInputToMinorUnits stripped the
          // separator and saved 5064 minor units. Truncate instead, so what the
          // field shows is what gets stored.
          setBalance((current) => clampMoneyInputPrecision(current, nextCurrency));
          setBalanceFieldError(false);
          setCurrencyId(nextCurrencyId);
          setCurrencyPickerOpen(false);
        }}
        searchable
        selectedId={currencyId}
        title="Currency"
        visible={currencyPickerOpen}
      />

      <Modal animationType="fade" transparent visible={deletingAccount !== null} onRequestClose={() => setDeletingAccount(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.modalBackdropPressable}
            onPress={() => {
              setDeletingAccount(null);
              setAccountDeleteError('');
            }}
          />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Remove Account</Text>
            <Text style={styles.modalText}>This account will be removed from future selection. Existing transaction history will keep its account reference.</Text>
            {accountDeleteError.message ? (
              <Popup
                detail={accountDeleteError.detail} message={accountDeleteError.message}
                onClose={() => setAccountDeleteError('')}
                style={styles.modalPopup}
                variant="danger"
              />
            ) : null}
            <View style={styles.modalActions}>
              <Button
                disabled={saving}
                onPress={() => {
                  setDeletingAccount(null);
                  setAccountDeleteError('');
                }}
                size="small"
                testID="manageAccounts.deleteCancel">
                Cancel
              </Button>
              <Button disabled={saving} onPress={confirmDelete} size="small" testID="manageAccounts.deleteConfirm" variant="danger">
                Remove
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
  currencyPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxHeight: '78%',
    maxWidth: 390,
    padding: 16,
    width: '92%',
  },
  disabledInput: {
    opacity: 0.65,
  },
  emptyText: {
    fontSize: 16,
    paddingTop: 24,
    textAlign: 'center',
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
  itemMeta: {
    fontSize: 14,
    marginTop: 3,
  },
  itemRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 74,
    paddingVertical: 12,
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
  formModalContent: {
    padding: 16,
  },
  formModalFooter: {
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  // flexShrink lets the panel give up height when the keyboard makes room
  // (window resize or ModalKeyboardAvoider) and the ScrollView take up the
  // difference — see formModalPanel in manageCategories.
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
  lockedText: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 15,
    marginTop: -8,
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
  modalPopup: {
    marginBottom: 10,
  },
  modalText: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 16,
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
