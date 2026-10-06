import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AnimatedChevron from '@/components/AnimatedChevron';
import CollapsibleBody, { collapsibleLayout } from '@/components/CollapsibleBody';
import ExcelExportModal from '@/components/ExcelExportModal';
import LineChart, { LineChartPoint } from '@/components/LineChart';
import Button from '@/components/themed/Button';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { Account, getAccounts } from '@/database/tables/accounts';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import {
  AccountTransactionDetail,
  getAccountTransactionDetails,
  getAccountTransactionDetailsForRange,
} from '@/database/tables/transactions';
import { useAppTheme } from '@/hooks/useAppTheme';
import { buildBalancePoints, formatCompactAmount } from '@/utils/chartPoints';
import { formatDbDate, parseDbDate } from '@/utils/dbDate';
import { ExcelExportScope } from '@/utils/excelExport';
import { formatCurrencyAmount, formatHiddenCurrencyAmount } from '@/utils/moneyInput';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';

type AccountRange = '1d' | '1w' | '1m' | '3m' | '6m' | 'ytd' | '1y' | '5y';
type PopupVariant = 'danger' | 'success' | 'warning';

type AccountDisplayData = {
  chartTransactions: AccountTransactionDetail[];
  lastTransactions: AccountTransactionDetail[];
  message?: ErrorMessage;
};

const rangeRows: AccountRange[][] = [
  ['1d', '1w', '1m', '3m'],
  ['6m', 'ytd', '1y', '5y'],
];

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

const formatDisplayDate = (rawDate: string | Date) =>
  parseDbDate(rawDate).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const getRangeLabel = (range: AccountRange) => range.toUpperCase();

const getRangeStart = (range: AccountRange) => {
  const today = new Date();

  if (range === '1d') {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  }

  if (range === '1w') {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  }

  if (range === '1m') {
    return new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
  }

  if (range === '3m') {
    return new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
  }

  if (range === '6m') {
    return new Date(today.getFullYear(), today.getMonth() - 6, today.getDate());
  }

  if (range === 'ytd') {
    return new Date(today.getFullYear(), 0, 1);
  }

  if (range === '1y') {
    return new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  }

  return new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
};

