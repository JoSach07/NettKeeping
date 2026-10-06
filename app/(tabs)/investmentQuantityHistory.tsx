import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import DeleteAdjustmentModal, { DeleteAdjustmentOutcome } from '@/components/DeleteAdjustmentModal';
import InvestmentAdjustModal from '@/components/InvestmentAdjustModal';
import InvestmentHistoryRow from '@/components/InvestmentHistoryRow';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { formatQuantity } from '@/utils/investmentNumbers';
import { Investment, getInvestments } from '@/database/tables/investments';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import {
  getInvestmentHistoriesByInvestment,
  InvestmentHistory,
  isInvestmentAdjustment,
} from '@/database/tables/investmentHistories';
import { useAppTheme } from '@/hooks/useAppTheme';
import { formatDbDate } from '@/utils/dbDate';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';

type HistoryParams = {
  investmentId?: string;
};

const parsePositiveInteger = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

const getAllHistoryStart = () => new Date(1970, 0, 1);


export default function InvestmentQuantityHistoryScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<HistoryParams>();
  const router = useRouter();
  const { colors } = useAppTheme();
  const investmentId = parsePositiveInteger(params.investmentId);
  const [histories, setHistories] = useState<InvestmentHistory[]>([]);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useErrorState();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  // Adjustments are edited and deleted from here; transaction entries are edited from the
  // transaction itself, and the opening entry from Manage Investments.
  const [editingAdjustment, setEditingAdjustment] = useState<InvestmentHistory | null>(null);
  const [deletingAdjustment, setDeletingAdjustment] = useState<InvestmentHistory | null>(null);
  const [popup, setPopup] = useState<DeleteAdjustmentOutcome | null>(null);
  // Newest first, like Account Transactions. The query stays oldest first because
  // the charts share it.
  const rows = useMemo(() => [...histories].reverse(), [histories]);

  const selectedInvestment = investments.find((investment) => investment.Id === investmentId);
  const selectedCurrency = useMemo(
    () => currencies.find((currency) => currency.Id === selectedInvestment?.CurrencyId),
    [currencies, selectedInvestment]
  );
  const quantityDecimals = selectedInvestment?.QuantityDecimals ?? 0;

  const loadData = useCallback(async () => {
    if (!investmentId) {
      setLoading(false);
      setMessage('Investment could not be found.');
      return;
    }

    setLoading(true);

    const [investmentResult, historyResult, currencyResult] = await Promise.all([
      getInvestments(),
      getInvestmentHistoriesByInvestment(investmentId, formatDbDate(getAllHistoryStart())),
      getCurrencies(),
    ]);

    // Only the Adjust modal needs currencies (for its value per unit field).
    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    }

    setLoading(false);

    if (investmentResult.Status === 'Success') {
      setInvestments(investmentResult.Data);
    } else {
      setMessage(investmentResult.Message ?? 'Unable to load investment.', investmentResult.Detail);
      return;
    }

    if (historyResult.Status === 'Success') {
      setHistories(historyResult.Data);
      setMessage('');
    } else {
      setHistories([]);
      setMessage(historyResult.Message ?? 'Unable to load quantity history.', historyResult.Detail);
    }
  }, [investmentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 12, paddingBottom: 24 }]}
        style={{ backgroundColor: colors.background }}
        showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => router.back()} style={styles.backButton} testID="investmentQuantityHistory.back">
            <FontAwesome name="angle-left" size={28} color={colors.text} />
          </Pressable>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.title}>Quantity History</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>{selectedInvestment?.Name ?? 'Investment'}</Text>
          </View>
          <View style={styles.backButton} />
        </View>

        {loading ? <LoadingSpinner /> : null}
        {!loading && message.message ? <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} /> : null}
        {!loading && !message.message && histories.length === 0 ? <Text style={[styles.message, { color: colors.textMuted }]}>No quantity history yet.</Text> : null}

        <View style={styles.list}>
          {rows.map((history, index) => {
            const editable = isInvestmentAdjustment(history);
            // The opening entry's delta is the anchor itself, not a change.
            const amount = history.IsOpening
              ? formatQuantity(history.Quantity, quantityDecimals)
              : `${history.QuantityDelta > 0 ? '+' : ''}${formatQuantity(history.QuantityDelta, quantityDecimals)}`;
            const amountColor = history.IsOpening
              ? undefined
              : history.QuantityDelta > 0
                ? colors.successText
                : history.QuantityDelta < 0
                  ? colors.dangerText
                  : colors.textMuted;
            return (
              <InvestmentHistoryRow
                amount={amount}
                amountColor={amountColor}
                history={history}
                index={index}
                key={history.Id}
                onDelete={editable ? () => setDeletingAdjustment(history) : undefined}
                onEdit={editable ? () => setEditingAdjustment(history) : undefined}
                testIDPrefix="investmentQuantityHistory"
              />
            );
          })}
        </View>
      </ScrollView>
      <InvestmentAdjustModal
        adjustment={editingAdjustment}
        currency={selectedCurrency}
        investment={selectedInvestment ?? null}
        onClose={() => setEditingAdjustment(null)}
        onSaved={async (messageText) => {
          setEditingAdjustment(null);
          await loadData();
          setPopup({ message: messageText, title: 'Saved', variant: 'success' });
        }}
        visible={editingAdjustment !== null}
      />
      <DeleteAdjustmentModal
        adjustment={deletingAdjustment}
        onCancel={() => setDeletingAdjustment(null)}
        onDone={async (outcome) => {
          setDeletingAdjustment(null);
          if (outcome.variant === 'success') {
            await loadData();
          }
          setPopup(outcome);
        }}
      />
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
  backButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
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
    marginTop: 16,
  },
  message: {
    fontSize: 14,
    marginTop: 18,
    textAlign: 'center',
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
  subtitle: {
    fontSize: 13,
    marginTop: 3,
    textAlign: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '400',
    textAlign: 'center',
  },
});
