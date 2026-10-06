import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import Button from '@/components/themed/Button';
import CalendarPickerModal from '@/components/themed/CalendarPickerModal';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { FieldLabel, MoneyField, QuantityField, SelectField, TextField } from '@/components/themed/fields';
import { Currency } from '@/database/tables/currencies';
import {
  ADJUSTMENT_NOTE_MAX_LENGTH,
  insertInvestmentAdjustment,
  InvestmentHistory,
  updateInvestmentAdjustment,
} from '@/database/tables/investmentHistories';
import { Investment } from '@/database/tables/investments';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useKeepFocusedInputVisible } from '@/hooks/useKeepFocusedInputVisible';
import { formatDbDate, parseDbDate } from '@/utils/dbDate';
import {
  formatQuantity,
  formatQuantityToInput,
  formatUnitValue,
  formatUnitValueToInput,
  getQuantityPrecisionError,
  getUnitValueCurrency,
  parseQuantityInput,
  parseUnitValueInput,
  quantityInputHasValidPrecision,
} from '@/utils/investmentNumbers';
import { getMoneyPrecisionError, moneyInputHasValidPrecision } from '@/utils/moneyInput';
import { useErrorState } from '@/hooks/useErrorState';
import ModalKeyboardAvoider from '@/components/themed/ModalKeyboardAvoider';

type Direction = 'add' | 'remove';

type InvestmentAdjustModalProps = {
  // Present when editing an existing adjustment; absent when adding one.
  adjustment?: InvestmentHistory | null;
  currency?: Currency;
  investment: Investment | null;
  onClose: () => void;
  // Called after a successful save or delete, with a short success message.
  onSaved: (message: string) => void;
  visible: boolean;
};

const formatDisplayDate = (date: Date) =>
  date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

