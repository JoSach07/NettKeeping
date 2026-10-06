import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import Text from '@/components/themed/Text';
import { useAppTheme } from '@/hooks/useAppTheme';
import { formatDbDate } from '@/utils/dbDate';

type CalendarPickerModalProps = {
  // Future days are shown but cannot be picked, matching the rule on every
  // write path (see isFutureTransactionDate).
  disableFuture?: boolean;
  onClose: () => void;
  onSelect: (date: Date) => void;
  value: Date;
  visible: boolean;
};

// Month calendar used by Create Transaction and InvestmentAdjustModal.
// Days are built from local parts and compared as 'YYYY-MM-DD' strings, never
// via toISOString, which shifts the day east of UTC.
export default function CalendarPickerModal({
  disableFuture = true,
  onClose,
  onSelect,
  value,
  visible,
}: CalendarPickerModalProps) {
  const { colors } = useAppTheme();
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));

  // Reopening shows the month of the current value, not wherever the user
  // last browsed to.
  useEffect(() => {
    if (visible) {
      setMonth(new Date(value.getFullYear(), value.getMonth(), 1));
    }
  }, [value, visible]);

  const days = useMemo(() => {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const firstDay = new Date(year, monthIndex, 1).getDay();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    return [
      ...Array.from({ length: firstDay }, () => null),
      ...Array.from({ length: daysInMonth }, (_, index) => new Date(year, monthIndex, index + 1)),
    ];
  }, [month]);

  const today = formatDbDate(new Date());
  const selected = formatDbDate(value);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.calendar, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Previous month"
              accessibilityRole="button"
              onPress={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
              style={styles.arrow}
              testID="calendar.prev">
              <FontAwesome name="angle-left" size={22} color={colors.text} />
            </Pressable>
            <Text style={styles.title} testID="calendar.title">{month.toLocaleString('default', { month: 'long', year: 'numeric' })}</Text>
            <Pressable
              accessibilityLabel="Next month"
              accessibilityRole="button"
              onPress={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
              style={styles.arrow}
              testID="calendar.next">
              <FontAwesome name="angle-right" size={22} color={colors.text} />
            </Pressable>
          </View>

          <View style={styles.weekRow}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
              <Text key={`${day}-${index}`} style={styles.weekDay}>
                {day}
              </Text>
            ))}
          </View>

          <View style={styles.daysGrid}>
            {days.map((day, index) => {
              if (!day) {
                return <View key={`empty-${index}`} style={styles.dayButton} />;
              }
              const dayText = formatDbDate(day);
              const isDisabled = disableFuture && dayText > today;
              return (
                <Pressable
                  key={dayText}
                  disabled={isDisabled}
                  testID={`calendar.day.${day.getDate()}`}
                  onPress={() => {
                    onSelect(day);
                    onClose();
                  }}
                  style={[
                    styles.dayButton,
                    isDisabled && styles.dayDisabled,
                    dayText === selected && { backgroundColor: colors.buttonPrimaryHighlighted },
                  ]}>
                  <Text style={styles.dayText}>{day.getDate()}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  arrow: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  calendar: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 340,
    padding: 16,
    width: '88%',
  },
  dayButton: {
    alignItems: 'center',
    aspectRatio: 1,
    borderRadius: 6,
    justifyContent: 'center',
    width: `${100 / 7}%`,
  },
  dayDisabled: {
    opacity: 0.3,
  },
  dayText: {
    fontSize: 18,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  weekDay: {
    fontSize: 16,
    textAlign: 'center',
    width: `${100 / 7}%`,
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
});
