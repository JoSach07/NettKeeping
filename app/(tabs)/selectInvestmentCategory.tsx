import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import ConfirmationPopup from '@/components/themed/ConfirmationPopup';
import { TextField } from '@/components/themed/fields';
import { Text } from '@/components/Themed';
import { useAppTheme } from '@/hooks/useAppTheme';
import {
  getInvestmentCategories,
  getInvestmentCategoryNameConflict,
  insertInvestmentCategory,
  InvestmentCategory,
} from '@/database/tables/investmentCategories';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

// Screens that can open this picker. The chosen category is returned to them
// via router.dismissTo with an investmentCategoryId param, mirroring how
// selectTransactionField returns values to createTransaction.
type ReturnTo = 'manageInvestments' | 'selectTransactionField';

type SelectionParams = {
  // Which screen to return the selection to.
  returnTo?: string;
  // Currently selected category (if any), for the check mark.
  investmentCategoryId?: string;
  // Passthrough params owned by createTransaction / selectTransactionField. They are
  // carried untouched so the transaction draft survives the round trip.
  accountId?: string;
  additionalFees?: string;
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
  quantity?: string;
  toAccountId?: string;
  unitValue?: string;
};

const parseParamString = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

const parseParamNumber = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

const parseReturnTo = (value: string | string[] | undefined): ReturnTo =>
  parseParamString(value) === 'selectTransactionField' ? 'selectTransactionField' : 'manageInvestments';

