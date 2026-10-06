import { DbExecutor, DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult, runInTransaction } from "../dbService";
import { describeError } from '@/utils/userFacingError';
import { InvestmentReplayEntry, replayInvestmentEntries } from "../investmentReplay";
import {
    INVESTMENT_CATEGORY_ID,
    INVESTMENT_LIQUIDATION_CATEGORY_ID,
    isInvestmentCategoryId,
    isReservedCategoryId,
    isTransferCategoryId,
    TRANSFER_FROM_CATEGORY_ID,
    TRANSFER_INTO_CATEGORY_ID,
} from "./categories";
import { calculateInvestmentAmount } from "@/utils/investmentNumbers";

const investmentAmountTooLargeMessage = 'This investment amount is too large to record.';

export interface Transaction{
    Id: number;
    Description: string | null;
    CategoryId: number;
    Amount: number;
    AccountId: number;
    TransactionDate: Date;
}

export interface GetMostUsedIdResult extends GetResult{
    DataId: number | null
}

export interface CategoryTransactionSummary {
    CategoryId: number;
    CategoryName: string;
    HexColor: string;
    Amount: number;
}

export interface GetCategoryTransactionSummaryResult extends GetResult {
    Data: CategoryTransactionSummary[]
}

export interface AccountTransactionDetail {
    Id: number;
    Description: string | null;
    CategoryId: number;
    CategoryName: string;
    Amount: number;
    AccountId: number;
    TransactionDate: string;
    IsIncome: boolean;
}

// Everything the edit form needs, resolved per transaction family.
export interface TransactionEditDetails {
    Kind: 'normal' | 'transfer' | 'investment';
    Id: number;
    Description: string | null;
    CategoryId: number;
    TransactionTypeId: number;
    Amount: number;
    AccountId: number;
    TransactionDate: string;
    FromAccountId?: number;
    ToAccountId?: number;
    FromAmount?: number;
    ToAmount?: number;
    InvestmentId?: number;
    // Scaled by QuantityDecimals; unit value in minor units x 10^4.
    Quantity?: number;
    QuantityDecimals?: number;
    UnitValue?: number;
    AdditionalFees?: number;
}

export interface GetTransactionEditDetailsResult extends GetResult {
    Data: TransactionEditDetails | null
}

export interface GetAccountTransactionDetailResult extends GetResult {
    Data: AccountTransactionDetail[]
}

// One row of a bulk insert, already resolved to ids and minor units by
// utils/bulkInsertImport. Amounts are always positive: income and spending are
// distinguished by the category, exactly as they are for a single transaction.
export interface BulkTransactionInput {
    Description: string | null;
    CategoryId: number;
    Amount: number;
    AccountId: number;
    TransactionDate: string;
}

// One transfer, already resolved. Both amounts are held because a
// cross-currency transfer sends one number and receives another; for a
// same-currency transfer they are equal.
export interface BulkTransferInput {
    Description: string | null;
    FromAccountId: number;
    ToAccountId: number;
    FromAmount: number;
    ToAmount: number;
    TransactionDate: string;
}

// Quantity and unit value rather than a total: the amount is derived here so
// it cannot disagree with the history entry written alongside it.
export interface BulkInvestmentInput {
    Description: string | null;
    AccountId: number;
    InvestmentId: number;
    IsBuy: boolean;
    Quantity: number;
    UnitValue: number;
    AdditionalFees: number;
    TransactionDate: string;
}

export interface BulkInsertTransactionsResult {
    Status: 'Success' | 'Error';
    Message?: string;
    Detail?: string;
    InsertedCount?: number;
}

type AccountBalanceState = {
    Balance: number;
    CurrencyId: number;
    OpeningBalance: number;
    OpeningBalanceDate: string;
    BalanceAnchorDate: string;
    CreatedAt: string;
}

type TransactionBalanceRow = {
    Amount: number;
    IsIncome: number;
    TransactionDate: string;
}

type ExistingTransactionRow = {
    AccountId: number;
    CategoryId: number;
}

type TransferGroupRow = {
    Id: number;
    TransactionIdFrom: number;
    TransactionIdTo: number;
}

type TransferLegRow = {
    Id: number;
    AccountId: number;
    Amount: number;
    TransactionDate: string;
    Description: string | null;
}

type InvestmentHistoryLinkRow = {
    Id: number;
    InvestmentId: number;
}

const getTransactionBalanceChange = (amount: number, isIncome: boolean): number => (
    isIncome ? amount : -amount
);

// Future dates are refused rather than half-supported. Balances are a single
// stored number that replays EVERY transaction regardless of date, while every
// history view and chart stops at today — so a future-dated row moves the
// balance now and hides the evidence. NettKeeping has no scheduled or recurring
// concept for such a row to belong to, so the rule is simply: not yet.
//
// Compared as LOCAL calendar days, never UTC: `new Date("2026-09-10")` is UTC
// midnight, which is still "tomorrow" for anyone east of UTC and would reject
// a legitimate same-day entry.
export const futureTransactionDateMessage = 'Date cannot be in the future.';

const getTodayDateOnlyTime = (): number => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

export const isFutureTransactionDate = (transactionDate: string): boolean => (
    parseDateOnlyTime(transactionDate) > getTodayDateOnlyTime()
);

const parseDateOnlyTime = (rawDate: string): number => {
    const dateOnly = rawDate.split(/[ T]/)[0];
    return new Date(`${dateOnly}T00:00:00`).getTime();
};

const getNextAccountBalanceState = (
    account: AccountBalanceState,
    amount: number,
    isIncome: boolean,
    transactionDate: string
) => {
    const balanceChange = getTransactionBalanceChange(amount, isIncome);
    const transactionTime = parseDateOnlyTime(transactionDate);
    const openingTime = parseDateOnlyTime(account.OpeningBalanceDate);
    const anchorTime = parseDateOnlyTime(account.BalanceAnchorDate);
    const isBeforeBalanceAnchor = transactionTime < anchorTime;

    if (isBeforeBalanceAnchor) {
        return {
            balance: account.Balance,
            openingBalance: account.OpeningBalance - balanceChange,
            openingBalanceDate: transactionTime < openingTime ? transactionDate : account.OpeningBalanceDate,
        };
    }

    return {
        balance: account.Balance + balanceChange,
        openingBalance: account.OpeningBalance,
        openingBalanceDate: account.OpeningBalanceDate,
    };
};

const updateAccountBalanceState = async (
    db: DbExecutor,
    accountId: number,
    balance: number,
    openingBalance: number,
    openingBalanceDate: string
) => {
    await db.runAsync(
        `UPDATE Accounts
         SET Balance = ?,
            OpeningBalance = ?,
            OpeningBalanceDate = ?
         WHERE Id = ?`,
        [balance, openingBalance, openingBalanceDate, accountId]
    );
};

