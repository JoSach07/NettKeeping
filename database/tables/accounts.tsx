import { DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult } from "../dbService";
import { describeError } from '@/utils/userFacingError';

export interface Account{
    Id: number;
    Name: string;
    Balance: number;
    OpeningBalance: number;
    OpeningBalanceDate: string;
    BalanceAnchorDate: string;
    CurrencyId: number;
    IsActive: boolean;
    CreatedAt: Date;
}

export interface GetAccountResult extends GetResult {
    Data: Account[]
}

export interface GetAccountTransactionCountResult extends GetResult {
    Count: number
}

export interface GetAccountNameConflictResult extends GetResult {
    ConflictingAccount: Account | null
}

export const getAccounts = async (): Promise<GetAccountResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const accounts: Account[] = await _db.getAllAsync('SELECT * FROM Accounts WHERE IsActive = 1 ORDER BY Name COLLATE NOCASE')
            const response: GetAccountResult = {
                Status: "Success",
                Data: accounts
            }

            return response;
        } catch (err){
            const response: GetAccountResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load accounts.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetAccountResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}

// Soft-deleted accounts are deliberately included here. Rows an existing
// transaction already references must resolve by Id even after removal, otherwise
// editing that transaction loses the account name AND its currency — and without a
// currency the amount cannot be parsed back into minor units, which made those
// transactions impossible to re-save. Pickers must keep using getAccounts so a
// removed account can never be newly selected.
export const getAllAccounts = async (): Promise<GetAccountResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const accounts: Account[] = await _db.getAllAsync('SELECT * FROM Accounts ORDER BY Name COLLATE NOCASE')
            const response: GetAccountResult = {
                Status: "Success",
                Data: accounts
            }

            return response;
        } catch (err){
            const response: GetAccountResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load accounts.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetAccountResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}

// Name matching is case-insensitive to match the NOCASE ordering used
// everywhere else, so "Savings" and "savings" count as the same account.
// Removed accounts are reported too rather than filtered out: the caller warns
// about those instead of blocking, since refusing a name held only by a deleted
// account would let removed rows squat names the user can no longer see.
export const getAccountNameConflict = async (
    name: string,
    excludeId?: number
): Promise<GetAccountNameConflictResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const conflictingAccount = await _db.getFirstAsync<Account>(
                `SELECT * FROM Accounts
                 WHERE Name = ? COLLATE NOCASE
                    AND Id != ?
                 ORDER BY IsActive DESC
                 LIMIT 1`,
                [name, excludeId ?? -1]
            );

            return {
                Status: "Success",
                ConflictingAccount: conflictingAccount ?? null
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to check for a duplicate account name.'),
                ConflictingAccount: null
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            ConflictingAccount: null
        }
    }
}

export const insertAccount = async (
    name: string,
    balance: number,
    currencyId: number
): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            // Safety net only. The form checks first so it can warn-and-confirm
            // on a name held by a removed account; this blocks the active case
            // unconditionally for any future caller that forgets to.
            const activeConflict = await _db.getFirstAsync<{ Id: number }>(
                'SELECT Id FROM Accounts WHERE Name = ? COLLATE NOCASE AND IsActive = 1 LIMIT 1',
                [name]
            );

            if (activeConflict) {
                return {
                    Status: "Error",
                    Message: `An account named "${name}" already exists.`,
                };
            }

            const result = await _db.runAsync(
                `INSERT INTO Accounts (
                    Name,
                    Balance,
                    OpeningBalance,
                    OpeningBalanceDate,
                    BalanceAnchorDate,
                    CurrencyId
                ) VALUES (?, ?, ?, date('now'), date('now'), ?)`,
                [name, balance, balance, currencyId]
            );

            return {
                Status: "Success",
                DataId: result.lastInsertRowId
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to save account.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}

export const updateAccount = async (
    id: number,
    name: string,
    balance: number,
    currencyId: number
): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const activeConflict = await _db.getFirstAsync<{ Id: number }>(
                'SELECT Id FROM Accounts WHERE Name = ? COLLATE NOCASE AND Id != ? AND IsActive = 1 LIMIT 1',
                [name, id]
            );

            if (activeConflict) {
                return {
                    Status: "Error",
                    Message: `An account named "${name}" already exists.`,
                };
            }

            const transactionCount = await _db.getFirstAsync<{ Count: number }>(
                'SELECT COUNT(*) AS Count FROM Transactions WHERE AccountId = ?',
                [id]
            );

            if ((transactionCount?.Count ?? 0) > 0) {
                // Balance and currency are locked once transactions exist: the
                // transaction history is denominated in the original currency.
                await _db.runAsync(
                    'UPDATE Accounts SET Name = ? WHERE Id = ?',
                    [name, id]
                );
            } else {
                await _db.runAsync(
                    `UPDATE Accounts
                     SET Name = ?,
                        Balance = ?,
                        OpeningBalance = ?,
                        OpeningBalanceDate = date('now'),
                        BalanceAnchorDate = date('now'),
                        CurrencyId = ?
                     WHERE Id = ?`,
                    [name, balance, balance, currencyId, id]
                );
            }

            return {
                Status: "Success",
                DataId: id
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to save account.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}

export const getAccountTransactionCount = async (id: number): Promise<GetAccountTransactionCountResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const result = await _db.getFirstAsync<{ Count: number }>(
                'SELECT COUNT(*) AS Count FROM Transactions WHERE AccountId = ?',
                [id]
            );

            return {
                Status: "Success",
                Count: result?.Count ?? 0
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to check account usage.'),
                Count: 0
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            Count: 0
        }
    }
}

export const deleteAccount = async (id: number): Promise<DeleteResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            await _db.runAsync('UPDATE Accounts SET IsActive = 0 WHERE Id = ?', [id]);

            return {
                Status: "Success",
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to remove account.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}
