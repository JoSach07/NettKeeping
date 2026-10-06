import { DbExecutor, DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult, runInTransaction } from "../dbService";
import { describeError } from '@/utils/userFacingError';
import { futureTransactionDateMessage, isFutureTransactionDate, rebuildInvestmentState } from "./transactions";

export interface InvestmentHistory{
    Id: number;
    InvestmentId: number;
    // Running quantity after this entry, scaled by the investment's
    // QuantityDecimals. Rewritten by every rebuild.
    Quantity: number;
    // This entry's own change, same scale.
    QuantityDelta: number;
    // Currency minor units x 10^4.
    UnitValue: number;
    CreatedAt: Date;
    TransactionId: number | null;
    IsOpening: number;
    Note: string | null;
}

// An adjustment is any entry with no transaction behind it that is not the
// opening entry: quantity changes (gifts, bonus units, splits, corrections)
// and price updates. Write-offs share the same shape, but they only exist on
// deleted investments, which every function below refuses.
export const isInvestmentAdjustment = (history: Pick<InvestmentHistory, 'TransactionId' | 'IsOpening'>): boolean =>
    history.TransactionId === null && !history.IsOpening;

// Short kind label for history lists.
export const getInvestmentHistoryKindLabel = (
    history: Pick<InvestmentHistory, 'TransactionId' | 'IsOpening' | 'QuantityDelta'>
): string => {
    if (history.IsOpening) {
        return 'Opening';
    }
    if (history.TransactionId !== null) {
        return history.QuantityDelta < 0 ? 'Sell' : 'Buy';
    }
    return 'Adjustment';
};

export const ADJUSTMENT_NOTE_MAX_LENGTH = 100;

export type InvestmentAdjustmentInput = {
    // 'YYYY-MM-DD', local calendar day.
    date: string;
    // Scaled by the investment's QuantityDecimals; may be negative or 0.
    quantityDelta: number;
    // Minor units x 10^4, or null to carry over the price in effect on that
    // date (copied at save time — decided 2026-10-04).
    unitValue: number | null;
    note: string | null;
};

const validateAdjustment = (input: InvestmentAdjustmentInput): string | null => {
    if (isFutureTransactionDate(input.date)) {
        return futureTransactionDateMessage;
    }
    if (!Number.isSafeInteger(input.quantityDelta)) {
        return 'Quantity change is not valid.';
    }
    if (input.unitValue !== null && (!Number.isSafeInteger(input.unitValue) || input.unitValue < 0)) {
        return 'Value per unit must be zero or higher.';
    }
    if (input.quantityDelta === 0 && input.unitValue === null) {
        return 'Enter a quantity change, a new value per unit, or both.';
    }
    if (input.note !== null && input.note.length > ADJUSTMENT_NOTE_MAX_LENGTH) {
        return `Note can be at most ${ADJUSTMENT_NOTE_MAX_LENGTH} characters.`;
    }
    return null;
};

const normalizeNote = (note: string | null): string | null => {
    const trimmed = note?.trim() ?? '';
    return trimmed ? trimmed : null;
};

// The price in effect just before an entry at `date`, in replay order (by
// day; within a day the opening entry first, then insertion order). For an
// existing entry, only rows that come before it count. Null when nothing
// earlier exists.
const getCarriedUnitValue = async (
    tx: DbExecutor,
    investmentId: number,
    date: string,
    ownId: number | null
): Promise<number | null> => {
    const row = ownId === null
        ? await tx.getFirstAsync<{ UnitValue: number }>(
            `SELECT UnitValue FROM InvestmentHistories
             WHERE InvestmentId = ? AND date(CreatedAt) <= date(?)
             ORDER BY date(CreatedAt) DESC, IsOpening ASC, Id DESC
             LIMIT 1`,
            [investmentId, date]
        )
        : await tx.getFirstAsync<{ UnitValue: number }>(
            `SELECT UnitValue FROM InvestmentHistories
             WHERE InvestmentId = ? AND Id <> ?
                AND (date(CreatedAt) < date(?) OR (date(CreatedAt) = date(?) AND (IsOpening = 1 OR Id < ?)))
             ORDER BY date(CreatedAt) DESC, IsOpening ASC, Id DESC
             LIMIT 1`,
            [investmentId, ownId, date, date, ownId]
        );
    return row?.UnitValue ?? null;
};

const noCarriedPriceMessage = 'Enter a value per unit, since there is no earlier price to carry over.';