export default function AccountsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors, leftHandedMode } = useAppTheme();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [accountData, setAccountData] = useState<Record<number, AccountDisplayData>>({});
  const [loading, setLoading] = useState(true);
  const [loadingAccountIds, setLoadingAccountIds] = useState<Set<number>>(() => new Set());
  const [expandedAccountId, setExpandedAccountId] = useState<number | null>(null);
  // Only one card is ever expanded and the eye button lives inside the expanded
  // body, so at most one balance can be revealed. A single id rather than a set
  // encodes that, and makes "collapsing re-hides the balance" the default
  // instead of something each toggle path has to remember to do.
  const [visibleBalanceAccountId, setVisibleBalanceAccountId] = useState<number | null>(null);
  const [selectedRanges, setSelectedRanges] = useState<Record<number, AccountRange>>({});
  const [message, setMessage] = useErrorState();
  const [excelExportScope, setExcelExportScope] = useState<ExcelExportScope | null>(null);
  const [popup, setPopup] = useState<{ detail?: string; message: string; title?: string; variant: PopupVariant } | null>(null);

  const currencyById = useMemo(
    () => new Map(currencies.map((currency) => [currency.Id, currency])),
    [currencies]
  );
  // Memoized so the chart, which recomputes whenever its points array changes
  // identity, does not redo the whole plot on every render of this screen.
  const balancePointsByAccountId = useMemo(() => {
    const pointsByAccountId = new Map<number, LineChartPoint[]>();

    accounts.forEach((account) => {
      const data = accountData[account.Id];
      if (data) {
        pointsByAccountId.set(
          account.Id,
          buildBalancePoints(account, data.chartTransactions, getRangeStart(selectedRanges[account.Id] ?? '1m'))
        );
      }
    });

    return pointsByAccountId;
  }, [accountData, accounts, selectedRanges]);

  const loadData = useCallback(async () => {
    setLoading(true);

    const [accountResult, currencyResult] = await Promise.all([getAccounts(), getCurrencies()]);

    setLoading(false);

    if (accountResult.Status !== 'Success') {
      setAccounts([]);
      setMessage(accountResult.Message ?? 'Unable to load accounts.', accountResult.Detail);
      return;
    }

    if (currencyResult.Status !== 'Success') {
      setCurrencies([]);
      setMessage(currencyResult.Message ?? 'Unable to load currencies.', currencyResult.Detail);
      return;
    }

    setAccounts(accountResult.Data);
    setCurrencies(currencyResult.Data);
    setMessage('');

    // The expanded account may have been removed on Manage Accounts while we
    // were away; its card is gone, so holding the id would only make the
    // refetch below chase a row that is no longer listed.
    const loadedAccountIds = new Set(accountResult.Data.map((account) => account.Id));
    setExpandedAccountId((current) => (current !== null && loadedAccountIds.has(current) ? current : null));

    // Keep whatever range the user already picked per account; only accounts
    // that are new to this load fall back to the default.
    setSelectedRanges((current) =>
      accountResult.Data.reduce<Record<number, AccountRange>>((ranges, account) => {
        ranges[account.Id] = current[account.Id] ?? '1m';
        return ranges;
      }, {})
    );
    setAccountData({});
  }, []);

  // Balances and names change on other screens (Manage Accounts, Create
  // Transaction), and this screen used to load once on mount and never again, so
  // an edit made elsewhere did not show up on return.
  useFocusEffect(
    useCallback(() => {
      setVisibleBalanceAccountId(null);
      loadData();
    }, [loadData])
  );

  // Transaction data is fetched per account only when its card is expanded, so
  // opening the screen stays cheap no matter how many accounts exist.
  const loadAccountData = useCallback(async (accountId: number, range: AccountRange) => {
    setLoadingAccountIds((current) => new Set(current).add(accountId));

    const [lastResult, historyResult] = await Promise.all([
      getAccountTransactionDetails(accountId, 3),
      getAccountTransactionDetailsForRange(accountId, formatDbDate(getRangeStart(range))),
    ]);

    const messages = [lastResult, historyResult]
      .filter((result) => result.Status !== 'Success')
      .map((result) => toErrorMessage(result, 'Unable to load account transactions.'));

    setAccountData((current) => ({
      ...current,
      [accountId]: {
        chartTransactions: historyResult.Status === 'Success' ? historyResult.Data : [],
        lastTransactions: lastResult.Status === 'Success' ? lastResult.Data : [],
        message: messages.length > 0 ? joinErrorMessages(messages) : undefined,
      },
    }));
    setLoadingAccountIds((current) => {
      const next = new Set(current);
      next.delete(accountId);
      return next;
    });
  }, []);

  // loadData wipes accountData, but nothing else would refetch it: the fetch
  // used to live inside toggleAccountCard, so after a focus reload the still
  // expanded card sat there with an empty chart until it was collapsed and
  // reopened. Driving the fetch off the expanded id covers both paths.
  useEffect(() => {
    if (expandedAccountId === null) {
      return;
    }

    if (accountData[expandedAccountId] || loadingAccountIds.has(expandedAccountId)) {
      return;
    }

    loadAccountData(expandedAccountId, selectedRanges[expandedAccountId] ?? '1m');
  }, [accountData, expandedAccountId, loadAccountData, loadingAccountIds, selectedRanges]);

  const updateRange = async (accountId: number, range: AccountRange) => {
    setSelectedRanges((current) => ({ ...current, [accountId]: range }));
    setAccountData((current) => ({
      ...current,
      [accountId]: {
        chartTransactions: [],
        lastTransactions: current[accountId]?.lastTransactions ?? [],
      },
    }));
    const result = await getAccountTransactionDetailsForRange(accountId, formatDbDate(getRangeStart(range)));

    setAccountData((current) => ({
      ...current,
      [accountId]: {
        chartTransactions: result.Status === 'Success' ? result.Data : [],
        lastTransactions: current[accountId]?.lastTransactions ?? [],
        message: result.Status === 'Success' ? undefined : toErrorMessage(result, 'Unable to load account history.'),
      },
    }));
  };

  const toggleBalanceVisibility = (accountId: number) => {
    setVisibleBalanceAccountId((current) => (current === accountId ? null : accountId));
  };

  const toggleAccountCard = (accountId: number) => {
    setExpandedAccountId((current) => (current === accountId ? null : accountId));

    // Cleared unconditionally rather than only on collapse: pressing a
    // different card collapses the open one implicitly, without ever going
    // through a close branch.
    setVisibleBalanceAccountId(null);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: 24 }]}
        style={{ backgroundColor: colors.background }}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.header, leftHandedMode && styles.headerReversed]}>
          <View style={styles.headerSpacer} />
          <Text style={styles.title}>Accounts</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/manageAccounts')}
            testID="accounts.manage"
            style={({ pressed }) => [
              styles.manageButton,
              { borderColor: colors.border },
              pressed && styles.pressed,
            ]}>
            <Text style={styles.manageButtonText}>Manage</Text>
          </Pressable>
        </View>

        {loading ? <LoadingSpinner /> : null}
        {!loading && message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}
        {!loading && !message.message && accounts.length === 0 ? (
          <Text style={[styles.message, { color: colors.textMuted }]}>No accounts yet.</Text>
        ) : null}

        <View style={styles.list}>
          {accounts.map((account) => {
            const currency = currencyById.get(account.CurrencyId);
            const balanceIsVisible = visibleBalanceAccountId === account.Id;
            const isExpanded = expandedAccountId === account.Id;
            const range = selectedRanges[account.Id] ?? '1m';
            const data = accountData[account.Id];
            const isLoadingData = loadingAccountIds.has(account.Id);
            const points = isExpanded ? balancePointsByAccountId.get(account.Id) ?? [] : [];

            return (
              <Animated.View
                key={account.Id}
                layout={collapsibleLayout}
                style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => toggleAccountCard(account.Id)}
                  testID={`accounts.card.${account.Name}`}
                  style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}>
                  <Text style={styles.accountName}>{account.Name}</Text>
                  <AnimatedChevron color={colors.text} expanded={isExpanded} />
                </Pressable>

                {isExpanded ? (
                  <CollapsibleBody style={styles.cardBody}>
                    <View style={styles.balanceRow}>
                      <Text style={styles.balanceText} testID={`accounts.balance.${account.Name}`}>
                        {balanceIsVisible ? formatCurrencyAmount(account.Balance, currency) : formatHiddenCurrencyAmount(currency)}
                      </Text>
                      <Pressable
                        accessibilityLabel={balanceIsVisible ? 'Hide balance' : 'Show balance'}
                        accessibilityRole="button"
                        onPress={() => toggleBalanceVisibility(account.Id)}
                        testID={`accounts.balanceToggle.${account.Name}`}
                        style={({ pressed }) => [styles.eyeButton, pressed && styles.pressed]}>
                        <FontAwesome name={balanceIsVisible ? 'eye-slash' : 'eye'} size={20} color={colors.text} />
                      </Pressable>
                    </View>

                    {rangeRows.map((rangeRow) => (
                      <View key={rangeRow.join('-')} style={styles.rangeRow}>
                        {rangeRow.map((rangeOption) => (
                          <Button
                            key={rangeOption}
                            onPress={() => updateRange(account.Id, rangeOption)}
                            size="small"
                            style={[styles.rangeButton, range === rangeOption && { borderWidth: 2 }]}
                            testID={`accounts.range.${account.Name}.${rangeOption}`}
                            textStyle={styles.rangeText}
                            variant={range === rangeOption ? 'primary' : 'default'}>
                            {getRangeLabel(rangeOption)}
                          </Button>
                        ))}
                      </View>
                    ))}

                    {isLoadingData ? (
                      <LoadingSpinner />
                    ) : (
                      <>
                        <View collapsable={false} testID={`accounts.chart.${account.Name}`}>
                        <LineChart
                          key={`${account.Id}-${range}-${(data?.chartTransactions ?? []).map((transaction) => transaction.Id).join('-')}`}
                          domainEnd={new Date()}
                          domainStart={getRangeStart(range)}
                          emptyText="No balance changes for this range."
                          formatValue={(value) => formatCompactAmount(value, currency)}
                          height={170}
                          labels="axis"
                          points={points}
                        />
                        </View>

                        {data?.message ? <ErrorText color={colors.textMuted} detail={data.message.detail} message={data.message.message} textStyle={styles.message} /> : null}

                        {(data?.chartTransactions.length ?? 0) > 0 ? (
                          <View style={styles.transactionList}>
                            {(data?.lastTransactions ?? []).map((transaction) => (
                              <TransactionRow key={transaction.Id} currency={currency} transaction={transaction} />
                            ))}
                          </View>
                        ) : (
                          <Text style={[styles.emptyText, { color: colors.textMuted }]}>No transactions in the selected time period.</Text>
                        )}
                      </>
                    )}

                    {/* Same boxed buttons as the investment card, one row of two. */}
                    <View style={styles.actionRow}>
                      <Button
                        onPress={() =>
                          router.push({
                            pathname: '/accountTransactions',
                            params: { accountId: account.Id.toString() },
                          })
                        }
                        size="small"
                        style={styles.actionButton}
                        testID={`accounts.allTransactions.${account.Name}`}
                        textStyle={styles.actionText}>
                        All Transactions
                      </Button>
                      <Button
                        onPress={() => setExcelExportScope({
                          accountId: account.Id,
                          accountName: account.Name,
                          kind: 'account',
                        })}
                        size="small"
                        style={styles.actionButton}
                        testID={`accounts.export.${account.Name}`}
                        textStyle={styles.actionText}>
                        Export Excel
                      </Button>
                    </View>
                  </CollapsibleBody>
                ) : null}
              </Animated.View>
            );
          })}
        </View>

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