// requireActive should be true when looking up a NEWLY selected target account
// and false when looking up an account an existing transaction already references:
// editing/deleting a transaction on a soft-deleted account must keep working so
// its balance history stays consistent (and stays correct if reactivated).
const getAccountBalanceState = async (
    db: DbExecutor,
    accountId: number,
    requireActive: boolean
): Promise<AccountBalanceState | null> => (
    await db.getFirstAsync<AccountBalanceState>(
        `SELECT Balance, CurrencyId, OpeningBalance, OpeningBalanceDate, BalanceAnchorDate, CreatedAt
         FROM Accounts
         WHERE Id = ?${requireActive ? ' AND IsActive = 1' : ''}`,
        [accountId]
    ) ?? null
);

const getAccountAnchorBalance = async (
    db: DbExecutor,
    account: AccountBalanceState,
    accountId: number
): Promise<number> => {
    const preAnchorTransactions = await db.getAllAsync<TransactionBalanceRow>(
        `SELECT t.Amount, tt.IsIncome, t.TransactionDate
         FROM Transactions t
         INNER JOIN Categories c ON c.Id = t.CategoryId
         INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
         WHERE t.AccountId = ?
            AND date(t.TransactionDate) < date(?)
         ORDER BY date(t.TransactionDate) ASC, t.Id ASC`,
        [accountId, account.BalanceAnchorDate]
    );

    return preAnchorTransactions.reduce(
        (balance, transaction) => balance + getTransactionBalanceChange(transaction.Amount, Boolean(transaction.IsIncome)),
        account.OpeningBalance
    );
};

const rebuildAccountBalanceState = async (
    db: DbExecutor,
    accountId: number,
    anchorBalance: number
): Promise<{ Status: 'Success' | 'Error'; Message?: string }> => {
    const account = await getAccountBalanceState(db, accountId, false);
    if (!account) {
        return {
            Status: 'Error',
            Message: 'Selected account could not be found.',
        };
    }

    const transactions = await db.getAllAsync<TransactionBalanceRow>(
        `SELECT t.Amount, tt.IsIncome, t.TransactionDate
         FROM Transactions t
         INNER JOIN Categories c ON c.Id = t.CategoryId
         INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
         WHERE t.AccountId = ?
         ORDER BY date(t.TransactionDate) ASC, t.Id ASC`,
        [accountId]
    );
    const anchorTime = parseDateOnlyTime(account.BalanceAnchorDate);
    const preAnchorTransactions = transactions.filter((transaction) => parseDateOnlyTime(transaction.TransactionDate) < anchorTime);
    const postAnchorTransactions = transactions.filter((transaction) => parseDateOnlyTime(transaction.TransactionDate) >= anchorTime);
    const preAnchorChange = preAnchorTransactions.reduce(
        (change, transaction) => change + getTransactionBalanceChange(transaction.Amount, Boolean(transaction.IsIncome)),
        0
    );
    const postAnchorChange = postAnchorTransactions.reduce(
        (change, transaction) => change + getTransactionBalanceChange(transaction.Amount, Boolean(transaction.IsIncome)),
        0
    );
    const earliestPreAnchorTransaction = preAnchorTransactions[0];
    const nextOpeningBalanceDate = earliestPreAnchorTransaction?.TransactionDate ?? account.BalanceAnchorDate;
    const nextOpeningBalance = anchorBalance - preAnchorChange;
    const nextBalance = anchorBalance + postAnchorChange;

    if (nextBalance < 0) {
        return {
            Status: 'Error',
            Message: 'This change would make the selected account balance negative.',
        };
    }

    await updateAccountBalanceState(
        db,
        accountId,
        nextBalance,
        nextOpeningBalance,
        nextOpeningBalanceDate
    );

    return {
        Status: 'Success',
    };
};

const getExistingTransaction = async (
    db: DbExecutor,
    id: number
): Promise<ExistingTransactionRow | null> => (
    await db.getFirstAsync<ExistingTransactionRow>(
        'SELECT AccountId, CategoryId FROM Transactions WHERE Id = ?',
        [id]
    ) ?? null
);

const getReservedCategoryEditorMessage = (categoryId: number): string | null => {
    if (isTransferCategoryId(categoryId)) {
        return 'Transfer transactions must be edited or deleted as a pair with the transfer editor.';
    }
    if (isInvestmentCategoryId(categoryId)) {
        return 'Investment transactions must be edited or deleted with the investment editor.';
    }
    return null;
};

const getTransferGroupByTransactionId = async (
    db: DbExecutor,
    transactionId: number
): Promise<TransferGroupRow | null> => (
    await db.getFirstAsync<TransferGroupRow>(
        `SELECT Id, TransactionIdFrom, TransactionIdTo
         FROM TransferTransactionGroups
         WHERE TransactionIdFrom = ? OR TransactionIdTo = ?`,
        [transactionId, transactionId]
    ) ?? null
);

const getTransferLeg = async (
    db: DbExecutor,
    transactionId: number
): Promise<TransferLegRow | null> => (
    await db.getFirstAsync<TransferLegRow>(
        'SELECT Id, AccountId, Amount, TransactionDate, Description FROM Transactions WHERE Id = ?',
        [transactionId]
    ) ?? null
);

// Rebuilds an investment's history snapshots, current quantity, and current
// unit value by replaying its entries in date order — see
// database/investmentReplay.ts for the rules, including the creation entry
// meaning "held this many as of the creation day". Errors if the running
// quantity would dip below zero at ANY point in the timeline, not just at the
// end. All writes are expected to run inside a transaction.
export const rebuildInvestmentState = async (
    db: DbExecutor,
    investmentId: number
): Promise<{ Status: 'Success' | 'Error'; Message?: string }> => {
    const entries = await db.getAllAsync<InvestmentReplayEntry>(
        `SELECT Id, QuantityDelta, Quantity, UnitValue, CreatedAt, IsOpening
         FROM InvestmentHistories
         WHERE InvestmentId = ?`,
        [investmentId]
    );
    const investment = await db.getFirstAsync<{ QuantityDecimals: number }>(
        'SELECT QuantityDecimals FROM Investments WHERE Id = ?',
        [investmentId]
    );

    const replay = replayInvestmentEntries(entries, investment?.QuantityDecimals ?? 0);
    if (replay.Status !== 'Success') {
        return { Status: 'Error', Message: replay.Message };
    }

    for (const entry of entries) {
        const quantity = replay.quantities.get(entry.Id) ?? 0;
        if (entry.Quantity !== quantity) {
            await db.runAsync(
                'UPDATE InvestmentHistories SET Quantity = ? WHERE Id = ?',
                [quantity, entry.Id]
            );
        }
    }

    await db.runAsync(
        'UPDATE Investments SET Quantity = ?, UnitValue = ? WHERE Id = ?',
        [replay.finalQuantity, replay.lastUnitValue, investmentId]
    );

    return { Status: 'Success' };
};

