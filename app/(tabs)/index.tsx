import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import CategoryDonut from '@/components/CategoryDonut';
import ExcelExportModal from '@/components/ExcelExportModal';
import LineChart from '@/components/LineChart';
import MonthYearPickerField from '@/components/MonthYearPickerField';
import Button from '@/components/themed/Button';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import PickerModal from '@/components/themed/PickerModal';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { SelectField } from '@/components/themed/fields';
import { Account, getAccounts } from '@/database/tables/accounts';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { Investment, getInvestments } from '@/database/tables/investments';
import { InvestmentHistory, getInvestmentHistoriesByInvestment } from '@/database/tables/investmentHistories';
import { CategoryTransactionSummary, getCategoryTransactionSummary } from '@/database/tables/transactions';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useSummaryMode } from '@/hooks/useSummaryMode';
import { ExcelExportScope } from '@/utils/excelExport';
import { formatUnitValue } from '@/utils/investmentNumbers';
import { formatCurrencyAmount } from '@/utils/moneyInput';
import { formatPercentage } from '@/utils/percentage';
import { buildInvestmentChartPoints } from '@/utils/chartPoints';
import { endOfDbDate, formatDbDate } from '@/utils/dbDate';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';

type InvestmentRange = '1w' | '1m' | 'ytd' | '1y';
type PickerMode = 'account' | 'investment' | null;
type PopupVariant = 'danger' | 'success' | 'warning';

