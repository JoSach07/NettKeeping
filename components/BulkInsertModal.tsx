import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import Button from '@/components/themed/Button';
import Popup from '@/components/themed/Popup';
import Text from '@/components/themed/Text';
import { insertBulkImport } from '@/database/tables/transactions';
import { useAppTheme } from '@/hooks/useAppTheme';
import {
  BulkInsertRow,
  BulkInsertRowError,
  BulkInvestmentRow,
  BulkTransferRow,
  readBulkInsertFile,
  selectBulkInsertFile,
} from '@/utils/bulkInsertImport';
import {
  BulkInsertAvailability,
  exportBulkInsertTemplate,
  getBulkInsertAvailability,
  templateFileName,
} from '@/utils/bulkInsertTemplate';
import { formatQuantity, formatUnitValue } from '@/utils/investmentNumbers';
import { formatCurrencyAmount } from '@/utils/moneyInput';

type BulkInsertModalProps = {
  onClose: () => void;
  // Fires only after rows are actually committed, so the screen behind can
  // refresh what it derives from the database.
  onImported: () => void;
  onResult: (
    message: string,
    variant: 'danger' | 'success' | 'warning',
    title?: string,
    detail?: string
  ) => void;
  visible: boolean;
};

type BusyState = 'file' | 'import' | 'template' | null;

// Failures are shown inside this modal rather than handed to the screen
// behind it. A Modal is its own native window, so a popup rendered by the
// screen sits behind it and is never seen — which is exactly how the
// "export directory is not configured" message went missing. Successes still
// go to the screen, because the modal has closed by then.
type ModalError = {
  detail?: string;
  message: string;
};

type Preview = {
  errors: BulkInsertRowError[];
  investments: BulkInvestmentRow[];
  rows: BulkInsertRow[];
  transfers: BulkTransferRow[];
};

// The list mixes three shapes, so each entry says which it is rather than the
// renderer guessing from the fields present.
type PreviewItem =
  | { kind: 'investment'; row: BulkInvestmentRow }
  | { kind: 'transaction'; row: BulkInsertRow }
  | { kind: 'transfer'; row: BulkTransferRow };

// Long error lists are truncated rather than rendered in full: past a certain
// point the file is wrong in a way that needs fixing at the source, and a
// thousand rows of red is not more informative than the first few dozen.
const maxRenderedErrors = 40;

type AccountSummary = {
  currencyCode: string;
  currencyNumberToBasic: number;
  income: number;
  name: string;
  spending: number;
};

// The money helpers take the currency in its database shape.
const currencyOf = (summary: AccountSummary) => ({
  Code: summary.currencyCode,
  NumberToBasic: summary.currencyNumberToBasic,
});

// Transfers count towards the totals like anything else: money leaving an
// account is money leaving it, whatever the reason. Leaving them out would
// make the totals disagree with the balances after importing, which is the
// one thing this block exists to let you check.
const summariseByAccount = (
  rows: BulkInsertRow[],
  transfers: BulkTransferRow[],
  investments: BulkInvestmentRow[]
) => {
  const summaries = new Map<string, AccountSummary>();
  const summaryFor = (name: string, currencyCode: string, currencyNumberToBasic: number) => {
    const summary = summaries.get(name) ?? {
      currencyCode,
      currencyNumberToBasic,
      income: 0,
      name,
      spending: 0,
    };

    summaries.set(name, summary);
    return summary;
  };

  for (const row of rows) {
    const summary = summaryFor(row.accountName, row.currencyCode, row.currencyNumberToBasic);

    if (row.isIncome) {
      summary.income += row.amountMinorUnits;
    } else {
      summary.spending += row.amountMinorUnits;
    }
  }

  for (const transfer of transfers) {
    summaryFor(transfer.fromAccountName, transfer.fromCurrencyCode, transfer.fromCurrencyNumberToBasic)
      .spending += transfer.fromAmountMinorUnits;
    summaryFor(transfer.toAccountName, transfer.toCurrencyCode, transfer.toCurrencyNumberToBasic)
      .income += transfer.toAmountMinorUnits;
  }

  // Buying takes money out of the account, selling puts it back in.
  for (const investment of investments) {
    const summary = summaryFor(
      investment.accountName,
      investment.currencyCode,
      investment.currencyNumberToBasic
    );

    if (investment.isBuy) {
      summary.spending += investment.transactionAmountMinorUnits;
    } else {
      summary.income += investment.transactionAmountMinorUnits;
    }
  }

  return [...summaries.values()];
};