export const getMostUsedTransactionTypeId = async (): Promise<GetMostUsedIdResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const result = await _db.getFirstAsync<{ Id: number }>(
                `SELECT c.TransactionTypeId AS Id
                 FROM Transactions t
                 INNER JOIN Categories c ON c.Id = t.CategoryId
                 GROUP BY c.TransactionTypeId
                 ORDER BY COUNT(*) DESC, MAX(t.Id) DESC
                 LIMIT 1`
            );

            const response: GetMostUsedIdResult = {
                Status: "Success",
                DataId: result?.Id ?? null
            };
            return response;
        } catch (err){
            const response: GetMostUsedIdResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load the most used transaction type.'),
                DataId: null
            };
            return response;
        }
    }else{
        const response: GetMostUsedIdResult = {
            Status: "Error",
            Message: 'Error opening database connection',
            DataId: null
        }
        return response;
    }
}

export const getMostUsedCategoryId = async (transactionTypeId: number): Promise<GetMostUsedIdResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const result = await _db.getFirstAsync<{ Id: number }>(
                `SELECT t.CategoryId AS Id
                 FROM Transactions t
                 INNER JOIN Categories c ON c.Id = t.CategoryId
                 WHERE c.TransactionTypeId = ? AND c.IsActive = 1
                 GROUP BY t.CategoryId
                 ORDER BY COUNT(*) DESC, MAX(t.Id) DESC
                 LIMIT 1`,
                [transactionTypeId]
            );

            const response: GetMostUsedIdResult = {
                Status: "Success",
                DataId: result?.Id ?? null
            };
            return response;
        } catch (err){
            const response: GetMostUsedIdResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load the most used category.'),
                DataId: null
            };
            return response;
        }
    }else{
        const response: GetMostUsedIdResult = {
            Status: "Error",
            Message: 'Error opening database connection',
            DataId: null
        }
        return response;
    }
}

export const getCategoryTransactionSummary = async (
    accountId: number,
    month: number,
    year: number,
    isIncome: boolean
): Promise<GetCategoryTransactionSummaryResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
            const endDate =
                month === 12
                    ? `${year + 1}-01-01`
                    : `${year}-${(month + 1).toString().padStart(2, '0')}-01`;
            const summaries: CategoryTransactionSummary[] = await _db.getAllAsync(
                `SELECT
                    c.Id AS CategoryId,
                    c.Name AS CategoryName,
                    c.HexColor,
                    COALESCE(SUM(t.Amount), 0) AS Amount
                 FROM Transactions t
                 INNER JOIN Categories c ON c.Id = t.CategoryId
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.IsActive = 1
                    AND tt.IsIncome = ?
                    AND t.AccountId = ?
                    AND date(t.TransactionDate) >= date(?)
                    AND date(t.TransactionDate) < date(?)
                 GROUP BY c.Id, c.Name, c.HexColor
                 ORDER BY Amount DESC, c.Name COLLATE NOCASE`,
                [isIncome ? 1 : 0, accountId, startDate, endDate]
            );

            return {
                Status: "Success",
                Data: summaries
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Unable to load category summary.'),
                Data: []
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            Data: []
        }
    }
}

export const getAccountTransactionDetails = async (
    accountId: number,
    limit?: number
): Promise<GetAccountTransactionDetailResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const limitClause = limit && limit > 0 ? ' LIMIT ?' : '';
            const params = limit && limit > 0 ? [accountId, limit] : [accountId];
            const transactions: AccountTransactionDetail[] = await _db.getAllAsync(
                `SELECT
                    t.Id,
                    t.Description,
                    t.CategoryId,
                    c.Name AS CategoryName,
                    t.Amount,
                    t.AccountId,
                    t.TransactionDate,
                    tt.IsIncome
                 FROM Transactions t
                 INNER JOIN Categories c ON c.Id = t.CategoryId
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE t.AccountId = ?
                 ORDER BY date(t.TransactionDate) DESC, t.Id DESC${limitClause}`,
                params
            );

            return {
                Status: "Success",
                Data: transactions
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Unable to load transactions.'),
                Data: []
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            Data: []
        }
    }
}

export interface AccountTransactionPageCursor {
    id: number;
    transactionDate: string;
}

// Keyset pagination: the cursor is the last row of the previous page, so
// pages stay stable even if transactions are inserted while scrolling (unlike
// OFFSET, which can skip or duplicate rows).
export const getAccountTransactionDetailsPage = async (
    accountId: number,
    limit: number,
    cursor?: AccountTransactionPageCursor | null
): Promise<GetAccountTransactionDetailResult> => {
    try {
        const _db = await getDBConnection();
        const cursorClause = cursor
            ? ` AND (date(t.TransactionDate) < date(?)
                OR (date(t.TransactionDate) = date(?) AND t.Id < ?))`
            : '';
        const params = cursor
            ? [accountId, cursor.transactionDate, cursor.transactionDate, cursor.id, limit]
            : [accountId, limit];
        const transactions: AccountTransactionDetail[] = await _db.getAllAsync(
            `SELECT
                t.Id,
                t.Description,
                t.CategoryId,
                c.Name AS CategoryName,
                t.Amount,
                t.AccountId,
                t.TransactionDate,
                tt.IsIncome
             FROM Transactions t
             INNER JOIN Categories c ON c.Id = t.CategoryId
             INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
             WHERE t.AccountId = ?${cursorClause}
             ORDER BY date(t.TransactionDate) DESC, t.Id DESC
             LIMIT ?`,
            params
        );

        return {
            Status: "Success",
            Data: transactions
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Unable to load more transactions.'),
            Data: []
        };
    }
}

export const getAccountTransactionDetailsForRange = async (
    accountId: number,
    startDate: string
): Promise<GetAccountTransactionDetailResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const transactions: AccountTransactionDetail[] = await _db.getAllAsync(
                `SELECT
                    t.Id,
                    t.Description,
                    t.CategoryId,
                    c.Name AS CategoryName,
                    t.Amount,
                    t.AccountId,
                    t.TransactionDate,
                    tt.IsIncome
                 FROM Transactions t
                 INNER JOIN Categories c ON c.Id = t.CategoryId
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 INNER JOIN Accounts a ON a.Id = t.AccountId
                 WHERE t.AccountId = ?
                    AND date(t.TransactionDate) >= date(?)
                    AND date(t.TransactionDate) >= date(a.OpeningBalanceDate)
                 ORDER BY date(t.TransactionDate) ASC, t.Id ASC`,
                [accountId, startDate]
            );

            return {
                Status: "Success",
                Data: transactions
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Unable to load account history.'),
                Data: []
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            Data: []
        }
    }
}

export const insertTransaction = async (
    description: string | null,
    categoryId: number,
    amount: number,
    accountId: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (amount <= 0) {
        return {
            Status: "Error",
            Message: 'Transaction amount must be greater than zero.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    if (isReservedCategoryId(categoryId)) {
        return {
            Status: "Error",
            Message: 'Transfer and investment transactions must be created through their dedicated flows.',
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const account = await getAccountBalanceState(tx, accountId, true);

            if (!account) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            const category = await tx.getFirstAsync<{ IsIncome: number }>(
                `SELECT tt.IsIncome
                 FROM Categories c
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.Id = ? AND c.IsActive = 1`,
                [categoryId]
            );

            if (!category) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected category could not be found.',
                    },
                };
            }

            const isIncome = Boolean(category.IsIncome);
            const nextAccount = getNextAccountBalanceState(account, amount, isIncome, transactionDate);

            if (nextAccount.balance < 0) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Amount is higher than the selected account balance.',
                    },
                };
            }

            const result = await tx.runAsync(
                'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                [description, categoryId, amount, accountId, transactionDate]
            );

            await updateAccountBalanceState(
                tx,
                accountId,
                nextAccount.balance,
                nextAccount.openingBalance,
                nextAccount.openingBalanceDate
            );

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: result.lastInsertRowId,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save transaction.'),
        };
    }
}

