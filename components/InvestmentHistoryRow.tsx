import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Pressable, StyleSheet, View } from 'react-native';

import Text from '@/components/themed/Text';
import { getInvestmentHistoryKindLabel, InvestmentHistory } from '@/database/tables/investmentHistories';
import { useAppTheme } from '@/hooks/useAppTheme';
import { parseDbDate } from '@/utils/dbDate';

const formatDisplayDate = (rawDate: string | Date) =>
  parseDbDate(rawDate).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

// Same layout as Account Transactions' TransactionRow: kind, date and note on the
// left; the figure and, for adjustments only, edit/delete on the right.
export default function InvestmentHistoryRow({
  amount,
  amountColor,
  history,
  index,
  onDelete,
  onEdit,
  testIDPrefix,
}: {
  amount: string;
  amountColor?: string;
  history: InvestmentHistory;
  index: number;
  onDelete?: () => void;
  onEdit?: () => void;
  testIDPrefix: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View collapsable={false} style={[styles.row, { borderColor: colors.border }]} testID={`${testIDPrefix}.row.${index}`}>
      <View style={styles.rowText}>
        <Text style={styles.kind} testID={`${testIDPrefix}.row.${index}.kind`}>
          {getInvestmentHistoryKindLabel(history)}
        </Text>
        <Text style={[styles.date, { color: colors.textMuted }]}>{formatDisplayDate(history.CreatedAt)}</Text>
        {history.Note ? <Text style={[styles.note, { color: colors.textMuted }]}>{history.Note}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.amount, { color: amountColor ?? colors.text }]} testID={`${testIDPrefix}.row.${index}.amount`}>
          {amount}
        </Text>
        {onEdit || onDelete ? (
          <View style={styles.rowActions}>
            {onEdit ? (
              <Pressable
                accessibilityLabel="Edit adjustment"
                accessibilityRole="button"
                onPress={onEdit}
                testID={`${testIDPrefix}.edit.${index}`}
                style={({ pressed }) => [styles.rowActionButton, pressed && styles.pressed]}>
                <FontAwesome name="pencil" size={16} color={colors.text} />
              </Pressable>
            ) : null}
            {onDelete ? (
              <Pressable
                accessibilityLabel="Delete adjustment"
                accessibilityRole="button"
                onPress={onDelete}
                testID={`${testIDPrefix}.delete.${index}`}
                style={({ pressed }) => [styles.rowActionButton, pressed && styles.pressed]}>
                <FontAwesome name="trash-o" size={16} color={colors.dangerText} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  amount: {
    fontSize: 16,
    fontWeight: '600',
    paddingLeft: 10,
    textAlign: 'right',
  },
  date: {
    fontSize: 13,
    marginTop: 2,
  },
  kind: {
    fontSize: 16,
    fontWeight: '600',
  },
  note: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 4,
  },
  pressed: {
    opacity: 0.65,
  },
  row: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingVertical: 14,
  },
  rowActionButton: {
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 6,
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  rowText: {
    flex: 1,
  },
});