// One dated change to an investment that no transaction moved: units gained or
// lost without money (gifts, bonus units, fees taken in units, splits,
// corrections) and/or a new value per unit. Leaving the value empty carries
// over the price in effect on that date. A split is entered by hand as both:
// +4 per unit held for 1:5, and the new price.
export default function InvestmentAdjustModal({
  adjustment = null,
  currency,
  investment,
  onClose,
  onSaved,
  visible,
}: InvestmentAdjustModalProps) {
  const { colors } = useAppTheme();
  const formScroll = useKeepFocusedInputVisible();
  const [date, setDate] = useState(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>('add');
  const [quantity, setQuantity] = useState('');
  const [unitValue, setUnitValue] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Errors render inside the modal: a screen-level popup sits behind an open
  // RN Modal and cannot be seen.
  const [formError, setFormError] = useErrorState();

  const quantityDecimals = investment?.QuantityDecimals ?? 0;
  const unitValueCurrency = getUnitValueCurrency(currency);
  const isEditing = adjustment !== null;

  // Fresh form on every open: prefilled from the adjustment when editing.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setFormError('');
    setSaving(false);
    if (adjustment) {
      setDate(parseDbDate(adjustment.CreatedAt));
      setDirection(adjustment.QuantityDelta < 0 ? 'remove' : 'add');
      setQuantity(
        adjustment.QuantityDelta === 0 ? '' : formatQuantityToInput(Math.abs(adjustment.QuantityDelta), quantityDecimals)
      );
      setUnitValue(formatUnitValueToInput(adjustment.UnitValue, currency));
      setNote(adjustment.Note ?? '');
    } else {
      setDate(new Date());
      setDirection('add');
      setQuantity('');
      setUnitValue('');
      setNote('');
    }
    // Only re-seed when the modal opens or the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, adjustment?.Id]);

  const close = () => {
    if (!saving) {
      onClose();
    }
  };

  const save = async () => {
    if (!investment) {
      return;
    }
    setFormError('');

    if (!quantityInputHasValidPrecision(quantity, quantityDecimals)) {
      setFormError(getQuantityPrecisionError(quantityDecimals));
      return;
    }
    const quantityMagnitude = quantity ? parseQuantityInput(quantity, quantityDecimals) : 0;
    if (quantityMagnitude === null) {
      setFormError('Quantity change is not valid.');
      return;
    }

    if (unitValue && !moneyInputHasValidPrecision(unitValue, unitValueCurrency)) {
      setFormError(getMoneyPrecisionError(unitValueCurrency));
      return;
    }
    const parsedUnitValue = unitValue ? parseUnitValueInput(unitValue, currency) : null;
    if (unitValue && parsedUnitValue === null) {
      setFormError('Value per unit is not valid.');
      return;
    }

    const input = {
      date: formatDbDate(date),
      note: note || null,
      quantityDelta: direction === 'remove' ? -quantityMagnitude : quantityMagnitude,
      unitValue: parsedUnitValue,
    };

    setSaving(true);
    const result = adjustment
      ? await updateInvestmentAdjustment(adjustment.Id, input)
      : await insertInvestmentAdjustment(investment.Id, input);
    setSaving(false);

    if (result.Status === 'Success') {
      onSaved(adjustment ? 'Adjustment updated.' : 'Adjustment saved.');
      return;
    }
    setFormError(result.Message ?? 'Failed to save the adjustment.', result.Detail);
  };

  const unitLabel = investment?.Unit ?? 'unit(s)';

  return (
    <>
      <Modal animationType="fade" transparent visible={visible} onRequestClose={close}>
        <ModalKeyboardAvoider>
          <View style={styles.backdrop}>
            <Pressable style={styles.backdropPressable} onPress={close} />
            <View style={[styles.panel, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                {...formScroll.scrollViewProps}
                style={styles.scroll}>
                <Text style={styles.title}>{isEditing ? 'Edit Adjustment' : 'Adjust'} {investment?.Name ?? ''}</Text>
                {investment ? (
                  <Text style={[styles.current, { color: colors.textMuted }]}>
                    Currently {formatQuantity(investment.Quantity, quantityDecimals)} {unitLabel} at{' '}
                    {formatUnitValue(investment.UnitValue, currency)} per unit
                  </Text>
                ) : null}

                <SelectField
                  label="Date:"
                  onPress={() => setCalendarOpen(true)}
                  placeholder="Select date"
                  testID="investmentAdjust.date"
                  value={formatDisplayDate(date)}
                />

                <FieldLabel label="Quantity Change:" />
                <View style={styles.directionRow}>
                  <Button
                    onPress={() => setDirection('add')}
                    size="small"
                    style={[styles.directionButton, direction === 'add' && styles.directionSelected]}
                    testID="investmentAdjust.add"
                    variant={direction === 'add' ? 'primary' : 'default'}>
                    Add
                  </Button>
                  <Button
                    onPress={() => setDirection('remove')}
                    size="small"
                    style={[styles.directionButton, direction === 'remove' && styles.directionSelected]}
                    testID="investmentAdjust.remove"
                    variant={direction === 'remove' ? 'danger' : 'default'}>
                    Remove
                  </Button>
                </View>
                <QuantityField
                  decimals={quantityDecimals}
                  label={`${direction === 'add' ? 'Units Added' : 'Units Removed'}:`}
                  onChangeText={setQuantity}
                  placeholder="0 (no change)"
                  testID="investmentAdjust.quantity"
                  value={quantity}
                />

                <MoneyField
                  currency={unitValueCurrency}
                  label="New Value Per Unit:"
                  onChangeText={setUnitValue}
                  placeholder="Leave empty to keep the price"
                  testID="investmentAdjust.unitValue"
                  value={unitValue}
                />

                <TextField
                  label="Note:"
                  maxLength={ADJUSTMENT_NOTE_MAX_LENGTH}
                  onChangeText={setNote}
                  placeholder="Optional (e.g. bonus shares, split 1:5)"
                  testID="investmentAdjust.note"
                  value={note}
                />

                {/* Deleting is done from the history rows' trash button. */}
                <View style={styles.actions}>
                  <Button disabled={saving} onPress={close} size="small" testID="investmentAdjust.cancel">
                    Cancel
                  </Button>
                  <Button disabled={saving} onPress={save} size="small" testID="investmentAdjust.save" variant="primary">
                    {saving ? 'Saving...' : 'Save'}
                  </Button>
                </View>
              </ScrollView>
              {formError.message ? (
                <View style={styles.footer}>
                  <Popup detail={formError.detail} message={formError.message} onClose={() => setFormError('')} variant="danger" />
                </View>
              ) : null}
            </View>
          </View>
        </ModalKeyboardAvoider>
      </Modal>

      {/* A sibling, like the other pickers opened from a form modal. */}
      <CalendarPickerModal
        onClose={() => setCalendarOpen(false)}
        onSelect={setDate}
        value={date}
        visible={calendarOpen}
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  backdropPressable: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  content: {
    padding: 16,
  },
  current: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  directionButton: {
    flex: 1,
  },
  directionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  directionSelected: {
    borderWidth: 2,
  },
  footer: {
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  panel: {
    borderRadius: 8,
    borderWidth: 1,
    flexShrink: 1,
    maxHeight: '92%',
    maxWidth: 390,
    width: '92%',
  },
  scroll: {
    flexShrink: 1,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 6,
  },
});
