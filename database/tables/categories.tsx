import { DbExecutor, DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult, runInTransaction } from "../dbService";
import { describeError } from '@/utils/userFacingError';

// Reserved categories seeded with fixed Ids in migrateToVersion1. They drive
// special transaction behavior (transfer pairs, investment entries) and must be
// identified by Id, never by name — names are user-visible and renameable.
export const TRANSFER_INTO_CATEGORY_ID = 1;
export const TRANSFER_FROM_CATEGORY_ID = 2;
export const INVESTMENT_LIQUIDATION_CATEGORY_ID = 3;
export const INVESTMENT_CATEGORY_ID = 4;

export const isTransferCategoryId = (categoryId: number): boolean => (
    categoryId === TRANSFER_INTO_CATEGORY_ID || categoryId === TRANSFER_FROM_CATEGORY_ID
);

export const isInvestmentCategoryId = (categoryId: number): boolean => (
    categoryId === INVESTMENT_CATEGORY_ID || categoryId === INVESTMENT_LIQUIDATION_CATEGORY_ID
);

export const isReservedCategoryId = (categoryId: number): boolean => (
    isTransferCategoryId(categoryId) || isInvestmentCategoryId(categoryId)
);

export interface Category{
    Id: number;
    Name: string;
    HexColor: string;
    TransactionTypeId: number;
    IsActive: boolean;
}

export interface GetCategoryResult extends GetResult {
    Data: Category[]
}

export interface GetCategoryNameConflictResult extends GetResult {
    ConflictingCategory: Category | null
}

// Mirrors getInvestmentCategoryNameConflict, with one difference: categories
// carry a TransactionTypeId, so uniqueness is scoped to it. The same word can be
// both an income and a spending category ("Loan" is the motivating case), and
// every picker in the app is already filtered to one transaction type, so a
// cross-type match is never ambiguous where the user chooses. Removed
// categories are reported rather than filtered out — the caller warns about
// those instead of blocking.
export const getCategoryNameConflict = async (
    name: string,
    transactionTypeId: number,
    excludeId?: number
): Promise<GetCategoryNameConflictResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const conflictingCategory = await _db.getFirstAsync<Category>(
                `SELECT * FROM Categories
                 WHERE Name = ? COLLATE NOCASE
                    AND TransactionTypeId = ?
                    AND Id != ?
                 ORDER BY IsActive DESC
                 LIMIT 1`,
                [name, transactionTypeId, excludeId ?? -1]
            );

            return {
                Status: "Success",
                ConflictingCategory: conflictingCategory ?? null
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to check for a duplicate category name.'),
                ConflictingCategory: null
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
            ConflictingCategory: null
        }
    }
}

// Safety net behind the screens' own checks: two active categories of the same
// transaction type must never share a name, whichever path the write came from.
const hasActiveNameConflict = async (
    db: DbExecutor,
    name: string,
    transactionTypeId: number,
    excludeId?: number
): Promise<boolean> => {
    const conflict = await db.getFirstAsync<{ Id: number }>(
        `SELECT Id FROM Categories
         WHERE Name = ? COLLATE NOCASE
            AND TransactionTypeId = ?
            AND IsActive = 1
            AND Id != ?
         LIMIT 1`,
        [name, transactionTypeId, excludeId ?? -1]
    );

    return Boolean(conflict);
}

export const getCategories = async (): Promise<GetCategoryResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const categories: Category[] = await _db.getAllAsync('SELECT * FROM Categories WHERE IsActive = 1 ORDER BY Name COLLATE NOCASE')
            const response: GetCategoryResult = {
                Status: "Success",
                Data: categories
            }

            return response;
        } catch (err){
            const response: GetCategoryResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load categories.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetCategoryResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}

export const insertCategory = async (name: string, HexColor: string, transactionTypeId: number): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            if (await hasActiveNameConflict(_db, name, transactionTypeId)) {
                return {
                    Status: "Error",
                    Message: `A category named "${name}" already exists.`,
                };
            }

            const result = await _db.runAsync(
                'INSERT INTO Categories (Name, HexColor, TransactionTypeId) VALUES (?, ?, ?)',
                [name, HexColor, transactionTypeId] // Parameters as an array
            );
            
            const response: InsertOrUpdateResult = {
                Status: "Success",
                DataId: result.lastInsertRowId
            };
            return response;
        } catch (err){
            const response: InsertOrUpdateResult = {
                Status: "Error",
                ...describeError(err, 'Failed to save category.'),
            };
            return response;
        }
    }else{
        const response: InsertOrUpdateResult = {
            Status: "Error",
            Message: 'Error opening database connection',
        }
        return response;
    }
}

export const updateCategory = async (
    id: number,
    name: string,
    hexColor: string,
    transactionTypeId: number
): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            if (await hasActiveNameConflict(_db, name, transactionTypeId, id)) {
                return {
                    Status: "Error",
                    Message: `A category named "${name}" already exists.`,
                };
            }

            await _db.runAsync(
                'UPDATE Categories SET Name = ?, HexColor = ?, TransactionTypeId = ? WHERE Id = ?',
                [name, hexColor, transactionTypeId, id]
            );

            return {
                Status: "Success",
                DataId: id
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to save category.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}

export const getCategoryUsageCount = async (id: number): Promise<{ Status: string; Message?: string; Detail?: string; Count: number }> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const result = await _db.getFirstAsync<{ Count: number }>(
                'SELECT COUNT(*) AS Count FROM Transactions WHERE CategoryId = ?',
                [id]
            );

            return {
                Status: "Success",
                Count: result?.Count ?? 0
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to check category usage.'),
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

export const deleteCategory = async (id: number, replacementId?: number | null): Promise<DeleteResult> => {
    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            if (replacementId) {
                await tx.runAsync(
                    'UPDATE Transactions SET CategoryId = ? WHERE CategoryId = ?',
                    [replacementId, id]
                );
            }

            await tx.runAsync('UPDATE Categories SET IsActive = 0 WHERE Id = ?', [id]);

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
            ...describeError(err, 'Failed to remove category.'),
        };
    }
}