function TransactionRow({
  currency,
  transaction,
}: {
  currency?: Currency;
  transaction: AccountTransactionDetail;
}) {
  const { colors } = useAppTheme();
  const isIncome = Boolean(transaction.IsIncome);
  const amountPrefix = isIncome ? '+' : '-';
  const amountColor = isIncome ? colors.successText : colors.dangerText;

  return (
    <View style={[styles.transactionRow, { borderColor: colors.border }]}>
      <View style={styles.transactionText}>
        <Text style={styles.transactionCategory}>{transaction.CategoryName}</Text>
        <Text style={[styles.transactionDate, { color: colors.textMuted }]}>{formatDisplayDate(transaction.TransactionDate)}</Text>
        {transaction.Description ? (
          <Text style={[styles.transactionDescription, { color: colors.textMuted }]}>{transaction.Description}</Text>
        ) : null}
      </View>
      <Text style={[styles.transactionAmount, { color: amountColor }]}>
        {amountPrefix}{formatCurrencyAmount(transaction.Amount, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
    minHeight: 42,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  actionText: {
    fontSize: 17,
    fontWeight: '600',
  },
  accountName: {
    flex: 1,
    fontSize: 19,
    fontWeight: '600',
  },
  balanceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 8,
  },
  balanceText: {
    flex: 1,
    fontSize: 18,
  },
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
    width: '100%',
    ...cardShadow,
  },
  cardBody: {
    marginTop: 10,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 42,
  },
  container: {
    paddingHorizontal: 16,
  },
  emptyText: {
    fontSize: 14,
    paddingVertical: 12,
    textAlign: 'center',
  },
  eyeButton: {
    alignItems: 'center',
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerReversed: {
    flexDirection: 'row-reverse',
  },
  headerSpacer: {
    width: 86,
  },
  list: {
    gap: 16,
    marginTop: 18,
  },
  manageButton: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    width: 86,
  },
  manageButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  message: {
    fontSize: 14,
    marginTop: 16,
    textAlign: 'center',
  },
  transactionAmount: {
    fontSize: 15,
    fontWeight: '600',
    paddingLeft: 10,
    textAlign: 'right',
  },
  transactionCategory: {
    fontSize: 15,
    fontWeight: '600',
  },
  transactionDate: {
    fontSize: 13,
    marginTop: 2,
  },
  transactionDescription: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  transactionList: {
    marginTop: 12,
  },
  transactionRow: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingVertical: 10,
  },
  transactionText: {
    flex: 1,
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
  rangeButton: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 0,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  rangeText: {
    fontSize: 14,
  },
  screen: {
    flex: 1,
  },
  title: {
    fontSize: 26,
    fontWeight: '400',
    textAlign: 'center',
  },
});