// Bulk insert deliberately does NOT loop insertTransaction. Two reasons, both
// about correctness rather than speed:
//
// 1. insertTransaction patches the account balance one row at a time and checks
//    the running total against zero. Imported rows arrive in whatever order
//    the spreadsheet had them, so a spending row that lands before the income
//    row funding it would fail a check that the finished set passes.
// 2. Each call is its own transaction, so a failure halfway leaves the earlier
//    rows written with no way to identify them again.
//
// Instead every row goes in inside one transaction and each affected account is
// rebuilt once at the end, which is the same replay the app already uses after
// an edit or delete, and it checks the final balance rather than each step.
// Transactions and transfers go in TOGETHER rather than through two calls.
// runInTransaction queues its work, so two calls are two transactions and
// nesting them would deadlock — which would mean a transfer that funds an
// account could not land alongside spending from that account. Inside one
// transaction the ordering stops mattering: every row is written, then each
// touched account is rebuilt once and its final balance checked once.
export const insertBulkImport = async (
    transactions: BulkTransactionInput[],
    transfers: BulkTransferInput[] = [],
    investments: BulkInvestmentInput[] = []
): Promise<BulkInsertTransactionsResult> => {
    if (transactions.length === 0 && transfers.length === 0 && investments.length === 0) {
        return {
            Status: "Error",
            Message: 'There are no rows to insert.',
        };
    }

    if (transactions.some((transaction) => transaction.Amount <= 0)) {
        return {
            Status: "Error",
            Message: 'Every transaction amount must be greater than zero.',
        };
    }

    if (transfers.some((transfer) => transfer.FromAmount <= 0 || transfer.ToAmount <= 0)) {
        return {
            Status: "Error",
            Message: 'Transfer amounts must be greater than zero.',
        };
    }

    // The import preview refuses these per row with the offending row named,
    // so reaching here means the file was read before midnight and confirmed
    // after it. Backstop rather than the primary check.
    if ([...transactions, ...transfers, ...investments].some((row) => isFutureTransactionDate(row.TransactionDate))) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    if (transfers.some((transfer) => transfer.FromAccountId === transfer.ToAccountId)) {
        return {
            Status: "Error",
            Message: 'From and To accounts must be different.',
        };
    }

    if (transactions.some((transaction) => isReservedCategoryId(transaction.CategoryId))) {
        return {
            Status: "Error",
            Message: 'Transfer and investment transactions must be created through their dedicated flows.',
        };
    }

    try {
        return await runInTransaction<BulkInsertTransactionsResult>(async (tx) => {
            const accountIds = [...new Set([
                ...transactions.map((transaction) => transaction.AccountId),
                ...transfers.flatMap((transfer) => [transfer.FromAccountId, transfer.ToAccountId]),
                ...investments.map((investment) => investment.AccountId),
            ])];
            const accountAnchors: { accountId: number; anchorBalance: number; name: string }[] = [];

            // Everything is re-checked here even though the import preview
            // already validated it: the preview ran outside this transaction
            // and an account could have been renamed or deactivated since.
            for (const accountId of accountIds) {
                const account = await getAccountBalanceState(tx, accountId, true);

                if (!account) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'An account used by these rows could not be found.',
                        },
                    };
                }

                const accountName = await tx.getFirstAsync<{ Name: string }>(
                    'SELECT Name FROM Accounts WHERE Id = ?',
                    [accountId]
                );

                accountAnchors.push({
                    accountId,
                    // Captured BEFORE any insert. The anchor balance is derived
                    // from the transactions sitting before the anchor date, so
                    // reading it afterwards would fold the imported rows into
                    // the baseline they are about to be replayed onto.
                    anchorBalance: await getAccountAnchorBalance(tx, account, accountId),
                    name: accountName?.Name ?? 'Account',
                });
            }

            const categoryIds = [...new Set(transactions.map((transaction) => transaction.CategoryId))];

            for (const categoryId of categoryIds) {
                const category = await tx.getFirstAsync<{ IsIncome: number }>(
                    `SELECT tt.IsIncome
                     FROM Categories c
                     INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                     WHERE c.Id = ? AND c.IsActive = 1`,
                    [categoryId]
                );

                if (!category) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'A category used by these rows could not be found.',
                        },
                    };
                }
            }

            // The transfer categories are seeded rows, but they are still read
            // back rather than assumed: a database whose reserved categories
            // were tampered with would otherwise write legs with the wrong
            // direction, and the balance replay would follow them.
            if (transfers.length > 0) {
                const transferCategories = await tx.getAllAsync<{ Id: number; IsIncome: number }>(
                    `SELECT c.Id, tt.IsIncome
                     FROM Categories c
                     INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                     WHERE c.Id IN (?, ?) AND c.IsActive = 1`,
                    [TRANSFER_FROM_CATEGORY_ID, TRANSFER_INTO_CATEGORY_ID]
                );
                const fromCategory = transferCategories.find((category) => category.Id === TRANSFER_FROM_CATEGORY_ID);
                const toCategory = transferCategories.find((category) => category.Id === TRANSFER_INTO_CATEGORY_ID);

                if (!fromCategory || !toCategory || Boolean(fromCategory.IsIncome) || !Boolean(toCategory.IsIncome)) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'Transfer categories are not configured correctly.',
                        },
                    };
                }
            }

            for (const transaction of transactions) {
                await tx.runAsync(
                    'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                    [
                        transaction.Description,
                        transaction.CategoryId,
                        transaction.Amount,
                        transaction.AccountId,
                        transaction.TransactionDate,
                    ]
                );
            }

            // Each transfer is two transaction rows plus the group row that ties
            // them together, exactly as insertTransferTransaction writes them, so
            // the edit and delete flows treat an imported transfer no
            // differently from one entered by hand.
            for (const transfer of transfers) {
                const fromResult = await tx.runAsync(
                    'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                    [
                        transfer.Description,
                        TRANSFER_FROM_CATEGORY_ID,
                        transfer.FromAmount,
                        transfer.FromAccountId,
                        transfer.TransactionDate,
                    ]
                );

                const toResult = await tx.runAsync(
                    'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                    [
                        transfer.Description,
                        TRANSFER_INTO_CATEGORY_ID,
                        transfer.ToAmount,
                        transfer.ToAccountId,
                        transfer.TransactionDate,
                    ]
                );

                await tx.runAsync(
                    'INSERT INTO TransferTransactionGroups (TransactionIdFrom, TransactionIdTo) VALUES (?, ?)',
                    [fromResult.lastInsertRowId, toResult.lastInsertRowId]
                );
            }

            // Investment rows write a transaction and a history entry each. The
            // amount is recomputed from quantity and unit value rather than
            // taken from the preview, and the currency match is re-checked,
            // because both could have changed since the file was read.
            for (const investment of investments) {
                const holding = await tx.getFirstAsync<{ CurrencyId: number; Name: string; QuantityDecimals: number }>(
                    'SELECT CurrencyId, Name, QuantityDecimals FROM Investments WHERE Id = ? AND IsActive = 1',
                    [investment.InvestmentId]
                );
                const account = await getAccountBalanceState(tx, investment.AccountId, true);

                if (!holding || !account) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'An investment used by these rows could not be found.',
                        },
                    };
                }

                if (holding.CurrencyId !== account.CurrencyId) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: `${holding.Name} and the account it trades through must use the same currency.`,
                        },
                    };
                }

                if (investment.Quantity <= 0 || investment.UnitValue <= 0 || investment.AdditionalFees < 0) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'Investment quantity, value, and fees are not valid.',
                        },
                    };
                }

                const grossAmount = calculateInvestmentAmount(
                    investment.Quantity,
                    holding.QuantityDecimals,
                    investment.UnitValue
                );
                if (grossAmount === null) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: `${holding.Name}: ${investmentAmountTooLargeMessage}`,
                        },
                    };
                }
                const transactionAmount = investment.IsBuy
                    ? grossAmount + investment.AdditionalFees
                    : grossAmount - investment.AdditionalFees;

                if (transactionAmount <= 0) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'Total investment amount must be greater than zero.',
                        },
                    };
                }

                const categoryId = investment.IsBuy
                    ? INVESTMENT_CATEGORY_ID
                    : INVESTMENT_LIQUIDATION_CATEGORY_ID;

                const result = await tx.runAsync(
                    'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                    [
                        investment.Description,
                        categoryId,
                        transactionAmount,
                        investment.AccountId,
                        investment.TransactionDate,
                    ]
                );

                // Buying adds quantity, selling removes it. The Quantity
                // snapshot is left at 0 and filled in by the replay below.
                await tx.runAsync(
                    'INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId) VALUES (?, 0, ?, ?, ?, ?)',
                    [
                        investment.InvestmentId,
                        investment.UnitValue,
                        investment.TransactionDate,
                        investment.IsBuy ? investment.Quantity : -investment.Quantity,
                        result.lastInsertRowId,
                    ]
                );
            }

            // Once per investment, after every row is in. rebuildInvestmentState
            // replays the whole timeline, so a sale dated before the purchase
            // that funds it is caught here even though the closing quantity
            // would be fine — the same reason account balances are rebuilt
            // rather than patched.
            for (const investmentId of [...new Set(investments.map((investment) => investment.InvestmentId))]) {
                const investmentRebuildResult = await rebuildInvestmentState(tx, investmentId);

                if (investmentRebuildResult.Status !== 'Success') {
                    return { commit: false, result: investmentRebuildResult };
                }
            }

            for (const { accountId, anchorBalance, name } of accountAnchors) {
                const rebuildResult = await rebuildAccountBalanceState(tx, accountId, anchorBalance);

                if (rebuildResult.Status !== 'Success') {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: `These rows would make the balance of ${name} negative. Nothing was imported.`,
                        },
                    };
                }
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                    // Counts what the user entered, not the rows written: a
                    // transfer is one thing they typed and two rows here.
                    InsertedCount: transactions.length + transfers.length + investments.length,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to import these rows.'),
        };
    }
}

