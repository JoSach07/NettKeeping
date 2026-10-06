import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import ColorPicker, { ColorFormatsObject, HueSlider, Panel1, Swatches } from 'reanimated-color-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import ConfirmationPopup from '@/components/themed/ConfirmationPopup';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import PickerModal from '@/components/themed/PickerModal';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { SelectField, TextField } from '@/components/themed/fields';
import {
  Category,
  deleteCategory,
  getCategories,
  getCategoryNameConflict,
  getCategoryUsageCount,
  insertCategory,
  isReservedCategoryId,
  updateCategory,
} from '@/database/tables/categories';
import { getTransactionTypes, TransactionType } from '@/database/tables/transactionTypes';
import { categoryColorOptions } from '@/constants/Palette';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useKeepFocusedInputVisible } from '@/hooks/useKeepFocusedInputVisible';
import { useErrorState } from '@/hooks/useErrorState';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type PopupMessage = {
  detail?: string;
  message: string;
  title?: string;
  variant: 'danger' | 'success' | 'warning';
};

type FilterValue = 'all' | 'income' | 'outcome';

const colorOptions = categoryColorOptions;

const normalizeHexColor = (value: string) => {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return withHash.toUpperCase();
};

const isHexColor = (value: string) => /^#[0-9A-F]{6}$/i.test(value);

const getTransactionTypeLabel = (transactionType?: TransactionType) =>
  transactionType ? (transactionType.IsIncome ? 'Income' : 'Spending') : '';

// Protection is a property of the four seeded Ids, not of their names. Those
// names are renameable in principle and a user-made category that happens to
// be called "Investment" is an ordinary category — matching on the name made
// it silently uneditable and undeletable.
const isProtectedCategory = (category: Category) => isReservedCategoryId(category.Id);

const clampNumber = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const hexToRgb = (hexColor: string) => {
  const normalizedHex = normalizeHexColor(hexColor);
  if (!isHexColor(normalizedHex)) {
    return null;
  }

  return {
    r: parseInt(normalizedHex.slice(1, 3), 16),
    g: parseInt(normalizedHex.slice(3, 5), 16),
    b: parseInt(normalizedHex.slice(5, 7), 16),
  };
};

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((value) => clampNumber(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const rgbToHsl = (r: number, g: number, b: number) => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) {
    return { h: 0, s: 0, l: Math.round(lightness * 100) };
  }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red
      ? 60 * (((green - blue) / delta) % 6)
      : max === green
        ? 60 * ((blue - red) / delta + 2)
        : 60 * ((red - green) / delta + 4);

  return {
    h: Math.round((hue + 360) % 360),
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100),
  };
};

