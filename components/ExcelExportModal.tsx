import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import Button from '@/components/themed/Button';
import Text from '@/components/themed/Text';
import MonthYearPickerField from '@/components/MonthYearPickerField';
import { useAppTheme } from '@/hooks/useAppTheme';
import { ExcelExportPeriod, ExcelExportScope, exportExcelReport } from '@/utils/excelExport';

type ExportMode = 'yearly' | 'monthly';

type ExcelExportModalProps = {
  onClose: () => void;
  onResult: (
    message: string,
    variant: 'danger' | 'success' | 'warning',
    title?: string,
    // Raw technical text for the popup's Details toggle, absent on success and
    // on failures that were already phrased for the user.
    detail?: string
  ) => void;
  scope: ExcelExportScope | null;
  visible: boolean;
};

export default function ExcelExportModal({ onClose, onResult, scope, visible }: ExcelExportModalProps) {
  const { colors } = useAppTheme();
  const today = useMemo(() => new Date(), []);
  const [mode, setMode] = useState<ExportMode>('yearly');
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [exporting, setExporting] = useState(false);
  // Read at render, not memoised, so a modal left mounted across New Year
  // still caps at the real current year. Same rule as MonthYearPickerField.
  const now = new Date();
  const maxYear = now.getFullYear();
  const maxMonth = now.getMonth() + 1;

  // Month and year are shared by both modes, so stepping the year up in
  // Yearly can drag a remembered month into the future (December 2025 ->
  // Yearly 2026 -> back to Monthly = December 2026). Clamp it here.
  const handleYearChange = (nextYear: number) => {
    const cappedYear = Math.min(nextYear, maxYear);
    setYear(cappedYear);
    if (cappedYear === maxYear && month > maxMonth) {
      setMonth(maxMonth);
    }
  };

  const handleExport = async () => {
    if (!scope || exporting) {
      return;
    }

    setExporting(true);
    const period: ExcelExportPeriod = mode === 'yearly'
      ? { kind: 'yearly', year }
      : { kind: 'monthly', month, year };
    const result = await exportExcelReport(period, scope);
    setExporting(false);

    if (result.Status === 'Cancelled') {
      return;
    }

    if (result.Status === 'Success') {
      onResult('Excel report exported.', 'success', 'Export complete');
      onClose();
      return;
    }

    onResult(result.Message ?? 'Failed to export Excel report.', 'danger', undefined, result.Detail);
  };

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalBackdropPressable} onPress={onClose} />
        <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Export Excel</Text>
            <Pressable accessibilityLabel="Close export dialog" accessibilityRole="button" onPress={onClose} style={styles.closeButton} testID="excelExport.close">
              <FontAwesome name="times" size={18} color={colors.text} />
            </Pressable>
          </View>

          <View style={styles.modeRow}>
            <Button
              onPress={() => setMode('yearly')}
              size="small"
              style={[styles.modeButton, mode === 'yearly' && { borderWidth: 2 }]}
              testID="excelExport.mode.yearly"
              variant={mode === 'yearly' ? 'primary' : 'default'}>
              Yearly
            </Button>
            <Button
              onPress={() => setMode('monthly')}
              size="small"
              style={[styles.modeButton, mode === 'monthly' && { borderWidth: 2 }]}
              testID="excelExport.mode.monthly"
              variant={mode === 'monthly' ? 'primary' : 'default'}>
              Monthly
            </Button>
          </View>

          {mode === 'monthly' ? (
            <MonthYearPickerField
              label="Month"
              month={month}
              onChange={(nextMonth, nextYear) => {
                setMonth(nextMonth);
                setYear(nextYear);
              }}
              testID="excelExport.month"
              year={year}
            />
          ) : (
            <YearStepper maxYear={maxYear} onChange={handleYearChange} value={year} />
          )}

          <Text style={[styles.helperText, { color: colors.textMuted }]}>
            Current year and current month exports include data up to today.
          </Text>

          <View style={styles.actions}>
            <Button disabled={exporting} onPress={onClose} size="small" testID="excelExport.cancel">
              Cancel
            </Button>
            <Button disabled={exporting} onPress={handleExport} size="small" testID="excelExport.confirm" variant="primary">
              {exporting ? 'Exporting...' : 'Export'}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Future years are refused: the export caps its range at today, so a future
// year would produce a start date after the end date and an empty report.
function YearStepper({ maxYear, onChange, value }: { maxYear: number; onChange: (value: number) => void; value: number }) {
  const { colors } = useAppTheme();
  const canGoNext = value < maxYear;

  return (
    <View style={[styles.yearStepper, { borderColor: colors.border }]}>
      <Pressable accessibilityLabel="Previous year" accessibilityRole="button" onPress={() => onChange(value - 1)} style={styles.yearButton} testID="excelExport.prevYear">
        <FontAwesome name="angle-left" size={24} color={colors.text} />
      </Pressable>
      <Text style={styles.yearText}>{value}</Text>
      <Pressable
        accessibilityLabel="Next year"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canGoNext }}
        disabled={!canGoNext}
        onPress={() => onChange(value + 1)}
        style={[styles.yearButton, !canGoNext && styles.disabled]}
        testID="excelExport.nextYear">
        <FontAwesome name="angle-right" size={24} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
  },
  closeButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  disabled: {
    opacity: 0.45,
  },
  helperText: {
    fontSize: 14,
    lineHeight: 20,
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
  modalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalPanel: {
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 380,
    padding: 16,
    width: '92%',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
  },
  modeButton: {
    flex: 1,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  yearButton: {
    alignItems: 'center',
    height: 46,
    justifyContent: 'center',
    width: 52,
  },
  yearStepper: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  yearText: {
    fontSize: 20,
    fontWeight: '600',
  },
});
