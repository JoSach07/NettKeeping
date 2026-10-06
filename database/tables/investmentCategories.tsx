import { DbExecutor, DeleteResult, getDBConnection, GetResult, InsertOrUpdateResult, runInTransaction } from "../dbService";
import { describeError } from '@/utils/userFacingError';

export interface InvestmentCategory{
    Id: number;
    Name: string;
    IsActive: boolean;
}

// Seeded by migration v1. Investments saved without a category land here, so
// the UI and the update/delete functions below refuse to rename or remove it.
export const GENERAL_INVESTMENT_CATEGORY_ID = 1;

export const isReservedInvestmentCategoryId = (categoryId: number): boolean => (
    categoryId === GENERAL_INVESTMENT_CATEGORY_ID
);

export interface GetInvestmentCategoryResult extends GetResult {
    Data: InvestmentCategory[]
}

export interface GetInvestmentCategoryNameConflictResult extends GetResult {
    ConflictingCategory: InvestmentCategory | null
}

// Mirrors getAccountNameConflict. Case-insensitive to match the NOCASE
// ordering used everywhere else, and removed categories are reported rather
// than filtered out: the caller warns about those instead of blocking, since
// refusing a name held only by a category the user can no longer see would
// look arbitrary.
export const getInvestmentCategoryNameConflict = async (
    name: string,
    excludeId?: number
): Promise<GetInvestmentCategoryNameConflictResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const conflictingCategory = await _db.getFirstAsync<InvestmentCategory>(
                `SELECT * FROM InvestmentCategories
                 WHERE Name = ? COLLATE NOCASE
                    AND Id != ?
                 ORDER BY IsActive DESC
                 LIMIT 1`,
                [name, excludeId ?? -1]
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

// Safety net behind the screens' own checks: an active category must never
// share a name with another active one, whichever path the write came from.
const hasActiveNameConflict = async (
    db: DbExecutor,
    name: string,
    excludeId?: number
): Promise<boolean> => {
    const conflict = await db.getFirstAsync<{ Id: number }>(
        `SELECT Id FROM InvestmentCategories
         WHERE Name = ? COLLATE NOCASE
            AND IsActive = 1
            AND Id != ?
         LIMIT 1`,
        [name, excludeId ?? -1]
    );

    return Boolean(conflict);
}

export const getInvestmentCategories = async (): Promise<GetInvestmentCategoryResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const investmentCategories: InvestmentCategory[] = await _db.getAllAsync('SELECT * FROM InvestmentCategories WHERE IsActive = 1 ORDER BY Name COLLATE NOCASE')
            const response: GetInvestmentCategoryResult = {
                Status: "Success",
                Data: investmentCategories
            }

            return response;
        } catch (err){
            const response: GetInvestmentCategoryResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load investment categories.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetInvestmentCategoryResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}

export const insertInvestmentCategory = async (name: string): Promise<InsertOrUpdateResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            if (await hasActiveNameConflict(_db, name)) {
                return {
                    Status: "Error",
                    Message: `An investment category named "${name}" already exists.`,
                };
            }

            const result = await _db.runAsync(
                'INSERT INTO InvestmentCategories (Name) VALUES (?)',
                [name]
            );

            return {
                Status: "Success",
                DataId: result.lastInsertRowId
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to save investment category.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}

export const updateInvestmentCategory = async (id: number, name: string): Promise<InsertOrUpdateResult> => {
    if (isReservedInvestmentCategoryId(id)) {
        return {
            Status: "Error",
            Message: 'This category cannot be renamed.',
        };
    }

    const _db = await getDBConnection();
    if(_db){
        try{
            if (await hasActiveNameConflict(_db, name, id)) {
                return {
                    Status: "Error",
                    Message: `An investment category named "${name}" already exists.`,
                };
            }

            await _db.runAsync(
                'UPDATE InvestmentCategories SET Name = ? WHERE Id = ?',
                [name, id]
            );

            return {
                Status: "Success",
                DataId: id
            };
        } catch (err){
            return {
                Status: "Error",
                ...describeError(err, 'Failed to save investment category.'),
            };
        }
    }else{
        return {
            Status: "Error",
            Message: 'Error opening database connection',
        }
    }
}

export const getInvestmentCategoryUsageCount = async (id: number): Promise<{ Status: string; Message?: string; Detail?: string; Count: number }> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const result = await _db.getFirstAsync<{ Count: number }>(
                'SELECT COUNT(*) AS Count FROM Investments WHERE InvestmentCategoryId = ?',
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

export const deleteInvestmentCategory = async (id: number, replacementId?: number | null): Promise<DeleteResult> => {
    if (isReservedInvestmentCategoryId(id)) {
        return {
            Status: "Error",
            Message: 'This category cannot be removed.',
        };
    }

    try {
        return await runInTransaction<DeleteResult>(async (tx) => {
            if (replacementId) {
                await tx.runAsync(
                    'UPDATE Investments SET InvestmentCategoryId = ? WHERE InvestmentCategoryId = ?',
                    [replacementId, id]
                );
            }

            await tx.runAsync('UPDATE InvestmentCategories SET IsActive = 0 WHERE Id = ?', [id]);

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
            ...describeError(err, 'Failed to remove investment category.'),
        };
    }
}
