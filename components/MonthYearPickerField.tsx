import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import Text from '@/components/themed/Text';
import { SelectField } from '@/components/themed/fields';
import { useAppTheme } from '@/hooks/useAppTheme';

type MonthYearPickerFieldProps = {
  label: string;
  month: number;
  onChange: (month: number, year: number) => void;
  // Prefix for the Maestro IDs: the field itself, plus `.prevYear`, `.nextYear`
  // and `.<1-12>` for the month buttons in the picker.
  testID?: string;
  year: number;
};

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const getMonthYearLabel = (month: number, year: number) => `${monthNames[month - 1]} ${year}`;

export default function MonthYearPickerField({ label, month, onChange, testID, year }: MonthYearPickerFieldProps) {
  const { colors } = useAppTheme();
  const today = new Date();
  const maxMonth = today.getMonth() + 1;
  const maxYear = today.getFullYear();
  const [open, setOpen] = useState(false);
  const [visibleYear, setVisibleYear] = useState(year);
  const canGoNext = visibleYear < maxYear;

  useEffect(() => {
    if (open) {
      setVisibleYear(year);
    }
  }, [open, year]);

  const chooseMonth = (nextMonth: number) => {
    if (visibleYear > maxYear || (visibleYear === maxYear && nextMonth > maxMonth)) {
      return;
    }

    onChange(nextMonth, visibleYear);
    setOpen(false);
  };

  return (
    <>
      <SelectField
        label={label}
        onPress={() => setOpen(true)}
        placeholder="Select month"
        testID={testID}
        value={getMonthYearLabel(month, year)}
      />

      <Modal animationType="fade" transparent visible={open} onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={() => setOpen(false)} />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.header}>
              <Pressable
                accessibilityLabel="Previous year"
                accessibilityRole="button"
                onPress={() => setVisibleYear((currentYear) => currentYear - 1)}
                testID={testID ? `${testID}.prevYear` : undefined}
                style={({ pressed }) => [styles.yearButton, pressed && styles.pressed]}>
                <FontAwesome name="angle-left" size={26} color={colors.text} />
              </Pressable>
              <Text style={styles.yearText}>{visibleYear}</Text>
              <Pressable
                accessibilityLabel="Next year"
                accessibilityRole="button"
                disabled={!canGoNext}
                onPress={() => setVisibleYear((currentYear) => Math.min(currentYear + 1, maxYear))}
                testID={testID ? `${testID}.nextYear` : undefined}
                style={({ pressed }) => [styles.yearButton, !canGoNext && styles.disabled, pressed && styles.pressed]}>
                <FontAwesome name="angle-right" size={26} color={colors.text} />
              </Pressable>
            </View>

            <View style={styles.monthGrid}>
              {monthNames.map((monthName, index) => {
                const monthNumber = index + 1;
                const disabled = visibleYear > maxYear || (visibleYear === maxYear && monthNumber > maxMonth);
                const selected = visibleYear === year && monthNumber === month;

                return (
                  <Pressable
                    accessibilityRole="button"
                    disabled={disabled}
                    key={monthName}
                    onPress={() => chooseMonth(monthNumber)}
                    testID={testID ? `${testID}.${monthNumber}` : undefined}
                    style={({ pressed }) => [
                      styles.monthButton,
                      {
                        backgroundColor: selected ? colors.buttonPrimaryBackground : colors.background,
                        borderColor: selected ? colors.buttonPrimaryBorder : colors.border,
                      },
                      disabled && styles.disabled,
                      pressed && styles.pressed,
                    ]}>
                    <Text style={[styles.monthText, disabled && { color: colors.textMuted }]}>{monthName.slice(0, 3)}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  disabled: {
    opacity: 0.45,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
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
  monthButton: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    width: '30.8%',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
  },
  monthText: {
    fontSize: 16,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.65,
  },
  yearButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  yearText: {
    fontSize: 22,
    fontWeight: '600',
  },
});
