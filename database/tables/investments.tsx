import { DbExecutor, DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult, runInTransaction } from "../dbService";
import { describeError } from '@/utils/userFacingError';
import { rebuildInvestmentState } from "./transactions";
import { GENERAL_INVESTMENT_CATEGORY_ID } from "./investmentCategories";
import { MAX_QUANTITY_DECIMALS } from "@/utils/investmentNumbers";

export interface Investment{
    Id: number;
    Name: string;
    InvestmentCategoryId: number;
    // Joined from InvestmentCategories in getInvestments; null if the category
    // row is missing (should not happen, but LEFT JOIN keeps the investment visible).
    InvestmentCategoryName: string | null;
    CurrencyId: number;
    // Scaled by 10^QuantityDecimals (see utils/investmentNumbers.ts).
    Quantity: number;
    // Currency minor units x 10^4 (see utils/investmentNumbers.ts).
    UnitValue: number;
    // 0-8. Locked, like quantity and currency, once transactions exist.
    QuantityDecimals: number;
    // What one unit is called (gram, lot, share). Null when the user did not
    // set one; callers fall back to "unit(s)" rather than showing nothing.
    Unit: string | null;
    IsActive: boolean;
    CreatedAt: Date;
}

export interface GetInvestmentResult extends GetResult {
    Data: Investment[]
}

export interface GetInvestmentTransactionCountResult extends GetResult {
    Count: number
}

const quantityDecimalsErrorMessage = `Quantity decimals must be between 0 and ${MAX_QUANTITY_DECIMALS}.`;

const isValidQuantityDecimals = (decimals: number): boolean =>
    Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_QUANTITY_DECIMALS;

export const getInvestments = async (): Promise<GetInvestmentResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const accounts: Investment[] = await _db.getAllAsync(
                `SELECT i.*, ic.Name AS InvestmentCategoryName
                 FROM Investments i
                 LEFT JOIN InvestmentCategories ic ON ic.Id = i.InvestmentCategoryId
                 WHERE i.IsActive = 1
                 ORDER BY i.Name COLLATE NOCASE`
            )
            const response: GetInvestmentResult = {
                Status: "Success",
                Data: accounts
            }

            return response;
        } catch (err){
            const response: GetInvestmentResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load investments.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetInvestmentResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}

