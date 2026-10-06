import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AnimatedChevron from '@/components/AnimatedChevron';
import CollapsibleBody, { collapsibleLayout } from '@/components/CollapsibleBody';
import ExcelExportModal from '@/components/ExcelExportModal';
import InvestmentAdjustModal from '@/components/InvestmentAdjustModal';
import LineChart, { LineChartPoint } from '@/components/LineChart';
import Button from '@/components/themed/Button';
import Popup from '@/components/themed/Popup';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import Text from '@/components/themed/Text';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import { Investment, getInvestments } from '@/database/tables/investments';
import { InvestmentHistory, getInvestmentHistoriesByInvestment } from '@/database/tables/investmentHistories';
import { useAppTheme } from '@/hooks/useAppTheme';
import { buildInvestmentChartPoints } from '@/utils/chartPoints';
import { endOfDbDate, formatDbDate, parseDbDate } from '@/utils/dbDate';
import { ExcelExportScope } from '@/utils/excelExport';
import { calculateInvestmentAmountForDisplay, formatQuantity, formatUnitValue } from '@/utils/investmentNumbers';
import { formatCurrencyAmount } from '@/utils/moneyInput';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';
import { ErrorMessage, joinErrorMessages, toErrorMessage } from '@/utils/userFacingError';

type InvestmentRange = '1w' | '1m' | 'ytd' | '1y';
type PopupVariant = 'danger' | 'success' | 'warning';

const formatDisplayDate = (rawDate: string | Date) =>
  parseDbDate(rawDate).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const parseParamNumber = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

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

type InvestmentChartPoints = {
  quantity: LineChartPoint[];
  total: LineChartPoint[];
  unitValue: LineChartPoint[];
};

const getHistoryUnitValue = (history: InvestmentHistory) => history.UnitValue;
const getHistoryQuantity = (history: InvestmentHistory) => history.Quantity;

const getQuantityChartTitle = (investment: Investment) =>
  investment.Unit ? `Quantity (${investment.Unit})` : 'Quantity';

const getRecentValueChanges = (histories: InvestmentHistory[], rangeStart: Date) => {
  const sortedHistories = [...histories].sort(
    (first, second) => parseDbDate(first.CreatedAt).getTime() - parseDbDate(second.CreatedAt).getTime() || first.Id - second.Id
  );

  return sortedHistories
    .filter((history, index) => {
      const isInRange = parseDbDate(history.CreatedAt).getTime() >= rangeStart.getTime();
      const previousHistory = sortedHistories[index - 1];
      return isInRange && (!previousHistory || history.UnitValue !== previousHistory.UnitValue);
    })
    .reverse()
    .slice(0, 3);
};

