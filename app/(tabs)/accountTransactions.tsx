import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Button from '@/components/themed/Button';
import LoadingSpinner from '@/components/themed/LoadingSpinner';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { Account, getAccounts } from '@/database/tables/accounts';
import { isInvestmentCategoryId, isTransferCategoryId } from '@/database/tables/categories';
import { Currency, getCurrencies } from '@/database/tables/currencies';
import {
  AccountTransactionDetail,
  AccountTransactionPageCursor,
  deleteInvestmentTransaction,
  deleteTransaction,
  deleteTransferTransaction,
  getAccountTransactionDetailsPage,
} from '@/database/tables/transactions';
import { useAppTheme } from '@/hooks/useAppTheme';
import { formatCurrencyAmount } from '@/utils/moneyInput';
import { parseDbDate } from '@/utils/dbDate';
import { useErrorState } from '@/hooks/useErrorState';
import ErrorText from '@/components/themed/ErrorText';

type AccountTransactionParams = {
  accountId?: string;
};

const transactionsPageSize = 50;

const parsePositiveInteger = (value: string | string[] | undefined) => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const parsedValue = Number(rawValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
};

const formatDisplayDate = (rawDate: string | Date) =>
  parseDbDate(rawDate).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

const getDeleteConfirmationMessage = (transaction: AccountTransactionDetail) => {
  if (isTransferCategoryId(transaction.CategoryId)) {
    return 'This transaction is one half of a transfer. Deleting it will delete BOTH halves and update both account balances. Continue?';
  }
  if (isInvestmentCategoryId(transaction.CategoryId)) {
    return 'Deleting this transaction will also update the related investment quantity and the account balance. Continue?';
  }
  return 'Delete this transaction? The account balance will be updated. This cannot be undone.';
};

export default function AccountTransactionsScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<AccountTransactionParams>();
  const router = useRouter();
  const { colors } = useAppTheme();
  const accountId = parsePositiveInteger(params.accountId);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [transactions, setTransactions] = useState<AccountTransactionDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [message, setMessage] = useErrorState();
  const [deletingTransaction, setDeletingTransaction] = useState<AccountTransactionDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [popupMessage, setPopupMessage] = useState<{ detail?: string; message: string; title?: string; variant: 'danger' | 'success' } | null>(null);
  const loadingMoreRef = useRef(false);

  const selectedAccount = accounts.find((account) => account.Id === accountId);
  const currencyById = useMemo(
    () => new Map(currencies.map((currency) => [currency.Id, currency])),
    [currencies]
  );
  const selectedCurrency = selectedAccount ? currencyById.get(selectedAccount.CurrencyId) : undefined;

  const loadData = useCallback(async () => {
    if (!accountId) {
      setLoading(false);
      setMessage('Account could not be found.');
      return;
    }

    setLoading(true);

    const [accountResult, currencyResult, transactionResult] = await Promise.all([
      getAccounts(),
      getCurrencies(),
      getAccountTransactionDetailsPage(accountId, transactionsPageSize),
    ]);

    setLoading(false);

    if (accountResult.Status === 'Success') {
      setAccounts(accountResult.Data);
    } else {
      setMessage(accountResult.Message ?? 'Unable to load account.', accountResult.Detail);
      return;
    }

    if (currencyResult.Status === 'Success') {
      setCurrencies(currencyResult.Data);
    } else {
      setMessage(currencyResult.Message ?? 'Unable to load currencies.', currencyResult.Detail);
      return;
    }

    if (transactionResult.Status === 'Success') {
      setTransactions(transactionResult.Data);
      setHasMore(transactionResult.Data.length === transactionsPageSize);
      setMessage('');
    } else {
      setTransactions([]);
      setHasMore(false);
      setMessage(transactionResult.Message ?? 'Unable to load transactions.', transactionResult.Detail);
    }
  }, [accountId]);

  // Reload on focus so the list reflects edits made on the edit screen.
  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const openEdit = (transaction: AccountTransactionDetail) => {
    router.push({
      pathname: '/createTransaction',
      params: { editTransactionId: transaction.Id.toString() },
    });
  };

  const confirmDelete = async () => {
    if (!deletingTransaction || deleting) {
      return;
    }

    setDeleting(true);

    const result = isTransferCategoryId(deletingTransaction.CategoryId)
      ? await deleteTransferTransaction(deletingTransaction.Id)
      : isInvestmentCategoryId(deletingTransaction.CategoryId)
        ? await deleteInvestmentTransaction(deletingTransaction.Id)
        : await deleteTransaction(deletingTransaction.Id);

    setDeleting(false);
    setDeletingTransaction(null);

    if (result.Status === 'Success') {
      await loadData();
      setPopupMessage({ message: 'Transaction deleted.', title: 'Deleted', variant: 'success' });
      return;
    }

    setPopupMessage({ detail: result.Detail, message: result.Message ?? 'Failed to delete transaction.', variant: 'danger' });
  };

  const loadMore = useCallback(async () => {
    if (!accountId || !hasMore || loading || loadingMoreRef.current || transactions.length === 0) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);

    const lastTransaction = transactions[transactions.length - 1];
    const cursor: AccountTransactionPageCursor = {
      id: lastTransaction.Id,
      transactionDate: lastTransaction.TransactionDate,
    };
    const result = await getAccountTransactionDetailsPage(accountId, transactionsPageSize, cursor);

    loadingMoreRef.current = false;
    setLoadingMore(false);

    if (result.Status === 'Success') {
      setTransactions((current) => [...current, ...result.Data]);
      setHasMore(result.Data.length === transactionsPageSize);
    } else {
      setHasMore(false);
      setMessage(result.Message ?? 'Unable to load more transactions.', result.Detail);
    }
  }, [accountId, hasMore, loading, transactions]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <FlatList
        testID="accountTransactions.list"
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 12, paddingBottom: 24 }]}
        data={transactions}
        keyExtractor={(transaction) => String(transaction.Id)}
        ListEmptyComponent={
          loading ? (
            <LoadingSpinner />
          ) : (
            <ErrorText
              color={colors.textMuted}
              detail={message.detail}
              message={message.message || 'No transactions yet.'}
              textStyle={styles.message}
            />
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <LoadingSpinner size="small" />
          ) : !loading && message.message && transactions.length > 0 ? (
            <ErrorText color={colors.textMuted} detail={message.detail} message={message.message} textStyle={styles.message} />
          ) : null
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Go back"
              accessibilityRole="button"
              onPress={() => router.back()}
              style={styles.backButton}
              testID="accountTransactions.back">
              <FontAwesome name="angle-left" size={28} color={colors.text} />
            </Pressable>
            <View style={styles.headerTitleWrap}>
              <Text style={styles.title}>Transactions</Text>
              <Text style={[styles.subtitle, { color: colors.textMuted }]}>{selectedAccount?.Name ?? 'Account'}</Text>
            </View>
            <View style={styles.backButton} />
          </View>
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <TransactionRow
            currency={selectedCurrency}
            transaction={item}
            onDelete={() => setDeletingTransaction(item)}
            onEdit={() => openEdit(item)}
          />
        )}
        showsVerticalScrollIndicator={false}
      />

      <Modal
        animationType="fade"
        transparent
        visible={deletingTransaction !== null}
        onRequestClose={() => (deleting ? undefined : setDeletingTransaction(null))}>
        <View style={styles.modalBackdrop}>
          <Pressable
            style={styles.modalBackdropPressable}
            onPress={() => (deleting ? undefined : setDeletingTransaction(null))}
          />
          <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={styles.modalTitle}>Delete Transaction</Text>
            {deletingTransaction ? (
              <Text style={styles.modalText}>{getDeleteConfirmationMessage(deletingTransaction)}</Text>
            ) : null}
            <View style={styles.modalActions}>
              <Button disabled={deleting} onPress={() => setDeletingTransaction(null)} size="small" testID="accountTransactions.deleteCancel">
                Cancel
              </Button>
              <Button disabled={deleting} onPress={confirmDelete} size="small" testID="accountTransactions.deleteConfirm" variant="danger">
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </View>
          </View>
        </View>
      </Modal>

      {popupMessage ? (
        <Popup
          detail={popupMessage.detail}
          message={popupMessage.message}
          onClose={() => setPopupMessage(null)}
          style={[styles.popup, { bottom: insets.bottom + 16 }]}
          title={popupMessage.title}
          variant={popupMessage.variant}
        />
      ) : null}
    </View>
  );
}