export const insertInvestment = async (
    name: string,
    currencyId: number,
    quantity: number,
    unitValue: number,
    createdAt: string,
    // Null falls back to the reserved "General" category (Id 1, seeded).
    categoryId: number | null = null,
    unit: string | null = null,
    // Quantity above is already scaled by this. Inline creation from a transaction
    // passes nothing: an empty investment starts at 0 decimals.
    quantityDecimals: number = 0
): Promise<InsertOrUpdateResult> => {
    if (!isValidQuantityDecimals(quantityDecimals)) {
        return {
            Status: "Error",
            Message: quantityDecimalsErrorMessage,
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const investmentCategoryId = categoryId ?? GENERAL_INVESTMENT_CATEGORY_ID;
            const result = await tx.runAsync(
                'INSERT INTO Investments (Name, InvestmentCategoryId, CurrencyId, Quantity, UnitValue, CreatedAt, Unit, QuantityDecimals) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [name, investmentCategoryId, currencyId, quantity, unitValue, createdAt, unit, quantityDecimals]
            );

            // The creation entry carries the opening quantity as its delta and
            // has no linked transaction. An investment opened with nothing in it
            // — which is what creating one inline from a transaction does — has no
            // opening position to record, and a 0 quantity / 0 value entry
            // carries no information: it just renders as a phantom zero at the
            // head of every chart and history list. rebuildInvestmentState sums
            // deltas, so omitting a zero-delta row changes no totals.
            // IsOpening marks it as the "held this many as of the creation
            // day" anchor — see database/investmentReplay.ts.
            if (quantity > 0 || unitValue > 0) {
                await tx.runAsync(
                    'INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId, IsOpening) VALUES (?, ?, ?, ?, ?, NULL, 1)',
                    [result.lastInsertRowId, quantity, unitValue, createdAt, quantity]
                );
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
            ...describeError(err, 'Failed to save investment.'),
        };
    }
}

// Everything that has happened to the investment since it was created:
// transactions, adjustments, and legacy revaluations — every history row except
// the opening entry. Edit may only rewrite the opening position while this is
// zero; after that, changes go through transactions or Adjust (decided
// 2026-10-04: "edit is only for before anything happened to the investment").
const countPostOpeningEntries = async (db: DbExecutor, investmentId: number): Promise<number> => {
    const result = await db.getFirstAsync<{ Count: number }>(
        'SELECT COUNT(*) AS Count FROM InvestmentHistories WHERE InvestmentId = ? AND IsOpening = 0',
        [investmentId]
    );
    return result?.Count ?? 0;
};

// The UI uses this to lock quantity, decimals, unit value and currency.
export const getInvestmentHistoryEntryCount = async (id: number): Promise<GetInvestmentTransactionCountResult> => {
    try {
        const _db = await getDBConnection();
        const count = await countPostOpeningEntries(_db, id);
        return {
            Status: "Success",
            Count: count
        };
    } catch (err) {
        return {
            Status: "Error",
            ...describeError(err, 'Failed to check investment history.'),
            Count: 0
        };
    }
}

// Mirrors updateAccount's locking rules:
// - Name and unit are always editable (both are labels, not positions).
// - Quantity, quantity decimals, unit value, and currency are only editable
//   while nothing but the opening entry exists (they rewrite that entry).
//   Decimals ride on the same lock: the opening entry is the only
//   quantity-bearing row then, rewritten below from a quantity already scaled
//   to the new decimals.
// - After that, Edit changes labels only. Price and quantity changes are
//   adjustments (database/tables/investmentHistories.tsx); Edit no longer
//   records revaluations.
export const updateInvestment = async (
    id: number,
    name: string,
    currencyId: number,
    quantity: number,
    unitValue: number,
    // Null keeps the current category. Category is metadata like Name, so it
    // stays editable even when quantity/currency are locked by transactions.
    categoryId: number | null = null,
    unit: string | null = null,
    // Ignored once transactions exist (locked).
    quantityDecimals: number = 0
): Promise<InsertOrUpdateResult> => {
    if (!isValidQuantityDecimals(quantityDecimals)) {
        return {
            Status: "Error",
            Message: quantityDecimalsErrorMessage,
        };
    }

    if (quantity < 0 || unitValue < 0) {
        return {
            Status: "Error",
            Message: 'Investment quantity and value cannot be negative.',
        };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const investment = await tx.getFirstAsync<{ Id: number; UnitValue: number; CreatedAt: string }>(
                'SELECT Id, UnitValue, CreatedAt FROM Investments WHERE Id = ? AND IsActive = 1',
                [id]
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

            const postOpeningEntryCount = await countPostOpeningEntries(tx, id);

            if (postOpeningEntryCount > 0) {
                await tx.runAsync(
                    'UPDATE Investments SET Name = ?, InvestmentCategoryId = COALESCE(?, InvestmentCategoryId), Unit = ? WHERE Id = ?',
                    [name, categoryId, unit, id]
                );
            } else {
                await tx.runAsync(
                    'UPDATE Investments SET Name = ?, CurrencyId = ?, InvestmentCategoryId = COALESCE(?, InvestmentCategoryId), Unit = ?, QuantityDecimals = ? WHERE Id = ?',
                    [name, currencyId, categoryId, unit, quantityDecimals, id]
                );

                // Found by its IsOpening flag, not as "the earliest row with no
                // transaction": revaluations and write-offs have no transaction either,
                // and the old lookup could pick one of those up instead.
                const creationEntry = await tx.getFirstAsync<{ Id: number }>(
                    `SELECT Id FROM InvestmentHistories
                     WHERE InvestmentId = ? AND IsOpening = 1
                     LIMIT 1`,
                    [id]
                );

                // insertInvestment writes no creation entry for an investment
                // opened empty, so this branch has to be able to create one —
                // otherwise giving a freshly created investment an opening
                // quantity here would silently do nothing. Conversely, editing
                // one back down to nothing removes the row rather than leaving
                // a zero entry behind.
                const hasOpeningPosition = quantity > 0 || unitValue > 0;

                if (creationEntry && hasOpeningPosition) {
                    await tx.runAsync(
                        'UPDATE InvestmentHistories SET QuantityDelta = ?, UnitValue = ? WHERE Id = ?',
                        [quantity, unitValue, creationEntry.Id]
                    );
                } else if (creationEntry) {
                    await tx.runAsync('DELETE FROM InvestmentHistories WHERE Id = ?', [creationEntry.Id]);
                } else if (hasOpeningPosition) {
                    await tx.runAsync(
                        'INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId, IsOpening) VALUES (?, ?, ?, ?, ?, NULL, 1)',
                        [id, quantity, unitValue, investment.CreatedAt, quantity]
                    );
                }
            }

            const rebuildResult = await rebuildInvestmentState(tx, id);
            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
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
            ...describeError(err, 'Failed to save investment.'),
        };
    }
}

// Soft delete, mirroring accounts. If the investment still holds quantity the
// caller must pass writeOffRemaining = true (after user confirmation): a
// write-off history entry zeroes the holdings with a dated record — no fake
// money moves through any account — and then the investment is deactivated.
export const deleteInvestment = async (
    id: number,
    writeOffRemaining: boolean = false
): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            const investment = await tx.getFirstAsync<{ Id: number; Quantity: number }>(
                'SELECT Id, Quantity FROM Investments WHERE Id = ? AND IsActive = 1',
                [id]
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

            if (investment.Quantity > 0) {
                if (!writeOffRemaining) {
                    return {
                        commit: false,
                        result: {
                            Status: "Error",
                            Message: 'This investment still holds quantity. Liquidate it with a transaction, or confirm writing off the remaining quantity.',
                        },
                    };
                }

                await tx.runAsync(
                    `INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId)
                     VALUES (?, 0, 0, date('now'), ?, NULL)`,
                    [id, -investment.Quantity]
                );

                const rebuildResult = await rebuildInvestmentState(tx, id);
                if (rebuildResult.Status !== 'Success') {
                    return { commit: false, result: rebuildResult };
                }
            }

            await tx.runAsync('UPDATE Investments SET IsActive = 0 WHERE Id = ?', [id]);

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
            ...describeError(err, 'Failed to remove investment.'),
        };
    }
}