export const updateTransaction = async (
    id: number,
    description: string | null,
    categoryId: number,
    amount: number,
    accountId: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (amount <= 0) {
        return {
            Status: "Error",
            Message: 'Transaction amount must be greater than zero.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const existingTransaction = await getExistingTransaction(tx, id);
            if (!existingTransaction) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transaction could not be found.',
                    },
                };
            }

            const existingReservedMessage = getReservedCategoryEditorMessage(existingTransaction.CategoryId);
            if (existingReservedMessage) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: existingReservedMessage,
                    },
                };
            }

            if (isReservedCategoryId(categoryId)) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'A transaction cannot be changed into a transfer or investment transaction. Delete it and create a new one instead.',
                    },
                };
            }

            const nextCategory = await tx.getFirstAsync<{ IsIncome: number }>(
                `SELECT tt.IsIncome
                 FROM Categories c
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.Id = ? AND c.IsActive = 1`,
                [categoryId]
            );

            if (!nextCategory) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected category could not be found.',
                    },
                };
            }

            const accountChanged = existingTransaction.AccountId !== accountId;
            const oldAccount = await getAccountBalanceState(tx, existingTransaction.AccountId, false);
            const nextAccount = accountChanged
                ? await getAccountBalanceState(tx, accountId, true)
                : oldAccount;

            if (!oldAccount || !nextAccount) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            const oldAccountAnchorBalance = await getAccountAnchorBalance(tx, oldAccount, existingTransaction.AccountId);
            const nextAccountAnchorBalance = existingTransaction.AccountId === accountId
                ? oldAccountAnchorBalance
                : await getAccountAnchorBalance(tx, nextAccount, accountId);

            await tx.runAsync(
                `UPDATE Transactions
                 SET Description = ?,
                    CategoryId = ?,
                    Amount = ?,
                    AccountId = ?,
                    TransactionDate = ?
                 WHERE Id = ?`,
                [description, categoryId, amount, accountId, transactionDate, id]
            );

            const oldRebuildResult = await rebuildAccountBalanceState(
                tx,
                existingTransaction.AccountId,
                oldAccountAnchorBalance
            );

            if (oldRebuildResult.Status !== 'Success') {
                return { commit: false, result: oldRebuildResult };
            }

            if (existingTransaction.AccountId !== accountId) {
                const nextRebuildResult = await rebuildAccountBalanceState(
                    tx,
                    accountId,
                    nextAccountAnchorBalance
                );

                if (nextRebuildResult.Status !== 'Success') {
                    return { commit: false, result: nextRebuildResult };
                }
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: id,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save transaction.'),
        };
    }
}

export const deleteTransaction = async (id: number): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            const existingTransaction = await getExistingTransaction(tx, id);
            if (!existingTransaction) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transaction could not be found.',
                    },
                };
            }

            const reservedMessage = getReservedCategoryEditorMessage(existingTransaction.CategoryId);
            if (reservedMessage) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: reservedMessage,
                    },
                };
            }

            const account = await getAccountBalanceState(tx, existingTransaction.AccountId, false);
            if (!account) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            const anchorBalance = await getAccountAnchorBalance(tx, account, existingTransaction.AccountId);

            await tx.runAsync('DELETE FROM Transactions WHERE Id = ?', [id]);

            const rebuildResult = await rebuildAccountBalanceState(
                tx,
                existingTransaction.AccountId,
                anchorBalance
            );

            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to delete transaction.'),
        };
    }
}