const cardShadow = Platform.select({
  web: {
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
  },
  default: {
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { height: 1, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
  },
});

const getInvestmentRangeStart = (range: InvestmentRange) => {
  const today = new Date();

  if (range === '1w') {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  }

  if (range === '1m') {
    return new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
  }

  if (range === 'ytd') {
    return new Date(today.getFullYear(), 0, 1);
  }

  return new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
};

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors, leftHandedMode } = useAppTheme();
  const { setSummaryMode: setMode, summaryMode: mode } = useSummaryMode();
  const today = new Date();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [selectedInvestmentId, setSelectedInvestmentId] = useState<number | null>(null);
  const [investmentRange, setInvestmentRange] = useState<InvestmentRange>('1w');
  const [investmentHistories, setInvestmentHistories] = useState<InvestmentHistory[]>([]);
  const [investmentMessage, setInvestmentMessage] = useErrorState();
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [summaries, setSummaries] = useState<CategoryTransactionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useErrorState();
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [excelExportScope, setExcelExportScope] = useState<ExcelExportScope | null>(null);
  const [popup, setPopup] = useState<{ detail?: string; message: string; title?: string; variant: PopupVariant } | null>(null);

  const selectedAccount = accounts.find((account) => account.Id === selectedAccountId);
  const selectedCurrency = currencies.find((currency) => currency.Id === selectedAccount?.CurrencyId);
  const selectedInvestment = investments.find((investment) => investment.Id === selectedInvestmentId);
  const selectedInvestmentCurrency = currencies.find((currency) => currency.Id === selectedInvestment?.CurrencyId);
  // Value per unit, same as the first chart on the Investments screen.
  // Memoized: the chart recomputes whenever its points array changes identity.
  const investmentChartPoints = useMemo(
    () => buildInvestmentChartPoints(
      investmentHistories,
      (history) => history.UnitValue,
      getInvestmentRangeStart(investmentRange),
      new Date()
    ),
    [investmentHistories, investmentRange]
  );
  const positiveSummaries = summaries.filter((summary) => summary.Amount > 0);
  const total = positiveSummaries.reduce((sum, summary) => sum + summary.Amount, 0);
  const topSummaries = positiveSummaries.slice(0, 3);
  const otherAmount = positiveSummaries.slice(3).reduce((sum, summary) => sum + summary.Amount, 0);
  const summaryRows = otherAmount > 0
    ? [...topSummaries, { Amount: otherAmount, CategoryId: 0, CategoryName: 'Others', HexColor: colors.textMuted }]
    : topSummaries;

  const selectInvestmentRange = (range: InvestmentRange) => {
    setInvestmentHistories((current) => current.slice(-1));
    setInvestmentRange(range);
  };

  const loadBaseData = useCallback(async () => {
    setLoading(true);

    const [accountResult, currencyResult, investmentResult] = await Promise.all([
      getAccounts(),
      getCurrencies(),
      getInvestments(),
    ]);

    setLoading(false);

    if (accountResult.Status === 'Success') {
      setAccounts(accountResult.Data);
      setSelectedAccountId((currentId) => currentId ?? accountResult.Data[0]?.Id ?? null);
    } else {
      setMessage(accountResult.Message ?? 'Unable to load accounts.', accountResult.Detail);
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    } else {
      setMessage(currencyResult.Message ?? 'Unable to load currencies.', currencyResult.Detail);
    }

    if (investmentResult.Status === 'Success') {
      setInvestments(investmentResult.Data);
      setSelectedInvestmentId((currentId) => currentId ?? investmentResult.Data[0]?.Id ?? null);
    } else {
      setInvestmentMessage(investmentResult.Message ?? 'Unable to load investments.', investmentResult.Detail);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    if (!selectedAccountId) {
      setSummaries([]);
      return;
    }

    const result = await getCategoryTransactionSummary(selectedAccountId, selectedMonth, selectedYear, mode === 'income');
    if (result.Status === 'Success') {
      setSummaries(result.Data);
      setMessage('');
    } else {
      setSummaries([]);
      setMessage(result.Message ?? 'Unable to load category summary.', result.Detail);
    }
  }, [mode, selectedAccountId, selectedMonth, selectedYear]);

  const loadInvestmentHistory = useCallback(async () => {
    if (!selectedInvestmentId) {
      setInvestmentHistories([]);
      return;
    }

    const result = await getInvestmentHistoriesByInvestment(
      selectedInvestmentId,
      formatDbDate(getInvestmentRangeStart(investmentRange))
    );

    if (result.Status === 'Success') {
      setInvestmentHistories(result.Data);
      setInvestmentMessage('');
    } else {
      setInvestmentHistories([]);
      setInvestmentMessage(result.Message ?? 'Unable to load investment history.', result.Detail);
    }
  }, [investmentRange, selectedInvestmentId]);

  useEffect(() => {
    loadBaseData();
  }, [loadBaseData]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadInvestmentHistory();
  }, [loadInvestmentHistory]);

  const openBreakdown = () => {
    if (!selectedAccountId) {
      return;
    }

    router.push({
      pathname: '/categoryBreakdown',
      params: {
        accountId: selectedAccountId.toString(),
        month: selectedMonth.toString(),
        year: selectedYear.toString(),
      },
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: 24 }]}
        style={{ backgroundColor: colors.background }}>
        {/* Order matters: the spacer leads and the button trails, matching
            Accounts and Investments. headerReversed then moves the button to
            the left in left-handed mode instead of away from the thumb. */}
        <View style={[styles.header, leftHandedMode && styles.headerReversed]}>
          <View style={styles.headerSpacer} />
          <Text style={styles.title}>Home</Text>
          <Pressable
            accessibilityLabel="Export Excel report"
            accessibilityRole="button"
            onPress={() => setExcelExportScope({ kind: 'all' })}
            testID="home.export"
            style={({ pressed }) => [
              styles.iconButton,
              { borderColor: colors.border },
              pressed && styles.pressed,
            ]}>
            <FontAwesome name="download" size={18} color={colors.text} />
          </Pressable>
        </View>

        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <SelectField
            label="Account"
            onPress={() => setPickerMode('account')}
            testID="home.account"
            placeholder="Select account"
            value={selectedAccount?.Name}
          />
          <MonthYearPickerField
            label="Month"
            month={selectedMonth}
            onChange={(nextMonth, nextYear) => {
              setSelectedMonth(nextMonth);
              setSelectedYear(nextYear);
            }}
            testID="home.month"
            year={selectedYear}
          />

          <View style={styles.toggleRow}>
            <Button
              size="small"
              style={[styles.toggleButton, mode === 'spending' && { borderWidth: 2 }]}
              testID="home.mode.spending"
              textStyle={styles.toggleText}
              variant="danger"
              onPress={() => setMode('spending')}>
              Spending
            </Button>
            <Button
              size="small"
              style={[styles.toggleButton, mode === 'income' && { borderWidth: 2 }]}
              testID="home.mode.income"
              textStyle={styles.toggleText}
              variant="success"
              onPress={() => setMode('income')}>
              Income
            </Button>
          </View>

          <View collapsable={false} testID="home.donut">
          <CategoryDonut
            items={positiveSummaries.map((summary) => ({
              amount: summary.Amount,
              color: summary.HexColor,
              label: summary.CategoryName,
            }))}
            subtitle={mode === 'income' ? 'Income' : 'Spending'}
            title={formatCurrencyAmount(total, selectedCurrency)}
          />
          </View>

          {loading ? <LoadingSpinner /> : null}
          {!loading && message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}
          {!loading && !message.message && !selectedAccountId ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>Add an account to see your breakdown.</Text>
          ) : null}
          {!loading && !message.message && selectedAccountId && summaryRows.length === 0 ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>No {mode} recorded for this month.</Text>
          ) : null}

          <View style={styles.summaryList}>
            {summaryRows.map((summary) => (
              <View
                collapsable={false}
                key={summary.CategoryId || 'others'}
                style={styles.summaryRow}
                testID={`home.breakdown.row.${summary.CategoryName}`}>
                <View style={styles.summaryHeader}>
                  <View style={styles.categoryNameWrap}>
                    <View style={[styles.colorDot, { backgroundColor: summary.HexColor }]} />
                    <Text style={styles.categoryName}>{summary.CategoryName}</Text>
                  </View>
                  <Text style={styles.percentage}>{formatPercentage(summary.Amount, total)}</Text>
                </View>
                <Text style={[styles.amount, { color: colors.textMuted }]}>{formatCurrencyAmount(summary.Amount, selectedCurrency)}</Text>
              </View>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={!selectedAccountId}
            onPress={openBreakdown}
            testID="home.breakdown.viewAll"
            style={({ pressed }) => [styles.viewAll, pressed && styles.pressed, !selectedAccountId && styles.disabled]}>
            <Text style={[styles.viewAllText, { color: colors.tint }]}>View All</Text>
            <FontAwesome name="angle-right" size={18} color={colors.tint} />
          </Pressable>
        </View>

        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <SelectField
            label="Investment"
            onPress={() => setPickerMode('investment')}
            testID="home.investment"
            placeholder="Select investment"
            value={selectedInvestment?.Name}
          />

          <View style={styles.rangeRow}>
            {(['1w', '1m', 'ytd', '1y'] as InvestmentRange[]).map((range) => (
              <Button
                key={range}
                onPress={() => selectInvestmentRange(range)}
                size="small"
                style={[styles.rangeButton, investmentRange === range && { borderWidth: 2 }]}
                testID={`home.range.${range}`}
                textStyle={styles.rangeText}
                variant={investmentRange === range ? 'primary' : 'default'}>
                {range.toUpperCase()}
              </Button>
            ))}
          </View>

          {!loading && investmentMessage.message ? (
            <ErrorText
              color={colors.textMuted}
              detail={investmentMessage.detail}
              message={investmentMessage.message}
              textStyle={styles.message}
            />
          ) : null}
          {!loading && !investmentMessage.message && !selectedInvestmentId ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>Add an investment to see value history.</Text>
          ) : null}

          <View collapsable={false} testID="home.investmentChart">
          <LineChart
            key={`${selectedInvestmentId}-${investmentRange}-${investmentHistories.map((history) => history.Id).join('-')}`}
            domainEnd={endOfDbDate(new Date())}
            domainStart={getInvestmentRangeStart(investmentRange)}
            emptyText="No value history for this range."
            formatValue={(value) => formatUnitValue(value, selectedInvestmentCurrency)}
            labels="header"
            points={investmentChartPoints}
          />
          </View>
        </View>

        <PickerModal
          emptyText="No accounts yet."
          items={accounts.map((account) => ({ id: account.Id, label: account.Name }))}
          onClose={() => setPickerMode(null)}
          onSelect={(item) => {
            setSelectedAccountId(Number(item.id));
            setPickerMode(null);
          }}
          searchable
          selectedId={selectedAccountId}
          title="Select Account"
          visible={pickerMode === 'account'}
        />

        <PickerModal
          emptyText="No investments yet."
          items={investments.map((investment) => ({ id: investment.Id, label: investment.Name }))}
          onClose={() => setPickerMode(null)}
          onSelect={(item) => {
            setSelectedInvestmentId(Number(item.id));
            setPickerMode(null);
          }}
          searchable
          selectedId={selectedInvestmentId}
          title="Select Investment"
          visible={pickerMode === 'investment'}
        />

        <ExcelExportModal
          onClose={() => setExcelExportScope(null)}
          onResult={(messageText, variant, title, detail) => setPopup({ detail, message: messageText, title, variant })}
          scope={excelExportScope}
          visible={excelExportScope !== null}
        />
      </ScrollView>

      {popup ? (
        <Popup
          detail={popup.detail}
          message={popup.message}
          onClose={() => setPopup(null)}
          style={styles.popup}
          title={popup.title}
          variant={popup.variant}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  amount: {
    fontSize: 15,
    marginLeft: 18,
    marginTop: 2,
  },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
    width: '100%',
    ...cardShadow,
  },
  categoryName: {
    flex: 1,
    fontSize: 16,
  },
  categoryNameWrap: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  colorDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  container: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  disabled: {
    opacity: 0.45,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  headerReversed: {
    flexDirection: 'row-reverse',
  },
  headerSpacer: {
    width: 42,
  },
  iconButton: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  message: {
    fontSize: 14,
    marginBottom: 8,
    textAlign: 'center',
  },
  percentage: {
    fontSize: 16,
    fontWeight: '600',
    minWidth: 52,
    textAlign: 'right',
  },
  rangeButton: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 0,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  rangeText: {
    fontSize: 15,
  },
  pressed: {
    opacity: 0.65,
  },
  popup: {
    bottom: 16,
    left: 15,
    position: 'absolute',
    right: 15,
  },
  screen: {
    flex: 1,
  },
  summaryHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryList: {
    gap: 12,
    marginTop: 4,
  },
  summaryRow: {
    minHeight: 44,
  },
  title: {
    fontSize: 24,
    fontWeight: '400',
  },
  toggleButton: {
    flex: 1,
    minWidth: 0,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 4,
  },
  toggleText: {
    fontSize: 18,
  },
  viewAll: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 42,
  },
  viewAllText: {
    fontSize: 17,
    fontWeight: '600',
  },
});