export const insertInvestmentAdjustment = async (
    investmentId: number,
    input: InvestmentAdjustmentInput
): Promise<InsertOrUpdateResult> => {
    const validationMessage = validateAdjustment(input);
    if (validationMessage) {
        return { Status: "Error", Message: validationMessage };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const investment = await tx.getFirstAsync<{ Id: number }>(
                'SELECT Id FROM Investments WHERE Id = ? AND IsActive = 1',
                [investmentId]
            );
            if (!investment) {
                return { commit: false, result: { Status: "Error", Message: 'Selected investment could not be found.' } };
            }

            const unitValue = input.unitValue ?? await getCarriedUnitValue(tx, investmentId, input.date, null);
            if (unitValue === null) {
                return { commit: false, result: { Status: "Error", Message: noCarriedPriceMessage } };
            }

            const result = await tx.runAsync(
                `INSERT INTO InvestmentHistories (InvestmentId, Quantity, UnitValue, CreatedAt, QuantityDelta, TransactionId, IsOpening, Note)
                 VALUES (?, 0, ?, ?, ?, NULL, 0, ?)`,
                [investmentId, unitValue, input.date, input.quantityDelta, normalizeNote(input.note)]
            );

            // Replays the whole timeline: refuses a change that would make the
            // quantity negative at any point, and moves the investment's
            // current quantity and price.
            const rebuildResult = await rebuildInvestmentState(tx, investmentId);
            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
            }

            return { commit: true, result: { Status: "Success", DataId: result.lastInsertRowId } };
        });
    } catch (err) {
        return { Status: "Error", ...describeError(err, 'Failed to save the adjustment.') };
    }
};

const getEditableAdjustment = async (
    tx: DbExecutor,
    historyId: number
) => tx.getFirstAsync<{ Id: number; InvestmentId: number }>(
    `SELECT ih.Id, ih.InvestmentId
     FROM InvestmentHistories ih
     INNER JOIN Investments i ON i.Id = ih.InvestmentId
     WHERE ih.Id = ? AND ih.TransactionId IS NULL AND ih.IsOpening = 0 AND i.IsActive = 1`,
    [historyId]
);

export const updateInvestmentAdjustment = async (
    historyId: number,
    input: InvestmentAdjustmentInput
): Promise<InsertOrUpdateResult> => {
    const validationMessage = validateAdjustment(input);
    if (validationMessage) {
        return { Status: "Error", Message: validationMessage };
    }

    try {
        return await runInTransaction<InsertOrUpdateResult>(async (tx) => {
            const adjustment = await getEditableAdjustment(tx, historyId);
            if (!adjustment) {
                return { commit: false, result: { Status: "Error", Message: 'This adjustment could not be found.' } };
            }

            const unitValue = input.unitValue ?? await getCarriedUnitValue(tx, adjustment.InvestmentId, input.date, historyId);
            if (unitValue === null) {
                return { commit: false, result: { Status: "Error", Message: noCarriedPriceMessage } };
            }

            await tx.runAsync(
                'UPDATE InvestmentHistories SET UnitValue = ?, CreatedAt = ?, QuantityDelta = ?, Note = ? WHERE Id = ?',
                [unitValue, input.date, input.quantityDelta, normalizeNote(input.note), historyId]
            );

            const rebuildResult = await rebuildInvestmentState(tx, adjustment.InvestmentId);
            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
            }

            return { commit: true, result: { Status: "Success", DataId: historyId } };
        });
    } catch (err) {
        return { Status: "Error", ...describeError(err, 'Failed to save the adjustment.') };
    }
};

export const deleteInvestmentAdjustment = async (historyId: number): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            const adjustment = await getEditableAdjustment(tx, historyId);
            if (!adjustment) {
                return { commit: false, result: { Status: "Error", Message: 'This adjustment could not be found.' } };
            }

            await tx.runAsync('DELETE FROM InvestmentHistories WHERE Id = ?', [historyId]);

            // Refuses the delete if a later sale relied on units it added.
            const rebuildResult = await rebuildInvestmentState(tx, adjustment.InvestmentId);
            if (rebuildResult.Status !== 'Success') {
                return { commit: false, result: rebuildResult };
            }

            return { commit: true, result: { Status: "Success" } };
        });
    } catch (err) {
        return { Status: "Error", ...describeError(err, 'Failed to delete the adjustment.') };
    }
};

export interface GetInvestmentHistoryResult extends GetResult {
    Data: InvestmentHistory[]
}

// endDate is optional, and every caller now omits it. Account transactions are
// fetched with a start date and no upper bound at all
// (getAccountTransactionDetailsForRange), and investments were the only place
// that also capped the far end — which silently hid rows dated past today
// rather than showing data that exists. Charts still end their AXIS at today,
// the same way the account balance chart does.
export const getInvestmentHistoriesByInvestment = async (
    investmentId: number,
    startDate: string,
    endDate?: string
): Promise<GetInvestmentHistoryResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            // The entry immediately before the range is always included as a
            // baseline, so a chart has something to draw from.
            const upperBound = endDate ? ' AND date(CreatedAt) <= date(?)' : '';
            const parameters = endDate
                ? [investmentId, startDate, endDate, investmentId, startDate]
                : [investmentId, startDate, investmentId, startDate];

            const investmentHistories: InvestmentHistory[] = await _db.getAllAsync(
                `SELECT *
                 FROM InvestmentHistories
                 WHERE InvestmentId = ?
                    AND (
                        (date(CreatedAt) >= date(?)${upperBound})
                        OR Id = (
                            SELECT Id
                            FROM InvestmentHistories
                            WHERE InvestmentId = ? AND date(CreatedAt) < date(?)
                            ORDER BY datetime(CreatedAt) DESC, Id DESC
                            LIMIT 1
                        )
                    )
                 ORDER BY CreatedAt, Id`,
                parameters
            )

            return {
                Status: "Success",
                Data: investmentHistories
            }
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Unable to load investment history.'),
                Data: []
            }
        }
    }else{
        return {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }
    }
}