export const insertTransferTransaction = async (
    description: string | null,
    fromCategoryId: number,
    toCategoryId: number,
    fromAmount: number,
    toAmount: number,
    fromAccountId: number,
    toAccountId: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (fromAmount <= 0 || toAmount <= 0) {
        return {
            Status: "Error",
            Message: 'Transfer amounts must be greater than zero.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    if (fromAccountId === toAccountId) {
        return {
            Status: "Error",
            Message: 'From and To accounts must be different.',
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const fromAccount = await getAccountBalanceState(tx, fromAccountId, true);
            const toAccount = await getAccountBalanceState(tx, toAccountId, true);

            if (!fromAccount || !toAccount) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected transfer account could not be found.',
                    },
                };
            }

            const fromCategory = await tx.getFirstAsync<{ IsIncome: number }>(
                `SELECT tt.IsIncome
                 FROM Categories c
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.Id = ? AND c.IsActive = 1`,
                [fromCategoryId]
            );
            const toCategory = await tx.getFirstAsync<{ IsIncome: number }>(
                `SELECT tt.IsIncome
                 FROM Categories c
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.Id = ? AND c.IsActive = 1`,
                [toCategoryId]
            );

            if (!fromCategory || !toCategory || Boolean(fromCategory.IsIncome) || !Boolean(toCategory.IsIncome)) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transfer categories are not configured correctly.',
                    },
                };
            }

            const nextFromAccount = getNextAccountBalanceState(fromAccount, fromAmount, false, transactionDate);
            const nextToAccount = getNextAccountBalanceState(toAccount, toAmount, true, transactionDate);

            if (nextFromAccount.balance < 0) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transfer amount is higher than the From account balance.',
                    },
                };
            }

            const fromResult = await tx.runAsync(
                'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                [description, fromCategoryId, fromAmount, fromAccountId, transactionDate]
            );

            const toResult = await tx.runAsync(
                'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                [description, toCategoryId, toAmount, toAccountId, transactionDate]
            );

            await tx.runAsync(
                'INSERT INTO TransferTransactionGroups (TransactionIdFrom, TransactionIdTo) VALUES (?, ?)',
                [fromResult.lastInsertRowId, toResult.lastInsertRowId]
            );

            await updateAccountBalanceState(
                tx,
                fromAccountId,
                nextFromAccount.balance,
                nextFromAccount.openingBalance,
                nextFromAccount.openingBalanceDate
            );
            await updateAccountBalanceState(
                tx,
                toAccountId,
                nextToAccount.balance,
                nextToAccount.openingBalance,
                nextToAccount.openingBalanceDate
            );

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: fromResult.lastInsertRowId,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save transfer.'),
        };
    }
}

// Edits a transfer as a single unit: both legs share one description and one
// date, while amounts stay independent (cross-currency transfers). Accepts the
// id of EITHER leg. Categories are never changed. Rebuilds every affected
// account (up to 4 when both accounts change).
export const updateTransferTransaction = async (
    transactionId: number,
    description: string | null,
    fromAmount: number,
    toAmount: number,
    fromAccountId: number,
    toAccountId: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (fromAmount <= 0 || toAmount <= 0) {
        return {
            Status: "Error",
            Message: 'Transfer amounts must be greater than zero.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    if (fromAccountId === toAccountId) {
        return {
            Status: "Error",
            Message: 'From and To accounts must be different.',
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const group = await getTransferGroupByTransactionId(tx, transactionId);
            if (!group) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'This transaction is not part of a transfer pair.',
                    },
                };
            }

            const fromLeg = await getTransferLeg(tx, group.TransactionIdFrom);
            const toLeg = await getTransferLeg(tx, group.TransactionIdTo);
            if (!fromLeg || !toLeg) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'The other half of this transfer could not be found.',
                    },
                };
            }

            const fromAccount = await getAccountBalanceState(tx, fromAccountId, fromAccountId !== fromLeg.AccountId);
            const toAccount = await getAccountBalanceState(tx, toAccountId, toAccountId !== toLeg.AccountId);
            if (!fromAccount || !toAccount) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected transfer account could not be found.',
                    },
                };
            }

            // Snapshot anchor balances for every affected account BEFORE any
            // transaction row changes, because anchors are derived from transactions.
            const affectedAccountIds = [...new Set([fromLeg.AccountId, toLeg.AccountId, fromAccountId, toAccountId])];
            const anchorBalances = new Map<number, number>();
            for (const affectedAccountId of affectedAccountIds) {
                const accountState = await getAccountBalanceState(tx, affectedAccountId, false);
                if (!accountState) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'An account involved in this transfer could not be found.',
                        },
                    };
                }
                anchorBalances.set(affectedAccountId, await getAccountAnchorBalance(tx, accountState, affectedAccountId));
            }

            await tx.runAsync(
                'UPDATE Transactions SET Description = ?, Amount = ?, AccountId = ?, TransactionDate = ? WHERE Id = ?',
                [description, fromAmount, fromAccountId, transactionDate, fromLeg.Id]
            );
            await tx.runAsync(
                'UPDATE Transactions SET Description = ?, Amount = ?, AccountId = ?, TransactionDate = ? WHERE Id = ?',
                [description, toAmount, toAccountId, transactionDate, toLeg.Id]
            );

            for (const affectedAccountId of affectedAccountIds) {
                const rebuildResult = await rebuildAccountBalanceState(
                    tx,
                    affectedAccountId,
                    anchorBalances.get(affectedAccountId) ?? 0
                );

                if (rebuildResult.Status !== 'Success') {
                    return {
                        commit: false,
                        result: {
                            Status: 'Error',
                            Message: `${rebuildResult.Message} (account id ${affectedAccountId})`,
                        },
                    };
                }
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: group.Id,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save transfer.'),
        };
    }
}

// Deletes BOTH legs of a transfer plus the group row. Accepts the id of
// either leg. Blocked if removing the To leg's income would make that
// account's balance negative anywhere in its history.
export const deleteTransferTransaction = async (transactionId: number): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            const group = await getTransferGroupByTransactionId(tx, transactionId);
            if (!group) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'This transaction is not part of a transfer pair.',
                    },
                };
            }

            const fromLeg = await getTransferLeg(tx, group.TransactionIdFrom);
            const toLeg = await getTransferLeg(tx, group.TransactionIdTo);
            if (!fromLeg || !toLeg) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'The other half of this transfer could not be found.',
                    },
                };
            }

            const affectedAccountIds = [...new Set([fromLeg.AccountId, toLeg.AccountId])];
            const anchorBalances = new Map<number, number>();
            for (const affectedAccountId of affectedAccountIds) {
                const accountState = await getAccountBalanceState(tx, affectedAccountId, false);
                if (!accountState) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'An account involved in this transfer could not be found.',
                        },
                    };
                }
                anchorBalances.set(affectedAccountId, await getAccountAnchorBalance(tx, accountState, affectedAccountId));
            }

            // The group row references both transactions, so with foreign keys
            // enabled it must be removed before the transactions themselves.
            await tx.runAsync('DELETE FROM TransferTransactionGroups WHERE Id = ?', [group.Id]);
            await tx.runAsync('DELETE FROM Transactions WHERE Id = ?', [fromLeg.Id]);
            await tx.runAsync('DELETE FROM Transactions WHERE Id = ?', [toLeg.Id]);

            for (const affectedAccountId of affectedAccountIds) {
                const rebuildResult = await rebuildAccountBalanceState(
                    tx,
                    affectedAccountId,
                    anchorBalances.get(affectedAccountId) ?? 0
                );

                if (rebuildResult.Status !== 'Success') {
                    return {
                        commit: false,
                        result: {
                            Status: 'Error',
                            Message: `${rebuildResult.Message} (account id ${affectedAccountId})`,
                        },
                    };
                }
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to delete transfer.'),
        };
    }
}