export default function BulkInsertModal({ onClose, onImported, onResult, visible }: BulkInsertModalProps) {
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState<BusyState>(null);
  const [modalError, setModalError] = useState<ModalError | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [availability, setAvailability] = useState<BulkInsertAvailability | null>(null);

  // Read when the modal opens rather than once on mount: an investment or an
  // account may have been created since this screen was last visited.
  useEffect(() => {
    if (!visible) {
      return;
    }

    let cancelled = false;

    void getBulkInsertAvailability()
      .then((result) => {
        if (!cancelled) {
          setAvailability(result);
        }
      })
      // A failure here only costs the explanatory note, so it stays silent
      // rather than blocking the buttons behind an error.
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [visible]);

  const accountSummaries = useMemo(
    () => (preview ? summariseByAccount(preview.rows, preview.transfers, preview.investments) : []),
    [preview]
  );

  // One list, sorted by date across both kinds, so the preview reads as the
  // sequence of things that will happen rather than as two separate piles.
  const previewItems = useMemo<PreviewItem[]>(() => {
    if (!preview) {
      return [];
    }

    return [
      ...preview.rows.map((row) => ({ kind: 'transaction' as const, row })),
      ...preview.transfers.map((row) => ({ kind: 'transfer' as const, row })),
      ...preview.investments.map((row) => ({ kind: 'investment' as const, row })),
    ].sort((left, right) => left.row.transactionDate.localeCompare(right.row.transactionDate));
  }, [preview]);

  const dateRange = useMemo(() => {
    if (!previewItems.length) {
      return null;
    }

    const first = previewItems[0].row.transactionDate;
    const last = previewItems[previewItems.length - 1].row.transactionDate;

    return first === last ? first : `${first} to ${last}`;
  }, [previewItems]);

  const incomeCount = preview?.rows.filter((row) => row.isIncome).length ?? 0;
  const spendingCount = (preview?.rows.length ?? 0) - incomeCount;
  const transferCount = preview?.transfers.length ?? 0;
  const investmentCount = preview?.investments.length ?? 0;

  // Only the sheet that is actually missing gets named: telling someone with
  // three accounts that "Transfers requires more than one account" while the
  // Transfers sheet is in their file reads as a fault. The fix is the same two
  // steps either way, so the closing sentence is shared.
  const missingSheetNotice = useMemo(() => {
    if (!availability) {
      return null;
    }

    const reasons: string[] = [];

    if (availability.accountCount < 2) {
      reasons.push('Transfers requires more than one account');
    }

    if (availability.investmentCount === 0) {
      reasons.push('Investments requires an existing investment');
    }

    if (reasons.length === 0) {
      return null;
    }

    return `Bulk Insert is available, but ${reasons.join(' and ')}.`
      + ' Create what you need in the app, then download the template again.';
  }, [availability]);
  const hasErrors = (preview?.errors.length ?? 0) > 0;
  const ambiguousCount = previewItems.filter((item) => item.row.amountNote !== null).length;

  // Amounts are shown through the app's own formatter, so what the row will
  // actually store is what you read — which is the whole point of the review
  // step. A separator typed out of habit shows up here as a wrong magnitude.
  const renderRow = useCallback(({ item }: { item: PreviewItem }) => {
    if (item.kind === 'investment') {
      const currency = {
        Code: item.row.currencyCode,
        NumberToBasic: item.row.currencyNumberToBasic,
      };
      const unit = item.row.unit ? ` ${item.row.unit}` : '';

      return (
        <View
          collapsable={false}
          style={[styles.row, { borderColor: colors.border }]}
          testID={`bulkInsert.preview.row.${item.row.rowLabel}`}>
          <View style={styles.rowMain}>
            <Text style={styles.rowPrimary} numberOfLines={1}>
              {item.row.isBuy ? 'Buy' : 'Sell'}
              <Text style={{ color: colors.textMuted }}>
                {` ${item.row.investmentName} · ${item.row.accountName}`}
              </Text>
            </Text>
            <Text style={[styles.rowSecondary, { color: colors.textMuted }]} numberOfLines={1}>
              {`${item.row.transactionDate} · ${formatQuantity(item.row.quantity, item.row.quantityDecimals)}${unit} at ${formatUnitValue(item.row.unitValueMinorUnits, currency)}`}
              {item.row.additionalFeesMinorUnits
                ? ` · fees ${formatCurrencyAmount(item.row.additionalFeesMinorUnits, currency)}`
                : ''}
            </Text>
            {item.row.amountNote ? (
              <Text style={[styles.rowNote, { color: colors.dangerText }]}>{item.row.amountNote}</Text>
            ) : null}
          </View>
          <Text style={styles.rowAmount} numberOfLines={1}>
            {`${item.row.isBuy ? '-' : '+'}${formatCurrencyAmount(item.row.transactionAmountMinorUnits, currency)}`}
          </Text>
        </View>
      );
    }

    const isTransfer = item.kind === 'transfer';
    // A cross-currency transfer sends one number and receives another, so both
    // are shown; a same-currency one would just repeat itself.
    const sent = isTransfer
      ? formatCurrencyAmount(item.row.fromAmountMinorUnits, {
        Code: item.row.fromCurrencyCode,
        NumberToBasic: item.row.fromCurrencyNumberToBasic,
      })
      : '';
    const received = isTransfer
      ? formatCurrencyAmount(item.row.toAmountMinorUnits, {
        Code: item.row.toCurrencyCode,
        NumberToBasic: item.row.toCurrencyNumberToBasic,
      })
      : '';

    return (
      <View
        collapsable={false}
        style={[styles.row, { borderColor: colors.border }]}
        testID={`bulkInsert.preview.row.${item.row.rowLabel}`}>
        <View style={styles.rowMain}>
          <Text style={styles.rowPrimary} numberOfLines={1}>
            {isTransfer ? 'Transfer' : item.row.categoryName}
            <Text style={{ color: colors.textMuted }}>
              {isTransfer
                ? ` · ${item.row.fromAccountName} → ${item.row.toAccountName}`
                : ` · ${item.row.accountName}`}
            </Text>
          </Text>
          <Text style={[styles.rowSecondary, { color: colors.textMuted }]} numberOfLines={1}>
            {item.row.description ? `${item.row.transactionDate} · ${item.row.description}` : item.row.transactionDate}
          </Text>
          {item.row.amountNote ? (
            <Text style={[styles.rowNote, { color: colors.dangerText }]}>{item.row.amountNote}</Text>
          ) : null}
        </View>
        <Text style={styles.rowAmount} numberOfLines={1}>
          {isTransfer
            ? (sent === received ? sent : `${sent} → ${received}`)
            : `${item.row.isIncome ? '+' : '-'}${formatCurrencyAmount(item.row.amountMinorUnits, {
              Code: item.row.currencyCode,
              NumberToBasic: item.row.currencyNumberToBasic,
            })}`}
        </Text>
      </View>
    );
  }, [colors.border, colors.dangerText, colors.textMuted]);

  const handleClose = () => {
    if (busy) {
      return;
    }

    setModalError(null);
    setPreview(null);
    onClose();
  };

  // Same as handleClose without the busy guard: used at the end of an action
  // that has just finished, where busy is still set for one more moment.
  const handleCloseAfterAction = () => {
    setModalError(null);
    setPreview(null);
    onClose();
  };

  const handleDownloadTemplate = async () => {
    if (busy) {
      return;
    }

    setModalError(null);
    setBusy('template');
    const result = await exportBulkInsertTemplate();
    setBusy(null);

    if (result.Status === 'Success') {
      onResult(
        `Template saved as ${templateFileName}. Fill it in and upload it here.`,
        'success',
        'Template ready'
      );
      handleCloseAfterAction();
      return;
    }

    setModalError({
      detail: result.Detail,
      message: result.Message ?? 'Failed to create the template.',
    });
  };

  const handleUpload = async () => {
    if (busy) {
      return;
    }

    setModalError(null);
    setBusy('file');
    const picked = await selectBulkInsertFile();

    if (picked.Status === 'Cancelled') {
      setBusy(null);
      return;
    }

    if (picked.Status === 'Error' || !picked.Uri) {
      setBusy(null);
      setModalError({
        detail: picked.Detail,
        message: picked.Message ?? 'Selected file could not be read.',
      });
      return;
    }

    const result = await readBulkInsertFile(picked.Uri);
    setBusy(null);

    if (result.Status !== 'Success') {
      setModalError({
        detail: result.Detail,
        message: result.Message ?? 'Failed to read the file.',
      });
      return;
    }

    setPreview({
      errors: result.Errors ?? [],
      investments: result.Investments ?? [],
      rows: result.Rows ?? [],
      transfers: result.Transfers ?? [],
    });
  };

  const handleImport = async () => {
    if (busy || !preview || hasErrors || previewItems.length === 0) {
      return;
    }

    setModalError(null);
    setBusy('import');
    // Both kinds go in one call, and therefore one transaction: a transfer
    // that funds an account has to be able to land alongside spending from
    // that account, whichever order they sit in the file.
    const result = await insertBulkImport(
      preview.rows.map((row) => ({
        AccountId: row.accountId,
        Amount: row.amountMinorUnits,
        CategoryId: row.categoryId,
        Description: row.description,
        TransactionDate: row.transactionDate,
      })),
      preview.transfers.map((transfer) => ({
        Description: transfer.description,
        FromAccountId: transfer.fromAccountId,
        FromAmount: transfer.fromAmountMinorUnits,
        TransactionDate: transfer.transactionDate,
        ToAccountId: transfer.toAccountId,
        ToAmount: transfer.toAmountMinorUnits,
      })),
      preview.investments.map((investment) => ({
        AccountId: investment.accountId,
        AdditionalFees: investment.additionalFeesMinorUnits,
        Description: investment.description,
        InvestmentId: investment.investmentId,
        IsBuy: investment.isBuy,
        TransactionDate: investment.transactionDate,
        Quantity: investment.quantity,
        UnitValue: investment.unitValueMinorUnits,
      }))
    );
    setBusy(null);

    if (result.Status === 'Success') {
      const insertedCount = result.InsertedCount ?? previewItems.length;
      onImported();
      onResult(
        `${insertedCount} row${insertedCount === 1 ? '' : 's'} imported.`,
        'success',
        'Import complete'
      );
      handleCloseAfterAction();
      return;
    }

    setModalError({ detail: result.Detail, message: result.Message ?? 'Failed to import these rows.' });
  };

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={handleClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalBackdropPressable} onPress={handleClose} />
        <View style={[styles.modalPanel, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Bulk Insert</Text>
            <Pressable
              accessibilityLabel="Close bulk insert dialog"
              accessibilityRole="button"
              onPress={handleClose}
              style={styles.closeButton}
              testID="bulkInsert.close">
              <FontAwesome name="times" size={18} color={colors.text} />
            </Pressable>
          </View>

          {preview ? (
            <>
              <Text style={styles.summaryLine}>
                {previewItems.length} row{previewItems.length === 1 ? '' : 's'} ready
                {previewItems.length > 0
                  ? ` — ${incomeCount} income, ${spendingCount} spending`
                  + `${transferCount ? `, ${transferCount} transfer${transferCount === 1 ? '' : 's'}` : ''}`
                  + `${investmentCount ? `, ${investmentCount} investment${investmentCount === 1 ? '' : 's'}` : ''}`
                  : ''}
              </Text>

              {dateRange ? (
                <Text style={[styles.helperText, { color: colors.textMuted }]}>{dateRange}</Text>
              ) : null}

              {hasErrors ? (
                <>
                  <Text style={[styles.errorHeading, { color: colors.dangerText }]}>
                    {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} cannot be imported.
                    Fix the file and upload it again — nothing is imported until every row is valid.
                  </Text>

                  <ScrollView style={styles.detailScroll} testID="bulkInsert.preview.errors">
                    {preview.errors.slice(0, maxRenderedErrors).map((error, index) => (
                      <Text key={`${error.rowLabel}-${index}`} style={styles.detailLine}>
                        <Text style={styles.detailLabel}>{error.rowLabel}: </Text>
                        {error.message}
                      </Text>
                    ))}

                    {preview.errors.length > maxRenderedErrors ? (
                      <Text style={[styles.helperText, { color: colors.textMuted }]}>
                        and {preview.errors.length - maxRenderedErrors} more.
                      </Text>
                    ) : null}
                  </ScrollView>
                </>
              ) : (
                <>
                  {/* Totals first: they are what catches a wrong magnitude in a
                      file too long to read line by line. */}
                  <View style={[styles.totalsBlock, { borderColor: colors.border }]}>
                    {accountSummaries.map((summary) => (
                      <Text key={summary.name} style={styles.detailLine}>
                        <Text style={styles.detailLabel}>{summary.name}: </Text>
                        {`+${formatCurrencyAmount(summary.income, currencyOf(summary))} / -${formatCurrencyAmount(summary.spending, currencyOf(summary))}`}
                      </Text>
                    ))}
                  </View>

                  {ambiguousCount > 0 ? (
                    <Text style={[styles.errorHeading, { color: colors.dangerText }]}>
                      {ambiguousCount} amount{ambiguousCount === 1 ? '' : 's'} used a separator that could be
                      read more than one way. Those rows are marked below — check them before importing.
                    </Text>
                  ) : null}

                  {/* Virtualised: the row cap is 2,000 and a ScrollView would
                      mount every one of them. */}
                  <FlatList
                    data={previewItems}
                    initialNumToRender={12}
                    keyExtractor={(item) => item.row.rowLabel}
                    renderItem={renderRow}
                    style={styles.rowList}
                    testID="bulkInsert.preview.list"
                  />
                </>
              )}

              <View style={styles.actions}>
                <Button disabled={busy !== null} onPress={() => setPreview(null)} size="small" testID="bulkInsert.back">
                  Back
                </Button>
                <Button
                  disabled={busy !== null || hasErrors || previewItems.length === 0}
                  onPress={handleImport}
                  size="small"
                  testID="bulkInsert.import"
                  variant="primary">
                  {busy === 'import' ? 'Importing...' : 'Import'}
                </Button>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.helperText, { color: colors.textMuted }]}>
                Fill in the template and upload it to add many rows at once. Bulk Insert for income and
                spending, Transfers to move money between accounts, Investments to buy and sell.
              </Text>

              {/* Said here rather than left to be discovered as a missing tab:
                  a sheet that cannot produce a valid row is left out, and its
                  absence should not look like a bug. Written as one sentence
                  so it reads correctly whichever combination is missing. */}
              {missingSheetNotice ? (
                <Text style={[styles.helperText, { color: colors.textMuted }]}>{missingSheetNotice}</Text>
              ) : null}

              {/* Stacked, full width: side by side, "Download Template" plus the
                  longer busy label ("Reading...") overflowed the panel. Order
                  follows the steps: get the template, then upload it. */}
              <View style={styles.actionsStacked}>
                <Button disabled={busy !== null} onPress={handleDownloadTemplate} size="small" testID="bulkInsert.downloadTemplate">
                  {busy === 'template' ? 'Saving...' : 'Download Template'}
                </Button>
                <Button
                  disabled={busy !== null}
                  onPress={handleUpload}
                  size="small"
                  testID="bulkInsert.upload"
                  variant="primary">
                  {busy === 'file' ? 'Reading...' : 'Upload'}
                </Button>
              </View>
            </>
          )}

          {modalError ? (
            <Popup
              detail={modalError.detail}
              message={modalError.message}
              onClose={() => setModalError(null)}
              style={styles.modalPopup}
              variant="danger"
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 18,
  },
  actionsStacked: {
    gap: 10,
    marginTop: 18,
  },
  closeButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  detailLabel: {
    fontWeight: '600',
  },
  detailLine: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 6,
  },
  detailScroll: {
    marginTop: 12,
    maxHeight: 220,
  },
  errorHeading: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
  },
  helperText: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
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
    // Tall enough for the row list to be worth scrolling; the panel still
    // shrinks to its content on the two-button menu.
    maxHeight: '85%',
    maxWidth: 420,
    padding: 16,
    width: '92%',
  },
  row: {
    alignItems: 'center',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  rowAmount: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowList: {
    // An explicit bound rather than flex:1, so the list is scrollable no
    // matter how the panel resolves its own height on a given screen.
    flexGrow: 0,
    marginTop: 12,
    maxHeight: 320,
  },
  rowMain: {
    flexShrink: 1,
  },
  rowNote: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  rowPrimary: {
    fontSize: 15,
  },
  rowSecondary: {
    fontSize: 13,
    lineHeight: 18,
  },
  modalPopup: {
    marginTop: 14,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '600',
  },
  summaryLine: {
    fontSize: 16,
    fontWeight: '600',
  },
  totalsBlock: {
    borderRadius: 6,
    borderWidth: 1,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingTop: 8,
  },
});