function TransactionRow({
  currency,
  transaction,
  onDelete,
  onEdit,
}: {
  currency?: Currency;
  transaction: AccountTransactionDetail;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const { colors } = useAppTheme();
  const isIncome = Boolean(transaction.IsIncome);
  const amountPrefix = isIncome ? '+' : '-';
  const amountColor = isIncome ? colors.successText : colors.dangerText;

  return (
    <View collapsable={false} style={[styles.row, { borderColor: colors.border }]} testID={`accountTransactions.row.${transaction.Id}`}>
      <View style={styles.rowText}>
        <Text style={styles.category}>{transaction.CategoryName}</Text>
        <Text style={[styles.date, { color: colors.textMuted }]}>{formatDisplayDate(transaction.TransactionDate)}</Text>
        {transaction.Description ? (
          <Text style={[styles.description, { color: colors.textMuted }]}>{transaction.Description}</Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.amount, { color: amountColor }]}>
          {amountPrefix}{formatCurrencyAmount(transaction.Amount, currency)}
        </Text>
        <View style={styles.rowActions}>
          <Pressable
            accessibilityLabel="Edit transaction"
            accessibilityRole="button"
            onPress={onEdit}
            testID={`accountTransactions.edit.${transaction.Id}`}
            style={({ pressed }) => [styles.rowActionButton, pressed && styles.pressed]}>
            <FontAwesome name="pencil" size={16} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityLabel="Delete transaction"
            accessibilityRole="button"
            onPress={onDelete}
            testID={`accountTransactions.delete.${transaction.Id}`}
            style={({ pressed }) => [styles.rowActionButton, pressed && styles.pressed]}>
            <FontAwesome name="trash-o" size={16} color={colors.dangerText} />
          </Pressable>
        </View>
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
  backButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  category: {
    fontSize: 16,
    fontWeight: '600',
  },
  container: {
    paddingHorizontal: 16,
  },
  date: {
    fontSize: 13,
    marginTop: 2,
  },
  description: {
    fontSize: 14,
    lineHeight: 19,
    marginTop: 4,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerTitleWrap: {
    alignItems: 'center',
    flex: 1,
  },
  message: {
    fontSize: 14,
    marginTop: 18,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
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
    maxWidth: 390,
    padding: 16,
    width: '92%',
  },
  modalText: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 14,
  },
  popup: {
    left: 16,
    maxWidth: 420,
    position: 'absolute',
    right: 16,
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