export const insertInvestmentTransaction = async (
    description: string | null,
    categoryId: number,
    accountId: number,
    investmentId: number,
    quantity: number,
    unitValue: number,
    additionalFees: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (quantity <= 0 || unitValue <= 0 || additionalFees < 0) {
        return {
            Status: "Error",
            Message: 'Investment quantity, value, and fees are not valid.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const account = await getAccountBalanceState(tx, accountId, true);

            if (!account) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            const category = await tx.getFirstAsync<{ IsIncome: number }>(
                `SELECT tt.IsIncome
                 FROM Categories c
                 INNER JOIN TransactionTypes tt ON tt.Id = c.TransactionTypeId
                 WHERE c.Id = ? AND c.IsActive = 1`,
                [categoryId]
            );

            if (!category) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected category could not be found.',
                    },
                };
            }

            const investment = await tx.getFirstAsync<{ Quantity: number; CurrencyId: number; QuantityDecimals: number }>(
                'SELECT Quantity, CurrencyId, QuantityDecimals FROM Investments WHERE Id = ? AND IsActive = 1',
                [investmentId]
            );

            if (!investment) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected investment could not be found.',
                    },
                };
            }

            if (investment.CurrencyId !== account.CurrencyId) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Investment currency must match the selected account currency.',
                    },
                };
            }

            const isIncome = Boolean(category.IsIncome);
            const grossAmount = calculateInvestmentAmount(quantity, investment.QuantityDecimals, unitValue);
            if (grossAmount === null) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: investmentAmountTooLargeMessage,
                    },
                };
            }
            const transactionAmount = isIncome ? grossAmount - additionalFees : grossAmount + additionalFees;

            if (transactionAmount <= 0) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Total investment amount must be greater than zero.',
                    },
                };
            }

            const nextAccount = getNextAccountBalanceState(account, transactionAmount, isIncome, transactionDate);

            if (nextAccount.balance < 0) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'The inputted amount cannot be higher than the current account balance.',
                    },
                };
            }

            const result = await tx.runAsync(
                'INSERT INTO Transactions (Description, CategoryId, Amount, AccountId, TransactionDate) VALUES (?, ?, ?, ?, ?)',
                [description, categoryId, transactionAmount, accountId, transactionDate]
            );

            await updateAccountBalanceState(
                tx,
                accountId,
                nextAccount.balance,
                nextAccount.openingBalance,
                nextAccount.openingBalanceDate
            );

            // Buying adds quantity; liquidating (income) removes it. The
            // Quantity snapshot is filled in by the replay below.
            const quantityDelta = isIncome ? -quantity : quantity;
            await tx.runAsync(
                'INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId) VALUES (?, 0, ?, ?, ?, ?)',
                [investmentId, unitValue, transactionDate, quantityDelta, result.lastInsertRowId]
            );

            // Replaying validates the whole timeline (a past-dated liquidation
            // can exceed holdings at that date even when the final total is
            // fine) and keeps snapshots, quantity, and unit value consistent.
            const investmentRebuildResult = await rebuildInvestmentState(tx, investmentId);
            if (investmentRebuildResult.Status !== 'Success') {
                return { commit: false, result: investmentRebuildResult };
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: result.lastInsertRowId,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save investment transaction.'),
        };
    }
}

// Edits an investment transaction. The category (buy vs liquidation) and the
// linked investment are intentionally NOT editable — changing intent that
// fundamentally means delete + recreate. Quantity, unit value, fees, date,
// account, and description are all fair game; everything downstream is kept
// consistent by replaying the investment and rebuilding account balances.
export const updateInvestmentTransaction = async (
    id: number,
    description: string | null,
    quantity: number,
    unitValue: number,
    additionalFees: number,
    accountId: number,
    transactionDate: string
): Promise<InsertOrUpdateResult> => {
    if (quantity <= 0 || unitValue <= 0 || additionalFees < 0) {
        return {
            Status: "Error",
            Message: 'Investment quantity, value, and fees are not valid.',
        };
    }

    if (isFutureTransactionDate(transactionDate)) {
        return {
            Status: "Error",
            Message: futureTransactionDateMessage,
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const existingTransaction = await getExistingTransaction(tx, id);
            if (!existingTransaction) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transaction could not be found.',
                    },
                };
            }

            if (!isInvestmentCategoryId(existingTransaction.CategoryId)) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'This transaction is not an investment transaction.',
                    },
                };
            }

            const historyEntry = await tx.getFirstAsync<InvestmentHistoryLinkRow>(
                'SELECT Id, InvestmentId FROM InvestmentHistories WHERE TransactionId = ?',
                [id]
            );
            if (!historyEntry) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'No investment history entry is linked to this transaction, so it cannot be edited safely.',
                    },
                };
            }

            const investment = await tx.getFirstAsync<{ CurrencyId: number; QuantityDecimals: number }>(
                'SELECT CurrencyId, QuantityDecimals FROM Investments WHERE Id = ?',
                [historyEntry.InvestmentId]
            );
            if (!investment) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'The related investment could not be found.',
                    },
                };
            }

            const accountChanged = existingTransaction.AccountId !== accountId;
            const account = await getAccountBalanceState(tx, accountId, accountChanged);
            if (!account) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            if (account.CurrencyId !== investment.CurrencyId) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Investment currency must match the selected account currency.',
                    },
                };
            }

            const isIncome = existingTransaction.CategoryId === INVESTMENT_LIQUIDATION_CATEGORY_ID;
            const grossAmount = calculateInvestmentAmount(quantity, investment.QuantityDecimals, unitValue);
            if (grossAmount === null) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: investmentAmountTooLargeMessage,
                    },
                };
            }
            const transactionAmount = isIncome ? grossAmount - additionalFees : grossAmount + additionalFees;

            if (transactionAmount <= 0) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Total investment amount must be greater than zero.',
                    },
                };
            }

            // Anchor balances must be captured before transaction rows change.
            const oldAccountState = await getAccountBalanceState(tx, existingTransaction.AccountId, false);
            if (!oldAccountState) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'The transaction\'s current account could not be found.',
                    },
                };
            }
            const oldAccountAnchorBalance = await getAccountAnchorBalance(tx, oldAccountState, existingTransaction.AccountId);
            const nextAccountAnchorBalance = accountChanged
                ? await getAccountAnchorBalance(tx, account, accountId)
                : oldAccountAnchorBalance;

            await tx.runAsync(
                'UPDATE Transactions SET Description = ?, Amount = ?, AccountId = ?, TransactionDate = ? WHERE Id = ?',
                [description, transactionAmount, accountId, transactionDate, id]
            );

            const quantityDelta = isIncome ? -quantity : quantity;
            await tx.runAsync(
                'UPDATE InvestmentHistories SET QuantityDelta = ?, UnitValue = ?, CreatedAt = ? WHERE Id = ?',
                [quantityDelta, unitValue, transactionDate, historyEntry.Id]
            );

            const investmentRebuildResult = await rebuildInvestmentState(tx, historyEntry.InvestmentId);
            if (investmentRebuildResult.Status !== 'Success') {
                return { commit: false, result: investmentRebuildResult };
            }

            const oldRebuildResult = await rebuildAccountBalanceState(tx, existingTransaction.AccountId, oldAccountAnchorBalance);
            if (oldRebuildResult.Status !== 'Success') {
                return { commit: false, result: oldRebuildResult };
            }

            if (accountChanged) {
                const nextRebuildResult = await rebuildAccountBalanceState(tx, accountId, nextAccountAnchorBalance);
                if (nextRebuildResult.Status !== 'Success') {
                    return { commit: false, result: nextRebuildResult };
                }
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                    DataId: id,
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to save investment transaction.'),
        };
    }
}