const hslToHex = (h: number, s: number, l: number) => {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clampNumber(s, 0, 100) / 100;
  const lightness = clampNumber(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return rgbToHex((red + match) * 255, (green + match) * 255, (blue + match) * 255);
};

const getHslFromHex = (hexColor: string) => {
  const rgb = hexToRgb(hexColor);
  return rgb ? rgbToHsl(rgb.r, rgb.g, rgb.b) : { h: 0, s: 0, l: 0 };
};

export default function ManageCategoriesScreen() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  // Scroll the focused field back into view when the keyboard shrinks a form.
  const categoryFormScroll = useKeepFocusedInputVisible();
  const colorModalScroll = useKeepFocusedInputVisible();
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactionTypes, setTransactionTypes] = useState<TransactionType[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [transactionTypePickerOpen, setTransactionTypePickerOpen] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [replacementPickerOpen, setReplacementPickerOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [colorCategory, setColorCategory] = useState<Category | null>(null);
  const [name, setName] = useState('');
  const [hexColor, setHexColor] = useState('#4CE466');
  const [colorHex, setColorHex] = useState('#4CE466');
  const [transactionTypeId, setTransactionTypeId] = useState<number | null>(null);
  const [replacementId, setReplacementId] = useState<number | null>(null);
  const [usageCount, setUsageCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [categoryFormError, setCategoryFormError] = useErrorState();
  // Name of the removed category colliding with what is being created. Only
  // informational — the user is always allowed to proceed.
  const [removedNameWarning, setRemovedNameWarning] = useState('');
  const [categoryColorError, setCategoryColorError] = useErrorState();
  const [categoryDeleteError, setCategoryDeleteError] = useErrorState();
  const [popupMessage, setPopupMessage] = useState<PopupMessage | null>(null);
  const checkingConflictRef = useRef(false);

  const transactionTypeById = useMemo(
    () => new Map(transactionTypes.map((transactionType) => [transactionType.Id, transactionType])),
    [transactionTypes]
  );
  const selectedTransactionType = transactionTypes.find((transactionType) => transactionType.Id === transactionTypeId);
  const deletingTransactionType = deletingCategory ? transactionTypeById.get(deletingCategory.TransactionTypeId) : undefined;
  const replacementOptions = useMemo(
    () =>
      categories.filter(
        (category) =>
          category.Id !== deletingCategory?.Id &&
          category.TransactionTypeId === deletingCategory?.TransactionTypeId &&
          // The seeded categories drive transfer and investment behavior, so
          // moving ordinary transactions onto them would misreport those as
          // transfers or investments.
          !isReservedCategoryId(category.Id)
      ),
    [categories, deletingCategory?.Id, deletingCategory?.TransactionTypeId]
  );
  const selectedReplacement = replacementOptions.find((category) => category.Id === replacementId);
  const filteredCategories = useMemo(
    () =>
      categories.filter((category) => {
        const transactionType = transactionTypeById.get(category.TransactionTypeId);
        if (filter === 'income') {
          return Boolean(transactionType?.IsIncome);
        }
        if (filter === 'outcome') {
          return transactionType ? !transactionType.IsIncome : false;
        }
        return true;
      }),
    [categories, filter, transactionTypeById]
  );

  const loadData = useCallback(async () => {
    setLoading(true);

    const [categoryResult, transactionTypeResult] = await Promise.all([getCategories(), getTransactionTypes()]);
    const messages: ErrorMessage[] = [];

    setLoading(false);

    if (categoryResult.Status === 'Success') {
      setCategories(categoryResult.Data);
    } else {
      messages.push(toErrorMessage(categoryResult, 'Failed to load categories.'));
    }

    if (transactionTypeResult.Status === 'Success') {
      setTransactionTypes(transactionTypeResult.Data);
    } else {
      messages.push(toErrorMessage(transactionTypeResult, 'Failed to load transaction types.'));
    }

    if (messages.length > 0) {
      setPopupMessage({ ...joinErrorMessages(messages), variant: 'danger' });
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openForm = (category?: Category) => {
    if (category && isProtectedCategory(category)) {
      return;
    }

    const defaultTransactionType =
      filter === 'income'
        ? transactionTypes.find((transactionType) => transactionType.IsIncome)
        : filter === 'outcome'
          ? transactionTypes.find((transactionType) => !transactionType.IsIncome)
          : transactionTypes[0];

    setFormOpen(true);
    setEditingCategory(category ?? null);
    setName(category?.Name ?? '');
    setHexColor(category?.HexColor ?? '#4CE466');
    setTransactionTypeId(category?.TransactionTypeId ?? defaultTransactionType?.Id ?? null);
    setCategoryFormError('');
    setRemovedNameWarning('');
  };

  const closeForm = () => {
    if (saving) {
      return;
    }

    setFormOpen(false);
    setEditingCategory(null);
    setName('');
    setHexColor('#4CE466');
    setTransactionTypeId(null);
    setCategoryFormError('');
    setRemovedNameWarning('');
  };

  const handleFormColorChange = (color: ColorFormatsObject) => {
    setHexColor(color.hex.toUpperCase());
  };

  const handleStandaloneColorChange = (color: ColorFormatsObject) => {
    setColorHex(color.hex.toUpperCase());
  };

  const openColorPicker = (category: Category) => {
    setColorCategory(category);
    setColorHex(category.HexColor);
    setCategoryColorError('');
  };

  const closeColorPicker = () => {
    if (saving) {
      return;
    }

    setColorCategory(null);
    setColorHex('#4CE466');
    setCategoryColorError('');
  };

  const saveCategory = async () => {
    const trimmedName = name.trim();
    const normalizedHex = normalizeHexColor(hexColor);

    // Guards against a double press while the conflict query is in flight.
    // Deliberately a ref and not `saving`: flipping `saving` here would disable
    // both buttons mid-press, and on Android that forces the focus system to
    // re-resolve, which makes the ScrollView scroll its first focusable child
    // into view. The read is a single lookup on a tiny table, so there is
    // nothing to show a spinner for anyway.
    if (checkingConflictRef.current) {
      return;
    }

    if (!trimmedName) {
      setCategoryFormError('Name is required.');
      return;
    }

    if (!isHexColor(normalizedHex)) {
      setCategoryFormError('Hex color must look like #4CE466.');
      return;
    }

    if (!transactionTypeId) {
      setCategoryFormError('Transaction type is required.');
      return;
    }

    // Deliberately NOT clearing categoryFormError here. Unmounting the popup
    // resizes the scroll viewport, which clamps contentOffset down and scrolls
    // the user back up; re-mounting it a moment later does not restore the
    // offset. Letting the outcome overwrite the message means a repeat press on
    // the same error re-renders nothing at all.
    checkingConflictRef.current = true;
    const conflictResult = await getCategoryNameConflict(trimmedName, transactionTypeId, editingCategory?.Id);
    checkingConflictRef.current = false;

    if (conflictResult.Status !== 'Success') {
      setCategoryFormError(conflictResult.Message ?? 'Failed to check for a duplicate category name.', conflictResult.Detail);
      return;
    }

    const conflictingCategory = conflictResult.ConflictingCategory;

    // An active name is a hard block whether creating or editing — two live
    // categories of the same transaction type must never share a name.
    if (conflictingCategory?.IsActive) {
      setCategoryFormError(`A category named "${conflictingCategory.Name}" already exists.`);
      return;
    }

    // A removed category holding the name only warns: it is invisible in the
    // list, so refusing the name would look arbitrary. Creation only — once the
    // name is accepted, editing anything else would re-ask a settled question.
    if (conflictingCategory && !editingCategory) {
      // Genuinely a different outcome, so a stale error from a previous press
      // has to go — otherwise it would sit above the warning contradicting it.
      setCategoryFormError('');
      setRemovedNameWarning(conflictingCategory.Name);
      return;
    }

    await commitCategory();
  };

  const commitCategory = async () => {
    const trimmedName = name.trim();
    const normalizedHex = normalizeHexColor(hexColor);

    if (!transactionTypeId) {
      return;
    }

    // Same reasoning as in saveCategory: the result overwrites the message, so
    // there is no need to unmount the popup first and resize the scroll area.
    // The warning does have to go, since the user has answered it.
    setRemovedNameWarning('');
    setSaving(true);
    const result = editingCategory
      ? await updateCategory(editingCategory.Id, trimmedName, normalizedHex, transactionTypeId)
      : await insertCategory(trimmedName, normalizedHex, transactionTypeId);
    setSaving(false);

    if (result.Status === 'Success') {
      closeForm();
      await loadData();
      setPopupMessage({
        message: `Category ${editingCategory ? 'updated' : 'added'}.`,
        title: 'Saved',
        variant: 'success',
      });
      return;
    }

    setCategoryFormError(result.Message ?? 'Failed to save category.', result.Detail);
  };

  const saveCategoryColor = async () => {
    if (!colorCategory) {
      return;
    }

    const normalizedHex = normalizeHexColor(colorHex);

    if (!isHexColor(normalizedHex)) {
      setCategoryColorError('Hex color must look like #4CE466.');
      return;
    }

    setCategoryColorError('');
    setSaving(true);
    const result = await updateCategory(
      colorCategory.Id,
      colorCategory.Name,
      normalizedHex,
      colorCategory.TransactionTypeId
    );
    setSaving(false);

    if (result.Status === 'Success') {
      closeColorPicker();
      await loadData();
      setPopupMessage({ message: 'Category color updated.', title: 'Saved', variant: 'success' });
      return;
    }

    setCategoryColorError(result.Message ?? 'Failed to update category color.', result.Detail);
  };

  const openDelete = async (category: Category) => {
    if (isProtectedCategory(category)) {
      return;
    }

    const usageResult = await getCategoryUsageCount(category.Id);
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
    const result = await deleteCategory(deletingCategory.Id, replacementId);
    setSaving(false);

    if (result.Status === 'Success') {
      closeDelete();
      await loadData();
      setPopupMessage({ message: 'Category removed.', title: 'Removed', variant: 'success' });
      return;
    }

    setCategoryDeleteError(result.Message ?? 'Failed to remove category.', result.Detail);
  };

  const filterLabel = filter === 'all' ? 'All' : filter === 'income' ? 'Income' : 'Spending';

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.iconButton} testID="manageCategories.back">
            <FontAwesome name="angle-left" size={28} color={colors.text} />
          </Pressable>
          <Text style={styles.title}>Transaction Categories</Text>
          <View style={styles.iconButton} />
        </View>

        <Pressable
          accessibilityLabel={`Filter categories: ${filterLabel}`}
          accessibilityRole="button"
          onPress={() => setFilterOpen(true)}
          testID="manageCategories.filter"
          style={({ pressed }) => [styles.filterButton, { borderColor: colors.border }, pressed && styles.pressed]}>
          <Text style={styles.filterText}>{filterLabel}</Text>
          <FontAwesome name="angle-down" size={22} color={colors.text} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => openForm()}
          testID="manageCategories.add"
          style={({ pressed }) => [
            styles.addTextButton,
            { backgroundColor: colors.buttonPrimaryBackground, borderColor: colors.buttonPrimaryBorder },
            pressed && styles.pressed,
          ]}>
          <Text style={styles.addTextButtonLabel}>Add New Category</Text>
        </Pressable>

        <View style={styles.list}>
          {filteredCategories.map((category) => {
            const transactionType = transactionTypeById.get(category.TransactionTypeId);
            const protectedCategory = isProtectedCategory(category);

            return (
              <View key={category.Id} style={[styles.itemRow, { borderColor: colors.border }]}>
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{category.Name}</Text>
                  <Text style={[styles.itemMeta, { color: colors.textMuted }]}>{getTransactionTypeLabel(transactionType)}</Text>
                </View>
                <Pressable
                  accessibilityLabel={`Change color for ${category.Name}`}
                  accessibilityRole="button"
                  onPress={() => openColorPicker(category)}
                  testID={`manageCategories.color.${category.Name}`}
                  style={styles.rowAction}>
                  <FontAwesome name="paint-brush" size={17} color={category.HexColor} />
                </Pressable>
                {protectedCategory ? (
                  <>
                    <Pressable
                      accessibilityLabel={`Edit ${category.Name}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: true }}
                      disabled
                      testID={`manageCategories.edit.${category.Name}`}
                      style={styles.rowAction}>
                      <FontAwesome name="pencil" size={18} color={colors.buttonDisabled} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Delete ${category.Name}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: true }}
                      disabled
                      testID={`manageCategories.delete.${category.Name}`}
                      style={styles.rowAction}>
                      <FontAwesome name="trash" size={18} color={colors.buttonDisabled} />
                    </Pressable>
                  </>
                ) : (
                  <>
                    <Pressable
                      accessibilityLabel={`Edit ${category.Name}`}
                      accessibilityRole="button"
                      onPress={() => openForm(category)}
                      testID={`manageCategories.edit.${category.Name}`}
                      style={styles.rowAction}>
                      <FontAwesome name="pencil" size={18} color={colors.text} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`Delete ${category.Name}`}
                      accessibilityRole="button"
                      onPress={() => openDelete(category)}
                      testID={`manageCategories.delete.${category.Name}`}
                      style={styles.rowAction}>
                      <FontAwesome name="trash" size={18} color={colors.dangerText} />
                    </Pressable>
                  </>
                )}
              </View>
            );
          })}
          {loading ? <LoadingSpinner /> : null}
          {!loading && filteredCategories.length === 0 ? <Text style={[styles.emptyText, { color: colors.textMuted }]}>No categories found.</Text> : null}
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
              <ScrollView
                contentContainerStyle={styles.formModalContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                {...categoryFormScroll.scrollViewProps}
                style={styles.formModalScroll}>
                <Text style={styles.modalTitle}>{editingCategory ? 'Edit Category' : 'Add Category'}</Text>
                <TextField label="Name:" onChangeText={setName} testID="manageCategories.form.name" value={name} />
                <SelectField
                  disabled={editingCategory !== null}
                  label="Transaction Type:"
                  onPress={() => setTransactionTypePickerOpen(true)}
                  placeholder="Select transaction type"
                  testID="manageCategories.form.type"
                  value={getTransactionTypeLabel(selectedTransactionType)}
                />
                <Text style={styles.fieldLabel}>Color:</Text>
                <CategoryColorPicker color={hexColor} onColorChange={handleFormColorChange} testIDPrefix="manageCategories.form" />
                <View style={styles.modalActions}>
                  <Button disabled={saving} onPress={closeForm} size="small" testID="manageCategories.form.cancel">
                    Cancel
                  </Button>
                  <Button disabled={saving} onPress={saveCategory} size="small" testID="manageCategories.form.save" variant="primary">
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </View>
              </ScrollView>
              {/* Deliberately OUTSIDE the ScrollView. Mounting these inside it
                  changed the scroll content's height, and because saveCategory
                  clears the error before re-checking, a repeat press unmounted
                  the popup, let RN clamp contentOffset down, then re-mounted it —
                  scrolling the user back to the top of the form. Out here the
                  message is also visible whatever the scroll position is. */}
              {categoryFormError.message ? (
                <View style={styles.formModalFooter}>
                  <Popup
                    detail={categoryFormError.detail} message={categoryFormError.message}
                    onClose={() => setCategoryFormError('')}
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
                    message={`You previously had a category named "${removedNameWarning}" that was removed. Transactions kept on it still show that name.`}
                    onCancel={() => setRemovedNameWarning('')}
                    onConfirm={commitCategory}
                    title="Name used before"
                    variant="warning"
                  />
                </View>
              ) : null}
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <Modal animationType="fade" transparent visible={colorCategory !== null} onRequestClose={closeColorPicker}>
        <ModalKeyboardAvoider>
          <View style={styles.modalBackdrop}>
            <Pressable style={styles.modalBackdropPressable} onPress={closeColorPicker} />
            {/* Same scroll layout as the Add/Edit Category form: the picker plus
                the Hex/HSL fields are too tall to fit above the keyboard, so the
                panel shrinks and its content scrolls. The error sits outside the
                ScrollView for the same reason as there. */}
            <View style={[styles.formModalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <ScrollView
                contentContainerStyle={styles.formModalContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                {...colorModalScroll.scrollViewProps}
                style={styles.formModalScroll}>
                <Text style={styles.modalTitle}>Change Color</Text>
                <Text style={styles.modalText}>{colorCategory?.Name}</Text>
                <CategoryColorPicker
                  color={colorHex}
                  onColorChange={handleStandaloneColorChange}
                  testIDPrefix="manageCategories.colorForm"
                />
                <View style={styles.modalActions}>
                  <Button disabled={saving} onPress={closeColorPicker} size="small" testID="manageCategories.colorForm.cancel">
                    Cancel
                  </Button>
                  <Button disabled={saving} onPress={saveCategoryColor} size="small" testID="manageCategories.colorForm.save" variant="primary">
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </View>
              </ScrollView>
              {categoryColorError.message ? (
                <View style={styles.formModalFooter}>
                  <Popup
                    detail={categoryColorError.detail} message={categoryColorError.message}
                    onClose={() => setCategoryColorError('')}
                    variant="danger"
                  />
                </View>
              ) : null}
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      <PickerModal
        items={[
          { id: 'all', label: 'All' },
          { id: 'income', label: 'Income' },
          { id: 'outcome', label: 'Spending' },
        ]}
        onClose={() => setFilterOpen(false)}
        onSelect={(item) => {
          setFilter(item.id as FilterValue);
          setFilterOpen(false);
        }}
        selectedId={filter}
        title="Filter Categories"
        visible={filterOpen}
      />

      <PickerModal
        items={transactionTypes.map((transactionType) => ({
          id: transactionType.Id,
          label: getTransactionTypeLabel(transactionType),
        }))}
        onClose={() => setTransactionTypePickerOpen(false)}
        onSelect={(item) => {
          setTransactionTypeId(Number(item.id));
          setTransactionTypePickerOpen(false);
        }}
        selectedId={transactionTypeId}
        title="Transaction Type"
        visible={transactionTypePickerOpen}
      />

      <Modal animationType="fade" transparent visible={deletingCategory !== null} onRequestClose={closeDelete}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={closeDelete} />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Remove Category</Text>
            <Text style={styles.modalText}>
              {usageCount > 0
                ? `${usageCount} ${usageCount === 1 ? 'transaction uses' : 'transactions use'} this ${getTransactionTypeLabel(deletingTransactionType).toLowerCase()} category.\n${
                    replacementOptions.length > 0
                      ? 'You can choose a replacement to update the category for these transactions or keep them unchanged as history.'
                      : 'Removing this will not remove those transactions and they will keep this category.'
                  }`
                : 'This category will be removed from future selection.'}
            </Text>
            {usageCount > 0 && replacementOptions.length > 0 ? (
              <SelectField
                label="Move existing data to:"
                onPress={() => setReplacementPickerOpen(true)}
                placeholder="Select replacement"
                testID="manageCategories.delete.replacement"
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
              <Button disabled={saving} onPress={closeDelete} size="small" testID="manageCategories.deleteCancel">
                Cancel
              </Button>
              <Button disabled={saving} onPress={confirmDelete} size="small" testID="manageCategories.deleteConfirm" variant="danger">
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

type CategoryColorPickerProps = {
  color: string;
  onColorChange: (color: ColorFormatsObject) => void;
  // Maestro ID prefix for the Hex and H/S/L inputs: `<prefix>.hex`, `<prefix>.h`, ...
  testIDPrefix: string;
};

function CategoryColorPicker({ color, onColorChange, testIDPrefix }: CategoryColorPickerProps) {
  const { colors } = useAppTheme();
  const [hexText, setHexText] = useState(normalizeHexColor(color));
  const [hslText, setHslText] = useState(() => {
    const hsl = getHslFromHex(color);
    return {
      h: hsl.h.toString(),
      s: hsl.s.toString(),
      l: hsl.l.toString(),
    };
  });

  useEffect(() => {
    const normalizedHex = normalizeHexColor(color);
    const hsl = getHslFromHex(normalizedHex);

    setHexText(normalizedHex);
    setHslText({
      h: hsl.h.toString(),
      s: hsl.s.toString(),
      l: hsl.l.toString(),
    });
  }, [color]);

  const handlePickerChange = (nextColor: ColorFormatsObject) => {
    onColorChange(nextColor);
  };

  const handleHexTextChange = (value: string) => {
    const cleanedValue = value.replace(/[^0-9a-fA-F#]/g, '').slice(0, 7);
    const nextHexText = cleanedValue.startsWith('#') ? cleanedValue : `#${cleanedValue}`;

    setHexText(nextHexText.toUpperCase());

    const normalizedHex = normalizeHexColor(nextHexText);
    if (isHexColor(normalizedHex)) {
      onColorChange({
        hex: normalizedHex,
        rgb: '',
        rgba: '',
        hsl: '',
        hsla: '',
        hsv: '',
        hsva: '',
        hwb: '',
        hwba: '',
      });
    }
  };

  const handleHslTextChange = (channel: 'h' | 's' | 'l', value: string) => {
    const limit = channel === 'h' ? 360 : 100;
    const cleanedValue = value.replace(/\D/g, '').slice(0, 3);
    const nextHslText = {
      ...hslText,
      [channel]: cleanedValue,
    };

    setHslText(nextHslText);

    if (!nextHslText.h || !nextHslText.s || !nextHslText.l) {
      return;
    }

    const h = clampNumber(Number(nextHslText.h), 0, 360);
    const s = clampNumber(Number(nextHslText.s), 0, 100);
    const l = clampNumber(Number(nextHslText.l), 0, 100);
    const nextHex = hslToHex(h === 360 ? 0 : h, s, l);

    if (Number(cleanedValue) > limit) {
      setHslText((current) => ({ ...current, [channel]: limit.toString() }));
    }

    onColorChange({
      hex: nextHex,
      rgb: '',
      rgba: '',
      hsl: '',
      hsla: '',
      hsv: '',
      hsva: '',
      hwb: '',
      hwba: '',
    });
  };

  return (
    <ColorPicker
      boundedThumb
      onChangeJS={handlePickerChange}
      sliderThickness={18}
      style={styles.colorPicker}
      thumbShape="ring"
      thumbSize={24}
      value={normalizeHexColor(color)}>
      <Panel1 style={styles.colorPanel} />
      <HueSlider style={styles.colorSlider} />
      <Swatches colors={colorOptions} style={styles.colorSwatches} swatchStyle={styles.colorSwatch} />
      <View style={[styles.colorPreview, { borderColor: colors.border }]}>
        <TextField
          autoCapitalize="characters"
          label="Hex:"
          onChangeText={handleHexTextChange}
          testID={`${testIDPrefix}.hex`}
          value={hexText}
        />
        <View style={styles.hslInputRow}>
          {(['h', 's', 'l'] as const).map((channel) => (
            <View key={channel} style={styles.hslInputGroup}>
              <Text style={styles.colorInputLabel}>{channel.toUpperCase()}</Text>
              <TextInput
                keyboardType="number-pad"
                inputMode="numeric"
                onChangeText={(value) => handleHslTextChange(channel, value)}
                style={[styles.hslInput, { borderColor: colors.border, color: colors.text }]}
                testID={`${testIDPrefix}.${channel}`}
                value={hslText[channel]}
              />
            </View>
          ))}
        </View>
      </View>
    </ColorPicker>
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
  colorPanel: {
    borderRadius: 8,
    height: 160,
    overflow: 'hidden',
  },
  colorPicker: {
    marginBottom: 15,
    width: '100%',
  },
  colorInputLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 5,
  },
  colorPreview: {
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 10,
  },
  colorSlider: {
    borderRadius: 9,
    height: 18,
    marginTop: 14,
  },
  colorSwatch: {
    borderRadius: 14,
    height: 28,
    width: 28,
  },
  colorSwatches: {
    justifyContent: 'space-between',
    marginTop: 14,
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
  fieldLabel: {
    fontSize: 18,
    marginBottom: 8,
  },
  filterButton: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 22,
    minHeight: 50,
    paddingHorizontal: 12,
  },
  filterText: {
    fontSize: 18,
  },
  formModalContent: {
    padding: 16,
  },
  formModalFooter: {
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  // flexShrink lets the scroll area give up height to the footer once an error
  // or warning appears, instead of pushing it past the panel's maxHeight.
  formModalScroll: {
    flexShrink: 1,
  },
  // flexShrink lets the panel give up height when the keyboard opens instead
  // of overflowing past the top of the screen. The room itself comes from
  // either Android shrinking the Modal window (Expo Go) or
  // ModalKeyboardAvoider's padding (edge-to-edge builds, where the window is
  // not resized). Do NOT add a plain KeyboardAvoidingView inside a modal: in
  // Expo Go it makes room a second time and the panel visibly moves twice.
  formModalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 1,
    maxHeight: '92%',
    maxWidth: 390,
    width: '92%',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  hslInput: {
    borderRadius: 5,
    borderWidth: 1,
    fontSize: 16,
    height: 42,
    paddingHorizontal: 10,
    textAlign: 'center',
  },
  hslInputGroup: {
    flex: 1,
  },
  hslInputRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
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
    paddingTop: 12,
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