export default function InvestmentsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors, leftHandedMode } = useAppTheme();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [expandedInvestmentId, setExpandedInvestmentId] = useState<number | null>(null);
  const [historiesByInvestmentId, setHistoriesByInvestmentId] = useState<Record<number, InvestmentHistory[]>>({});
  const [investmentRange, setInvestmentRange] = useState<InvestmentRange>('1m');
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [historyMessagesByInvestmentId, setHistoryMessagesByInvestmentId] = useState<Record<number, ErrorMessage | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useErrorState();
  const [excelExportScope, setExcelExportScope] = useState<ExcelExportScope | null>(null);
  const [adjustingInvestment, setAdjustingInvestment] = useState<Investment | null>(null);
  const [popup, setPopup] = useState<{ detail?: string; message: string; title?: string; variant: PopupVariant } | null>(null);
  const params = useLocalSearchParams<{ investmentId?: string }>();
  const scrollRef = useRef<ScrollView | null>(null);
  // Card top offsets, filled in by each card's onLayout. Used to scroll a card
  // requested by param into view.
  const cardOffsetsRef = useRef<Record<number, number>>({});
  // Set when arriving with an investmentId; cleared once the card has been
  // scrolled to, so a later manual collapse/expand does not re-scroll.
  const pendingScrollIdRef = useRef<number | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The cards sit inside a list wrapper, so their onLayout y is relative to it,
  // not to the scroll content.
  const listOffsetRef = useRef(0);

  const currencyById = useMemo(
    () => new Map(currencies.map((currency) => [currency.Id, currency])),
    [currencies]
  );
  // Memoized so the charts, which recompute whenever their points array
  // changes identity, do not redo the plot on every render of this screen.
  const chartPointsByInvestmentId = useMemo(() => {
    const rangeStart = getInvestmentRangeStart(investmentRange);
    const today = new Date();
    const pointsByInvestmentId = new Map<number, InvestmentChartPoints>();

    investments.forEach((investment) => {
      const histories = historiesByInvestmentId[investment.Id];
      if (!histories) {
        return;
      }

      pointsByInvestmentId.set(investment.Id, {
        quantity: buildInvestmentChartPoints(histories, getHistoryQuantity, rangeStart, today),
        total: buildInvestmentChartPoints(
          histories,
          (history) => calculateInvestmentAmountForDisplay(history.Quantity, investment.QuantityDecimals, history.UnitValue),
          rangeStart,
          today
        ),
        unitValue: buildInvestmentChartPoints(histories, getHistoryUnitValue, rangeStart, today),
      });
    });

    return pointsByInvestmentId;
  }, [historiesByInvestmentId, investmentRange, investments]);

  const loadBaseData = useCallback(async () => {
    setLoading(true);

    const [investmentResult, currencyResult] = await Promise.all([getInvestments(), getCurrencies()]);
    const messages: ErrorMessage[] = [];

    setLoading(false);

    if (investmentResult.Status === 'Success') {
      setInvestments(investmentResult.Data);
      // An investment deleted from Manage Investments while this screen was
      // away would otherwise stay "expanded" with nothing to render.
      setExpandedInvestmentId((current) =>
        current && investmentResult.Data.some((investment) => investment.Id === current) ? current : null
      );
    } else {
      messages.push(toErrorMessage(investmentResult, 'Unable to load investments.'));
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    } else {
      messages.push(toErrorMessage(currencyResult, 'Unable to load currencies.'));
    }

    const joined = joinErrorMessages(messages);
    setMessage(joined.message, joined.detail);
  }, []);

  const loadExpandedInvestmentHistory = useCallback(async () => {
    if (!expandedInvestmentId) {
      return;
    }

    // No end bound: account transactions are fetched the same way, and a row
    // dated past today is data that exists rather than data to hide.
    const result = await getInvestmentHistoriesByInvestment(
      expandedInvestmentId,
      formatDbDate(getInvestmentRangeStart(investmentRange))
    );

    setHistoriesByInvestmentId((current) => ({
      ...current,
      [expandedInvestmentId]: result.Status === 'Success' ? result.Data : [],
    }));
    setHistoryMessagesByInvestmentId((current) => ({
      ...current,
      [expandedInvestmentId]: result.Status === 'Success' ? undefined : toErrorMessage(result, 'Unable to load investment history.'),
    }));
  }, [expandedInvestmentId, investmentRange]);

  // Renames, new investments and deletions all happen on Manage Investments,
  // which returns here. This replaces the previous mount-only load, which meant
  // an edit made elsewhere did not show up on return. Focus also fires on
  // mount, so there is no separate initial fetch.
  useFocusEffect(
    useCallback(() => {
      loadBaseData();
    }, [loadBaseData])
  );

  useEffect(() => {
    loadExpandedInvestmentHistory();
  }, [loadExpandedInvestmentHistory]);

  // The scroll waits on layout rather than firing straight after the state
  // change, because the offset is only trustworthy once the card that was
  // previously expanded has collapsed and everything below it has moved up.
  // Each layout pass restarts the timer, so the scroll runs against the settled
  // position; the delay covers the 320ms collapsible transition.
  const scheduleScrollToCard = (investmentId: number) => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
    }

    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      pendingScrollIdRef.current = null;

      const cardOffset = cardOffsetsRef.current[investmentId];
      if (cardOffset === undefined) {
        return;
      }

      scrollRef.current?.scrollTo({ animated: true, y: Math.max(listOffsetRef.current + cardOffset - 12, 0) });
    }, 360);
  };

  const handleCardLayout = (investmentId: number, y: number) => {
    cardOffsetsRef.current[investmentId] = y;

    if (pendingScrollIdRef.current === investmentId) {
      scheduleScrollToCard(investmentId);
    }
  };

  useEffect(() => () => {
    if (scrollTimerRef.current) {
      clearTimeout(scrollTimerRef.current);
    }
  }, []);

  // Arriving from Manage Investments' view action. The param is cleared once
  // applied, otherwise the same card would re-expand on every later visit.
  // The scroll is scheduled here as well as from layout, because a card that is
  // already expanded does not re-lay out and would never trigger one.
  const requestedInvestmentId = parseParamNumber(params.investmentId);
  useEffect(() => {
    if (!requestedInvestmentId) {
      return;
    }

    pendingScrollIdRef.current = requestedInvestmentId;
    setExpandedInvestmentId(requestedInvestmentId);
    scheduleScrollToCard(requestedInvestmentId);
    router.setParams({ investmentId: '' });
    // scheduleScrollToCard only touches refs, so it is stable enough to leave
    // out of the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedInvestmentId, router]);

  const openHistory = (type: 'quantity' | 'value', investmentId: number) => {
    router.push({
      pathname: type === 'value' ? '/investmentValueHistory' : '/investmentQuantityHistory',
      params: { investmentId: investmentId.toString() },
    });
  };

  const toggleInvestmentCard = (investmentId: number) => {
    setExpandedInvestmentId((current) => (current === investmentId ? null : investmentId));
  };

  const selectInvestmentRange = (range: InvestmentRange) => {
    if (expandedInvestmentId) {
      setHistoriesByInvestmentId((current) => ({
        ...current,
        [expandedInvestmentId]: (current[expandedInvestmentId] ?? []).slice(-1),
      }));
    }
    setInvestmentRange(range);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 16, paddingBottom: 24 }]}
        ref={scrollRef}
        style={{ backgroundColor: colors.background }}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.header, leftHandedMode && styles.headerReversed]}>
          <View style={styles.headerSpacer} />
          <Text style={styles.title}>Investments</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/manageInvestments')}
            testID="investments.manage"
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
        {!loading && !message.message && investments.length === 0 ? (
          <Text style={[styles.message, { color: colors.textMuted }]}>No investments yet.</Text>
        ) : null}

        <View
          onLayout={(event) => {
            listOffsetRef.current = event.nativeEvent.layout.y;
          }}
          style={styles.list}>
          {investments.map((investment) => {
            const isExpanded = expandedInvestmentId === investment.Id;
            const histories = historiesByInvestmentId[investment.Id] ?? [];
            const historyMessage = historyMessagesByInvestmentId[investment.Id];
            const currency = currencyById.get(investment.CurrencyId);
            const recentValueChanges = getRecentValueChanges(histories, getInvestmentRangeStart(investmentRange));
            const chartPoints = chartPointsByInvestmentId.get(investment.Id);

            return (
              <Animated.View
                key={investment.Id}
                layout={collapsibleLayout}
                onLayout={(event) => handleCardLayout(investment.Id, event.nativeEvent.layout.y)}
                style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => toggleInvestmentCard(investment.Id)}
                  testID={`investments.card.${investment.Name}`}
                  style={({ pressed }) => [styles.cardHeader, pressed && styles.pressed]}>
                  <View style={styles.cardTitleBlock}>
                    <Text style={styles.cardTitle}>{investment.Name}</Text>
                    {investment.InvestmentCategoryName ? (
                      <Text style={[styles.cardSubtitle, { color: colors.textMuted }]}>{investment.InvestmentCategoryName}</Text>
                    ) : null}
                  </View>
                  <AnimatedChevron color={colors.text} expanded={isExpanded} />
                </Pressable>

                {isExpanded ? (
                  <CollapsibleBody style={styles.cardBody}>
                    <View style={styles.rangeRow}>
                      {(['1w', '1m', 'ytd', '1y'] as InvestmentRange[]).map((range) => (
                        <Button
                          key={range}
                          onPress={() => selectInvestmentRange(range)}
                          size="small"
                          style={[styles.rangeButton, investmentRange === range && { borderWidth: 2 }]}
                          testID={`investments.range.${range}`}
                          textStyle={styles.rangeText}
                          variant={investmentRange === range ? 'primary' : 'default'}>
                          {range.toUpperCase()}
                        </Button>
                      ))}
                    </View>

                    {historyMessage ? <ErrorText color={colors.textMuted} detail={historyMessage.detail} message={historyMessage.message} textStyle={styles.message} /> : null}

                    <View collapsable={false} style={styles.chartBlock} testID={`investments.chart.vpu.${investment.Name}`}>
                      <Text style={styles.sectionTitle}>Value Per Unit</Text>
                      <LineChart
                        key={`unit-${investment.Id}-${investmentRange}-${histories.map((history) => history.Id).join('-')}`}
                        domainEnd={endOfDbDate(new Date())}
                        domainStart={getInvestmentRangeStart(investmentRange)}
                        emptyText="No value per unit history for this range."
                        formatValue={(value) => formatUnitValue(value, currency)}
                        labels="header"
                        points={chartPoints?.unitValue ?? []}
                      />
                    </View>

                    <View collapsable={false} style={styles.chartBlock} testID={`investments.chart.total.${investment.Name}`}>
                      <Text style={styles.sectionTitle}>Total Value</Text>
                      <LineChart
                        key={`total-${investment.Id}-${investmentRange}-${histories.map((history) => history.Id).join('-')}`}
                        domainEnd={endOfDbDate(new Date())}
                        domainStart={getInvestmentRangeStart(investmentRange)}
                        emptyText="No total value history for this range."
                        formatValue={(value) => formatCurrencyAmount(value, currency)}
                        labels="header"
                        points={chartPoints?.total ?? []}
                      />
                    </View>

                    <View collapsable={false} style={styles.chartBlock} testID={`investments.chart.quantity.${investment.Name}`}>
                      <Text style={styles.sectionTitle}>{getQuantityChartTitle(investment)}</Text>
                      <LineChart
                        key={`quantity-${investment.Id}-${investmentRange}-${histories.map((history) => history.Id).join('-')}`}
                        domainEnd={endOfDbDate(new Date())}
                        domainStart={getInvestmentRangeStart(investmentRange)}
                        emptyText="No quantity history for this range."
                        formatValue={(quantity) => formatQuantity(quantity, investment.QuantityDecimals)}
                        labels="header"
                        points={chartPoints?.quantity ?? []}
                      />
                    </View>

                    {recentValueChanges.length > 0 ? (
                      <View style={styles.shortList}>
                        <Text style={styles.sectionTitle}>Recent Value Changes</Text>
                        {recentValueChanges.map((history) => (
                          <View key={history.Id} style={[styles.historyRow, { borderColor: colors.border }]}>
                            <View style={styles.historyText}>
                              <Text style={styles.historyTitle}>{formatUnitValue(history.UnitValue, currency)}</Text>
                              <Text style={[styles.historyMeta, { color: colors.textMuted }]}>
                                {formatDisplayDate(history.CreatedAt)} - Qty {formatQuantity(history.Quantity, investment.QuantityDecimals)}
                              </Text>
                            </View>
                            <Text style={[styles.historyTotal, { color: colors.textMuted }]}>
                              {formatCurrencyAmount(
                                calculateInvestmentAmountForDisplay(history.Quantity, investment.QuantityDecimals, history.UnitValue),
                                currency
                              )}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={[styles.message, { color: colors.textMuted }]}>No value changes in the selected time period.</Text>
                    )}

                    {/* Boxed buttons rather than text links, so they read as actions
                        at a glance. Two equal columns; labels stay on one line. */}
                    <View style={styles.actionGrid}>
                      <View style={styles.actionRow}>
                        <Button
                          onPress={() => openHistory('value', investment.Id)}
                          size="small"
                          style={styles.actionButton}
                          testID={`investments.valueHistory.${investment.Name}`}
                          textStyle={styles.actionText}>
                          Value History
                        </Button>
                        <Button
                          onPress={() => setAdjustingInvestment(investment)}
                          size="small"
                          style={styles.actionButton}
                          testID={`investments.adjust.${investment.Name}`}
                          textStyle={styles.actionText}>
                          Adjust
                        </Button>
                      </View>
                      <View style={styles.actionRow}>
                        <Button
                          onPress={() => openHistory('quantity', investment.Id)}
                          size="small"
                          style={styles.actionButton}
                          testID={`investments.quantityHistory.${investment.Name}`}
                          textStyle={styles.actionText}>
                          Quantity History
                        </Button>
                        <Button
                          onPress={() => setExcelExportScope({
                            investmentId: investment.Id,
                            investmentName: investment.Name,
                            kind: 'investment',
                          })}
                          size="small"
                          style={styles.actionButton}
                          testID={`investments.export.${investment.Name}`}
                          textStyle={styles.actionText}>
                          Export Excel
                        </Button>
                      </View>
                    </View>
                  </CollapsibleBody>
                ) : null}
              </Animated.View>
            );
          })}
        </View>

        <InvestmentAdjustModal
          currency={adjustingInvestment ? currencyById.get(adjustingInvestment.CurrencyId) : undefined}
          investment={adjustingInvestment}
          onClose={() => setAdjustingInvestment(null)}
          onSaved={async (messageText) => {
            setAdjustingInvestment(null);
            await loadBaseData();
            await loadExpandedInvestmentHistory();
            setPopup({ message: messageText, title: 'Saved', variant: 'success' });
          }}
          visible={adjustingInvestment !== null}
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
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 16,
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
  cardSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  cardTitle: {
    fontSize: 19,
    fontWeight: '600',
  },
  cardTitleBlock: {
    flex: 1,
  },
  chartBlock: {
    marginTop: 16,
  },
  container: {
    paddingHorizontal: 16,
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
  historyMeta: {
    fontSize: 13,
    marginTop: 2,
  },
  historyRow: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingVertical: 10,
  },
  historyText: {
    flex: 1,
  },
  historyTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  historyTotal: {
    fontSize: 14,
    paddingLeft: 10,
    textAlign: 'right',
  },
  list: {
    gap: 16,
    marginTop: 18,
  },
  message: {
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
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
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  shortList: {
    marginTop: 18,
  },
  title: {
    fontSize: 26,
    fontWeight: '400',
    textAlign: 'center',
  },
  actionButton: {
    flex: 1,
    minHeight: 42,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  actionGrid: {
    gap: 8,
    marginTop: 14,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionText: {
    fontSize: 17,
    fontWeight: '600',
  },
});