export const deleteInvestmentTransaction = async (id: number): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            const existingTransaction = await getExistingTransaction(tx, id);
            if (!existingTransaction) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Transaction could not be found.',
                    },
                };
            }

            if (!isInvestmentCategoryId(existingTransaction.CategoryId)) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'This transaction is not an investment transaction.',
                    },
                };
            }

            const historyEntry = await tx.getFirstAsync<InvestmentHistoryLinkRow>(
                'SELECT Id, InvestmentId FROM InvestmentHistories WHERE TransactionId = ?',
                [id]
            );
            if (!historyEntry) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'No investment history entry is linked to this transaction, so it cannot be deleted safely.',
                    },
                };
            }

            const account = await getAccountBalanceState(tx, existingTransaction.AccountId, false);
            if (!account) {
                return {
                    commit: false,
                    result: {
                        Status: "Error",
                        Message: 'Selected account could not be found.',
                    },
                };
            }

            const anchorBalance = await getAccountAnchorBalance(tx, account, existingTransaction.AccountId);

            // The history entry references the transaction, so with foreign keys
            // enabled it must be removed first.
            await tx.runAsync('DELETE FROM InvestmentHistories WHERE Id = ?', [historyEntry.Id]);
            await tx.runAsync('DELETE FROM Transactions WHERE Id = ?', [id]);

            const investmentRebuildResult = await rebuildInvestmentState(tx, historyEntry.InvestmentId);
            if (investmentRebuildResult.Status !== 'Success') {
                return { commit: false, result: investmentRebuildResult };
            }

            const rebuildResult = await rebuildAccountBalanceState(tx, existingTransaction.AccountId, anchorBalance);
            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
            }

            return {
                commit: true,
                result: {
                    Status: "Success",
                },
            };
        });
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to delete investment transaction.'),
        };
    }
}

// Loads everything the edit form needs for a transaction, resolving the family
// (normal / transfer / investment) and the related rows.
export const getTransactionEditDetails = async (id: number): Promise<GetTransactionEditDetailsResult> => {
    try {
        const _db = await getDBConnection();
        const transaction = await _db.getFirstAsync<{
            Id: number;
            Description: string | null;
            CategoryId: number;
            TransactionTypeId: number;
            Amount: number;
            AccountId: number;
            TransactionDate: string;
        }>(
            `SELECT t.Id, t.Description, t.CategoryId, c.TransactionTypeId, t.Amount, t.AccountId, t.TransactionDate
             FROM Transactions t
             INNER JOIN Categories c ON c.Id = t.CategoryId
             WHERE t.Id = ?`,
            [id]
        );

        if (!transaction) {
            return {
                Status: "Error",
                Message: 'Transaction could not be found.',
                Data: null
            };
        }

        const baseDetails: TransactionEditDetails = {
            Kind: 'normal',
            Id: transaction.Id,
            Description: transaction.Description,
            CategoryId: transaction.CategoryId,
            TransactionTypeId: transaction.TransactionTypeId,
            Amount: transaction.Amount,
            AccountId: transaction.AccountId,
            TransactionDate: transaction.TransactionDate,
        };

        if (isTransferCategoryId(transaction.CategoryId)) {
            const group = await getTransferGroupByTransactionId(_db, id);
            if (!group) {
                return {
                    Status: "Error",
                    Message: 'This transaction is not part of a transfer pair.',
                    Data: null
                };
            }

            const fromLeg = await getTransferLeg(_db, group.TransactionIdFrom);
            const toLeg = await getTransferLeg(_db, group.TransactionIdTo);
            if (!fromLeg || !toLeg) {
                return {
                    Status: "Error",
                    Message: 'The other half of this transfer could not be found.',
                    Data: null
                };
            }

            return {
                Status: "Success",
                Data: {
                    ...baseDetails,
                    Kind: 'transfer',
                    FromAccountId: fromLeg.AccountId,
                    ToAccountId: toLeg.AccountId,
                    FromAmount: fromLeg.Amount,
                    ToAmount: toLeg.Amount,
                }
            };
        }

        if (isInvestmentCategoryId(transaction.CategoryId)) {
            const historyEntry = await _db.getFirstAsync<{
                InvestmentId: number;
                QuantityDelta: number;
                UnitValue: number;
                QuantityDecimals: number;
            }>(
                `SELECT ih.InvestmentId, ih.QuantityDelta, ih.UnitValue, i.QuantityDecimals
                 FROM InvestmentHistories ih
                 INNER JOIN Investments i ON i.Id = ih.InvestmentId
                 WHERE ih.TransactionId = ?`,
                [id]
            );
            if (!historyEntry) {
                return {
                    Status: "Error",
                    Message: 'No investment history entry is linked to this transaction.',
                    Data: null
                };
            }

            const quantity = Math.abs(historyEntry.QuantityDelta);
            // Fees are not stored; they are the gap between the amount and the
            // rounded gross, exactly as they were derived when saved.
            const grossAmount = calculateInvestmentAmount(quantity, historyEntry.QuantityDecimals, historyEntry.UnitValue) ?? 0;
            const isIncome = transaction.CategoryId === INVESTMENT_LIQUIDATION_CATEGORY_ID;
            const additionalFees = isIncome ? grossAmount - transaction.Amount : transaction.Amount - grossAmount;

            return {
                Status: "Success",
                Data: {
                    ...baseDetails,
                    Kind: 'investment',
                    InvestmentId: historyEntry.InvestmentId,
                    Quantity: quantity,
                    QuantityDecimals: historyEntry.QuantityDecimals,
                    UnitValue: historyEntry.UnitValue,
                    AdditionalFees: Math.max(additionalFees, 0),
                }
            };
        }

        return {
            Status: "Success",
            Data: baseDetails
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Unable to load transaction details.'),
            Data: null
        };
    }
}
