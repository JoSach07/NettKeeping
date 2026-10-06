import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import CategoryDonut from '@/components/CategoryDonut';
import MonthYearPickerField, { getMonthYearLabel } from '@/components/MonthYearPickerField';
import Button from '@/components/themed/Button';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import PickerModal from '@/components/themed/PickerModal';
import Text from '@/components/themed/Text';
import { SelectField } from '@/components/themed/fields';
import { Account, getAccounts } from '@/database/tables/accounts';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { CategoryTransactionSummary, getCategoryTransactionSummary } from '@/database/tables/transactions';
import { useAppTheme } from '@/hooks/useAppTheme';
import { useSummaryMode } from '@/hooks/useSummaryMode';
import { formatCurrencyAmount } from '@/utils/moneyInput';
import { formatPercentage } from '@/utils/percentage';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';

type PickerMode = 'account' | null;

type BreakdownParams = {
  accountId?: string;
  month?: string;
  year?: string;
};

const parsePositiveInteger = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

export default function CategoryBreakdownScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<BreakdownParams>();
  const { colors } = useAppTheme();
  const { setSummaryMode: setMode, summaryMode: mode } = useSummaryMode();
  const today = new Date();
  const initialAccountId = parsePositiveInteger(params.accountId);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(initialAccountId);
  const [selectedMonth, setSelectedMonth] = useState(parsePositiveInteger(params.month) ?? today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(parsePositiveInteger(params.year) ?? today.getFullYear());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [summaries, setSummaries] = useState<CategoryTransactionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useErrorState();
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);

  const selectedAccount = accounts.find((account) => account.Id === selectedAccountId);
  const selectedCurrency = currencies.find((currency) => currency.Id === selectedAccount?.CurrencyId);
  const total = summaries.reduce((sum, summary) => sum + summary.Amount, 0);
  const title = `${mode === 'income' ? 'Income' : 'Spending'} Breakdown`;
  const monthLabel = getMonthYearLabel(selectedMonth, selectedYear);
  const sortedSummaries = useMemo(
    () => [...summaries].sort((first, second) => second.Amount - first.Amount || first.CategoryName.localeCompare(second.CategoryName)),
    [summaries]
  );

  const loadData = useCallback(async () => {
    setLoading(true);

    const [accountResult, currencyResult] = await Promise.all([getAccounts(), getCurrencies()]);

    setLoading(false);

    if (accountResult.Status === 'Success') {
      setAccounts(accountResult.Data);
      setSelectedAccountId((currentId) => currentId ?? accountResult.Data[0]?.Id ?? null);
    } else {
      setMessage(accountResult.Message ?? 'Unable to load accounts.', accountResult.Detail);
      return;
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    } else {
      setMessage(currencyResult.Message ?? 'Unable to load currencies.', currencyResult.Detail);
      return;
    }

    if (!selectedAccountId) {
      setSummaries([]);
      setMessage(accountResult.Data.length ? '' : 'Choose an account before viewing a breakdown.');
      return;
    }

    const summaryResult = await getCategoryTransactionSummary(selectedAccountId, selectedMonth, selectedYear, mode === 'income');

    if (summaryResult.Status === 'Success') {
      setSummaries(summaryResult.Data);
      setMessage('');
    } else {
      setSummaries([]);
      setMessage(summaryResult.Message ?? 'Unable to load category summary.', summaryResult.Detail);
    }
  }, [mode, selectedAccountId, selectedMonth, selectedYear]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: insets.top + 12, paddingBottom: 24 }]}
      style={{ backgroundColor: colors.background }}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton} testID="categoryBreakdown.back">
          <FontAwesome name="angle-left" size={28} color={colors.text} />
        </Pressable>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.title}>{title}</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            {selectedAccount?.Name ?? 'Account'} - {monthLabel}
          </Text>
        </View>
        <View style={styles.backButton} />
      </View>

      <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <SelectField
          label="Account"
          onPress={() => setPickerMode('account')}
          testID="categoryBreakdown.account"
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
          testID="categoryBreakdown.month"
          year={selectedYear}
        />

        <View style={styles.toggleRow}>
          <Button
            size="small"
            style={[styles.toggleButton, mode === 'spending' && { borderWidth: 2 }]}
            testID="categoryBreakdown.mode.spending"
            textStyle={styles.toggleText}
            variant="danger"
            onPress={() => setMode('spending')}>
            Spending
          </Button>
          <Button
            size="small"
            style={[styles.toggleButton, mode === 'income' && { borderWidth: 2 }]}
            testID="categoryBreakdown.mode.income"
            textStyle={styles.toggleText}
            variant="success"
            onPress={() => setMode('income')}>
            Income
          </Button>
        </View>

        <CategoryDonut
          items={summaries
            .filter((summary) => summary.Amount > 0)
            .map((summary) => ({
              amount: summary.Amount,
              color: summary.HexColor,
              label: summary.CategoryName,
            }))}
          subtitle={mode === 'income' ? 'Income' : 'Spending'}
          title={formatCurrencyAmount(total, selectedCurrency)}
        />

        {loading ? <LoadingSpinner /> : null}
        {!loading && message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}
        {!loading && !message.message && total === 0 ? (
          <Text style={[styles.message, { color: colors.textMuted }]}>No {mode} recorded for this month.</Text>
        ) : null}

        <View style={styles.list}>
          {sortedSummaries.map((summary) => (
            <View
              collapsable={false}
              key={summary.CategoryId}
              style={[styles.categoryRow, { borderColor: colors.border }]}
              testID={`categoryBreakdown.row.${summary.CategoryName}`}>
              <View style={styles.categoryTopLine}>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  amount: {
    fontSize: 15,
    marginLeft: 18,
    marginTop: 3,
  },
  backButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 18,
    padding: 16,
    width: '100%',
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
  categoryRow: {
    borderBottomWidth: 1,
    paddingVertical: 12,
  },
  categoryTopLine: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  colorDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  container: {
    paddingHorizontal: 16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerTitleWrap: {
    alignItems: 'center',
    flex: 1,
  },
  list: {
    marginTop: 4,
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
  pressed: {
    opacity: 0.65,
  },
  subtitle: {
    fontSize: 13,
    marginTop: 3,
    textAlign: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '400',
    textAlign: 'center',
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
});