export default function SelectInvestmentCategoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<SelectionParams>();
  const { colors } = useAppTheme();
  const returnTo = parseReturnTo(params.returnTo);
  const selectedId = parseParamNumber(params.investmentCategoryId);
  const [categories, setCategories] = useState<InvestmentCategory[]>([]);
  const [message, setMessage] = useErrorState();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [createError, setCreateError] = useErrorState();
  // Name of a removed category colliding with the new one. Informational only:
  // the user can always proceed. Mirrors Manage Accounts / Manage Investment
  // Categories so the same collision reads the same way everywhere.
  const [removedNameWarning, setRemovedNameWarning] = useState('');
  const [saving, setSaving] = useState(false);

  const filteredCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return categories;
    }

    return categories.filter((category) => category.Name.toLowerCase().includes(normalizedQuery));
  }, [categories, query]);

  const loadCategories = useCallback(async () => {
    setMessage('');

    const result = await getInvestmentCategories();
    if (result.Status === 'Success') {
      setCategories(result.Data);
    } else {
      setMessage(result.Message ?? 'Unable to load investment categories.', result.Detail);
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const chooseCategory = (category: InvestmentCategory) => {
    if (returnTo === 'selectTransactionField') {
      router.dismissTo({
        pathname: '/selectTransactionField',
        params: {
          accountId: parseParamString(params.accountId),
          additionalFees: parseParamString(params.additionalFees),
          amount: parseParamString(params.amount),
          categoryId: parseParamString(params.categoryId),
          date: parseParamString(params.date),
          description: parseParamString(params.description),
          editTransactionId: parseParamString(params.editTransactionId),
          exchangeRate: parseParamString(params.exchangeRate),
          exchangeRateDirection: parseParamString(params.exchangeRateDirection),
          field: 'investment',
          fromAccountId: parseParamString(params.fromAccountId),
          investmentCategoryId: category.Id.toString(),
          investmentId: parseParamString(params.investmentId),
          transactionTypeId: parseParamString(params.transactionTypeId),
          quantity: parseParamString(params.quantity),
          reopenCreateInvestment: '1',
          toAccountId: parseParamString(params.toAccountId),
          unitValue: parseParamString(params.unitValue),
        },
      });
      return;
    }

    router.dismissTo({
      pathname: '/manageInvestments',
      params: { investmentCategoryId: category.Id.toString() },
    });
  };

  const closeCreate = () => {
    if (saving) {
      return;
    }

    setCreateOpen(false);
    setNewCategoryName('');
    setCreateError('');
    setRemovedNameWarning('');
  };

  // A category created here is what the user came for, so it is selected and
  // returned to the caller immediately rather than dropping them back on the
  // list to pick it themselves.
  const commitNewCategory = async () => {
    const trimmedName = newCategoryName.trim();

    setRemovedNameWarning('');
    setCreateError('');
    setSaving(true);
    const result = await insertInvestmentCategory(trimmedName);
    setSaving(false);

    if (result.Status !== 'Success' || !result.DataId) {
      setCreateError(result.Message ?? 'Failed to create investment category.', result.Detail);
      return;
    }

    setCreateOpen(false);
    setNewCategoryName('');
    chooseCategory({ Id: result.DataId, IsActive: true, Name: trimmedName });
  };

  const saveNewCategory = async () => {
    const trimmedName = newCategoryName.trim();
    setRemovedNameWarning('');

    if (!trimmedName) {
      setCreateError('Name is required.');
      return;
    }

    setCreateError('');
    setSaving(true);
    const conflictResult = await getInvestmentCategoryNameConflict(trimmedName);
    setSaving(false);

    if (conflictResult.Status !== 'Success') {
      setCreateError(conflictResult.Message ?? 'Failed to check for a duplicate category name.', conflictResult.Detail);
      return;
    }

    const conflictingCategory = conflictResult.ConflictingCategory;

    if (conflictingCategory?.IsActive) {
      setCreateError(`An investment category named "${conflictingCategory.Name}" already exists.`);
      return;
    }

    if (conflictingCategory) {
      setRemovedNameWarning(conflictingCategory.Name);
      return;
    }

    await commitNewCategory();
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
        <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton} testID="selectInvestmentCategory.back">
          <FontAwesome name="angle-left" size={28} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Investment Category</Text>
        <View style={styles.backButton} />
      </View>

      <TextField
        autoCapitalize="none"
        autoCorrect={false}
        containerStyle={styles.searchField}
        label="Search:"
        onChangeText={setQuery}
        placeholder="Search investment category"
        prefix={<FontAwesome name="search" size={16} color={colors.textMuted} style={styles.searchIcon} />}
        testID="selectInvestmentCategory.search"
        value={query}
      />

      {message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}

      <FlatList
        contentContainerStyle={styles.list}
        data={filteredCategories}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.Id.toString()}
        ListHeaderComponent={
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setCreateError('');
              setRemovedNameWarning('');
              setNewCategoryName(query.trim());
              setCreateOpen(true);
            }}
            testID="selectInvestmentCategory.new"
            style={({ pressed }) => [
              styles.createRow,
              { borderColor: colors.border },
              pressed && styles.pressed,
            ]}>
            <Text style={[styles.createText, { color: colors.tint }]}>New Investment Category</Text>
          </Pressable>
        }
        ListEmptyComponent={
          !message.message ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>
              {query ? 'No results found.' : 'No investment categories yet. Create one above, or manage them from Settings > Investment Categories.'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: item.Id === selectedId }}
            onPress={() => chooseCategory(item)}
            testID={`selectInvestmentCategory.option.${item.Name}`}
            style={({ pressed }) => [
              styles.optionRow,
              { borderColor: colors.border },
              pressed && styles.pressed,
            ]}>
            <Text style={styles.optionText}>{item.Name}</Text>
            {item.Id === selectedId ? <FontAwesome name="check" size={16} color={colors.tint} /> : null}
          </Pressable>
        )}
      />

      <Modal animationType="fade" transparent visible={createOpen} onRequestClose={closeCreate}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeCreate} />
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>New Investment Category</Text>
              <TextInput
                autoCapitalize="words"
                maxLength={60}
                onChangeText={(value) => {
                  setNewCategoryName(value);
                  setCreateError('');
                }}
                placeholder="Name"
                placeholderTextColor={colors.textMuted}
                style={[styles.modalInput, { borderColor: colors.border, color: colors.text }]}
                testID="selectInvestmentCategory.new.name"
                value={newCategoryName}
              />
              {createError.message ? (
                <ErrorText
                  align="left"
                  color={colors.dangerText}
                  detail={createError.detail}
                  message={createError.message}
                  textStyle={styles.modalError}
                />
              ) : null}
              {removedNameWarning ? (
                <ConfirmationPopup
                  actionsLayout="spread"
                  confirmLabel="Save anyway"
                  confirmVariant="success"
                  message={`You previously had an investment category named "${removedNameWarning}" that was removed. Investments kept on it still show that name.`}
                  onCancel={() => setRemovedNameWarning('')}
                  onConfirm={commitNewCategory}
                  style={styles.modalPopup}
                  title="Name used before"
                  variant="warning"
                />
              ) : null}
              <View style={styles.modalActions}>
                <Button disabled={saving} onPress={closeCreate} size="small" testID="selectInvestmentCategory.new.cancel">
                  Cancel
                </Button>
                <Button disabled={saving} onPress={saveNewCategory} size="small" testID="selectInvestmentCategory.new.save" variant="primary">
                  {saving ? 'Saving...' : 'Save'}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>
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
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
  },
  list: {
    paddingBottom: 24,
    paddingHorizontal: 15,
  },
  message: {
    fontSize: 13,
    paddingHorizontal: 15,
    paddingTop: 14,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
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
  modalError: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 8,
  },
  modalInput: {
    borderRadius: 5,
    borderWidth: 1,
    fontSize: 18,
    height: 54,
    paddingHorizontal: 12,
  },
  modalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 360,
    padding: 16,
    width: '90%',
  },
  modalPopup: {
    marginTop: 10,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
  optionRow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
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
