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
import { SelectField, TextField } from '@/components/themed/fields';
import {
  deleteInvestmentCategory,
  getInvestmentCategories,
  getInvestmentCategoryNameConflict,
  getInvestmentCategoryUsageCount,
  insertInvestmentCategory,
  InvestmentCategory,
  isReservedInvestmentCategoryId,
  updateInvestmentCategory,
} from '@/database/tables/investmentCategories';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useErrorState } from '@/hooks/useErrorState';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type PopupMessage = {
  detail?: string;
  message: string;
  title?: string;
  variant: 'danger' | 'success' | 'warning';
};

export default function ManageInvestmentCategoriesScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [categories, setCategories] = useState<InvestmentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<InvestmentCategory | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<InvestmentCategory | null>(null);
  const [replacementId, setReplacementId] = useState<number | null>(null);
  const [replacementPickerOpen, setReplacementPickerOpen] = useState(false);
  const [name, setName] = useState('');
  const [usageCount, setUsageCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [categoryFormError, setCategoryFormError] = useErrorState();
  // Name of the removed category colliding with what is being created. Only
  // informational — the user is always allowed to proceed.
  const [removedNameWarning, setRemovedNameWarning] = useState('');
  const [categoryDeleteError, setCategoryDeleteError] = useErrorState();
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);

  const replacementOptions = useMemo(
    () => categories.filter((category) => category.Id !== deletingCategory?.Id),
    [categories, deletingCategory?.Id]
  );
  const selectedReplacement = replacementOptions.find((category) => category.Id === replacementId);

  const loadCategories = useCallback(async () => {
    setLoading(true);
    const result = await getInvestmentCategories();
    setLoading(false);
    if (result.Status === 'Success') {
      setCategories(result.Data);
    } else {
      setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Failed to load investment categories.', variant: 'danger' });
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const openForm = (category?: InvestmentCategory) => {
    if (category && isReservedInvestmentCategoryId(category.Id)) {
      return;
    }

    setFormOpen(true);
    setEditingCategory(category ?? null);
    setName(category?.Name ?? '');
    setCategoryFormError('');
  };

  const closeForm = () => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingCategory(null);
    setName('');
    setCategoryFormError('');
    setRemovedNameWarning('');
  };

  const saveCategory = async () => {
    const trimmedName = name.trim();
    setRemovedNameWarning('');

    if (!trimmedName) {
      setCategoryFormError('Name is required.');
      return;
    }

    setCategoryFormError('');
    setSaving(true);
    const conflictResult = await getInvestmentCategoryNameConflict(trimmedName, editingCategory?.Id);
    setSaving(false);

    if (conflictResult.Status !== 'Success') {
      setCategoryFormError(conflictResult.Message ?? 'Failed to check for a duplicate category name.', conflictResult.Detail);
      return;
    }

    const conflictingCategory = conflictResult.ConflictingCategory;

    // An active name is a hard block whether creating or editing — two live
    // categories must never share a name.
    if (conflictingCategory?.IsActive) {
      setCategoryFormError(`An investment category named "${conflictingCategory.Name}" already exists.`);
      return;
    }

    // A removed category holding the name only warns: it is invisible in the
    // list, so refusing the name would look arbitrary. Creation only — once the
    // name is accepted, editing anything else would re-ask a settled question.
    if (conflictingCategory && !editingCategory) {
      setRemovedNameWarning(conflictingCategory.Name);
      return;
    }

    await commitCategory();
  };

  const commitCategory = async () => {
    const trimmedName = name.trim();

    setRemovedNameWarning('');
    setCategoryFormError('');
    setSaving(true);
    const result = editingCategory
      ? await updateInvestmentCategory(editingCategory.Id, trimmedName)
      : await insertInvestmentCategory(trimmedName);
    setSaving(false);

    if (result.Status === 'Success') {
      closeForm();
      await loadCategories();
      setPopupMessage({
        message: `Investment category ${editingCategory ? 'updated' : 'added'}.`,
        title: 'Saved',
        variant: 'success',
      });
      return;
    }

    setCategoryFormError(result.Message ?? 'Failed to save investment category.', result.Detail);
  };

  const openDelete = async (category: InvestmentCategory) => {
    if (isReservedInvestmentCategoryId(category.Id)) {
      return;
    }

    const usageResult = await getInvestmentCategoryUsageCount(category.Id);
    setDeletingCategory(category);
    setUsageCount(usageResult.Status === 'Success' ? usageResult.Count : 0);
    setReplacementId(null);
    setCategoryDeleteError('');

    if (usageResult.Status !== 'Success') {
      setCategoryDeleteError(usageResult.Message ?? 'Failed to check category usage.', usageResult.Detail);
    }
  };

  const closeDelete = () => {
    if (saving) {
      return;
    }

    setDeletingCategory(null);
    setReplacementId(null);
    setUsageCount(0);
    setCategoryDeleteError('');
  };

  const confirmDelete = async () => {
    if (!deletingCategory) {
      return;
    }

    setCategoryDeleteError('');
    setSaving(true);
    const result = await deleteInvestmentCategory(deletingCategory.Id, replacementId);
    setSaving(false);

    if (result.Status === 'Success') {
      closeDelete();
      await loadCategories();
      setPopupMessage({ message: 'Investment category removed.', title: 'Removed', variant: 'success' });
      return;
    }

    setCategoryDeleteError(result.Message ?? 'Failed to remove investment category.', result.Detail);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton} testID="manageInvestmentCategories.back">
            <FontAwesome name="angle-left" size={28} color={colors.text} />
          </Pressable>
          <Text style={styles.title}>Investment Categories</Text>
          <View style={styles.iconButton} />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => openForm()}
          testID="manageInvestmentCategories.add"
          style={({ pressed }) => [
            styles.addTextButton,
            { backgroundColor: colors.buttonPrimaryBackground, borderColor: colors.buttonPrimaryBorder },
            pressed && styles.pressed,
          ]}>
          <Text style={styles.addTextButtonLabel}>Add New Category</Text>
        </Pressable>

        <View style={styles.list}>
          {categories.map((category) => {
            // General is reserved (Id 1): shown with both actions disabled,
            // the same way Manage Categories shows transaction categories 1-4.
            const reserved = isReservedInvestmentCategoryId(category.Id);

            return (
              <View key={category.Id} style={[styles.itemRow, { borderColor: colors.border }]}>
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{category.Name}</Text>
                </View>
                <Pressable
                  accessibilityLabel={`Edit ${category.Name}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: reserved }}
                  disabled={reserved}
                  onPress={() => openForm(category)}
                  testID={`manageInvestmentCategories.edit.${category.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name="pencil" size={18} color={reserved ? colors.buttonDisabled : colors.text} />
                </Pressable>
                <Pressable
                  accessibilityLabel={`Delete ${category.Name}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: reserved }}
                  disabled={reserved}
                  onPress={() => openDelete(category)}
                  testID={`manageInvestmentCategories.delete.${category.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name="trash" size={18} color={reserved ? colors.buttonDisabled : colors.dangerText} />
                </Pressable>
              </View>
            );
          })}
          {loading ? <LoadingSpinner /> : null}
          {!loading && categories.length === 0 ? <Text style={[styles.emptyText, { color: colors.textMuted }]}>No investment categories yet.</Text> : null}
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
            <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={styles.modalTitle}>{editingCategory ? 'Edit Investment Category' : 'Add Investment Category'}</Text>
              <TextField label="Name:" onChangeText={setName} testID="manageInvestmentCategories.form.name" value={name} />
              {categoryFormError.message ? (
                <Popup
                  detail={categoryFormError.detail} message={categoryFormError.message}
                  onClose={() => setCategoryFormError('')}
                  style={styles.modalPopup}
                  variant="danger"
                />
              ) : null}
              {removedNameWarning ? (
                <ConfirmationPopup
                  actionsLayout="spread"
                  confirmLabel="Save anyway"
                  confirmVariant="success"
                  message={`You previously had an investment category named "${removedNameWarning}" that was removed. Investments kept on it still show that name.`}
                  onCancel={() => setRemovedNameWarning('')}
                  onConfirm={commitCategory}
                  style={styles.modalPopup}
                  title="Name used before"
                  variant="warning"
                />
              ) : null}
              <View style={styles.modalActions}>
                <Button disabled={saving} onPress={closeForm} size="small" testID="manageInvestmentCategories.form.cancel">
                  Cancel
                </Button>
                <Button disabled={saving} onPress={saveCategory} size="small" testID="manageInvestmentCategories.form.save" variant="primary">
                  {saving ? 'Saving...' : 'Save'}
                </Button>
              </View>
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <Modal animationType="fade" transparent visible={deletingCategory !== null} onRequestClose={closeDelete}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={closeDelete} />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Remove Investment Category</Text>
            <Text style={styles.modalText}>
              {usageCount > 0
                ? `${usageCount} ${usageCount === 1 ? 'investment uses' : 'investments use'} this category.\n${
                    replacementOptions.length > 0
                      ? 'You can choose a replacement to update the category for these investments or keep them unchanged as history.'
                      : 'Removing this will not remove those investments and they will keep this category.'
                  }`
                : 'This category will be removed from future selection.'}
            </Text>
            {usageCount > 0 && replacementOptions.length > 0 ? (
              <SelectField
                label="Move existing data to:"
                onPress={() => setReplacementPickerOpen(true)}
                placeholder="Select replacement"
                testID="manageInvestmentCategories.delete.replacement"
                value={selectedReplacement?.Name}
              />
            ) : null}
            {categoryDeleteError.message ? (
              <Popup
                detail={categoryDeleteError.detail} message={categoryDeleteError.message}
                onClose={() => setCategoryDeleteError('')}
                style={styles.modalPopup}
                variant="danger"
              />
            ) : null}
            <View style={styles.modalActions}>
              <Button disabled={saving} onPress={closeDelete} size="small" testID="manageInvestmentCategories.deleteCancel">
                Cancel
              </Button>
              <Button disabled={saving} onPress={confirmDelete} size="small" testID="manageInvestmentCategories.deleteConfirm" variant="danger">
                {usageCount > 0 && replacementOptions.length > 0 && !replacementId ? 'Remove Only' : 'Remove'}
              </Button>
            </View>
          </View>
        </View>
      </Modal>

      <PickerModal
        emptyText="No replacement categories available."
        items={replacementOptions.map((category) => ({ id: category.Id, label: category.Name }))}
        onClose={() => setReplacementPickerOpen(false)}
        onSelect={(item) => {
          setReplacementId(Number(item.id));
          setReplacementPickerOpen(false);
        }}
        searchable
        selectedId={replacementId}
        title="Replacement Category"
        visible={replacementPickerOpen}
      />
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
    marginTop: 12,
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
    minHeight: 70,
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
    maxWidth: 380,
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
