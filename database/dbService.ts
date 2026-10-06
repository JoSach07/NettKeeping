import * as SQLite from 'expo-sqlite';

import { describeError, UserFacingError } from '@/utils/userFacingError';

let dbConnectionPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let dbMigrationPromise: Promise<void> | null = null;
let dbAsyncMethodsQueued = false;
let dbOperationQueue = Promise.resolve();
let rawDbMethods: DbExecutor | null = null;

// Message is a plain sentence for the user. Detail carries the raw error text
// for a Details toggle (see describeError in utils/userFacingError).
export interface GetResult{
    Status: string;
    Message?: string;
    Detail?: string;
}

export interface InsertOrUpdateResult{
    Status: string;
    Message?: string;
    // Raw technical text for a Details toggle, kept separate so Message stays
    // a plain sentence.
    Detail?: string;
    DataId?: number;
}

export interface DeleteResult{
    Status: string;
    Message?: string;
    Detail?: string;
}

export type DbExecutor = Pick<
    SQLite.SQLiteDatabase,
    'execAsync' | 'getAllAsync' | 'getFirstAsync' | 'runAsync'
>;

export interface TransactionOutcome<T> {
    commit: boolean;
    result: T;
}

const enqueueDbOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const queuedOperation = dbOperationQueue.then(operation, operation);

    dbOperationQueue = queuedOperation.then(
        () => undefined,
        () => undefined
    );

    return queuedOperation;
};

const queueDatabaseAsyncMethods = (db: SQLite.SQLiteDatabase): void => {
    if (dbAsyncMethodsQueued) {
        return;
    }

    const queuedDb = db as SQLite.SQLiteDatabase & {
        execAsync: SQLite.SQLiteDatabase['execAsync'];
        getAllAsync: SQLite.SQLiteDatabase['getAllAsync'];
        getFirstAsync: SQLite.SQLiteDatabase['getFirstAsync'];
        runAsync: SQLite.SQLiteDatabase['runAsync'];
    };
    const execAsync = queuedDb.execAsync.bind(db);
    const getAllAsync = queuedDb.getAllAsync.bind(db);
    const getFirstAsync = queuedDb.getFirstAsync.bind(db);
    const runAsync = queuedDb.runAsync.bind(db);

    rawDbMethods = { execAsync, getAllAsync, getFirstAsync, runAsync };

    queuedDb.execAsync = ((...args: Parameters<SQLite.SQLiteDatabase['execAsync']>) =>
        enqueueDbOperation(() => execAsync(...args))) as SQLite.SQLiteDatabase['execAsync'];
    queuedDb.getAllAsync = ((...args: Parameters<SQLite.SQLiteDatabase['getAllAsync']>) =>
        enqueueDbOperation(() => getAllAsync(...args))) as SQLite.SQLiteDatabase['getAllAsync'];
    queuedDb.getFirstAsync = ((...args: Parameters<SQLite.SQLiteDatabase['getFirstAsync']>) =>
        enqueueDbOperation(() => getFirstAsync(...args))) as SQLite.SQLiteDatabase['getFirstAsync'];
    queuedDb.runAsync = ((...args: Parameters<SQLite.SQLiteDatabase['runAsync']>) =>
        enqueueDbOperation(() => runAsync(...args))) as SQLite.SQLiteDatabase['runAsync'];

    dbAsyncMethodsQueued = true;
};

export const getDBConnection = async (): Promise<SQLite.SQLiteDatabase> => {
    // foreign_keys is a per-connection setting in SQLite (defaults to OFF), so
    // it must be enabled every time the database is opened, not in a migration.
    dbConnectionPromise ??= SQLite.openDatabaseAsync('nettkeeping.db').then(async (openedDb) => {
        await openedDb.execAsync('PRAGMA foreign_keys = ON;');
        return openedDb;
    });
    const db = await dbConnectionPromise;

    dbMigrationPromise ??= runMigrations(db).catch((error) => {
        dbMigrationPromise = null;
        throw error;
    });
    await dbMigrationPromise;
    queueDatabaseAsyncMethods(db);

    return db;
};

const resetDatabaseConnection = async (): Promise<void> => {
    const db = dbConnectionPromise ? await dbConnectionPromise : null;

    await dbOperationQueue;

    if (db) {
        await db.closeAsync();
    }

    dbConnectionPromise = null;
    dbMigrationPromise = null;
    dbAsyncMethodsQueued = false;
    dbOperationQueue = Promise.resolve();
    rawDbMethods = null;
};

// Runs the whole transaction as a single queued operation so statements from
// other callers can never interleave between BEGIN and COMMIT. The callback
// must do all database work through the provided executor; using the queued
// connection inside it would deadlock the operation queue.
// Return { commit: false, result } to roll back for business-rule failures.
export const runInTransaction = async <T>(
    operations: (tx: DbExecutor) => Promise<TransactionOutcome<T>>
): Promise<T> => {
    await getDBConnection();
    const tx = rawDbMethods;

    if (!tx) {
        throw new Error('Database connection is not ready for transactions.');
    }

    return enqueueDbOperation(async () => {
        await tx.execAsync('BEGIN IMMEDIATE TRANSACTION;');

        let outcome: TransactionOutcome<T>;
        try {
            outcome = await operations(tx);
        } catch (error) {
            try {
                await tx.execAsync('ROLLBACK;');
            } catch (rollbackError) {
                console.error('Failed to roll back transaction:', rollbackError);
            }
            throw error;
        }

        try {
            await tx.execAsync(outcome.commit ? 'COMMIT;' : 'ROLLBACK;');
        } catch (finishError) {
            if (outcome.commit) {
                try {
                    await tx.execAsync('ROLLBACK;');
                } catch (rollbackError) {
                    console.error('Failed to roll back transaction:', rollbackError);
                }
                throw finishError;
            }
            console.error('Failed to roll back transaction:', finishError);
        }

        return outcome.result;
    });
};

const validateImportedDatabase = async (db: SQLite.SQLiteDatabase): Promise<void> => {
    const integrity = await db.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    if (integrity?.integrity_check !== 'ok') {
        throw new Error('Imported database failed SQLite integrity check.');
    }

    const requiredTables = [
        'Accounts',
        'AppSettings',
        'Categories',
        'Currencies',
        'InvestmentCategories',
        'InvestmentHistories',
        'Investments',
        'TransactionTypes',
        'Transactions',
        'UserPinSettings',
    ];
    const tableRows = await db.getAllAsync<{ name: string }>(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
            AND name IN (${requiredTables.map(() => '?').join(', ')})`,
        requiredTables
    );
    const existingTables = new Set(tableRows.map((table) => table.name));
    const missingTables = requiredTables.filter((table) => !existingTables.has(table));

    if (missingTables.length > 0) {
        throw new Error(`Imported file is missing required NettKeeping tables: ${missingTables.join(', ')}.`);
    }
};

export const getSerializedDatabase = async (): Promise<Uint8Array> => {
    const db = await getDBConnection();
    return db.serializeAsync();
};

export const replaceDatabaseWithSerializedBytes = async (serializedData: Uint8Array): Promise<InsertOrUpdateResult> => {
    let importedDb: SQLite.SQLiteDatabase | null = null;
    let destinationDb: SQLite.SQLiteDatabase | null = null;
    let currentSerializedData: Uint8Array | null = null;

    try {
        importedDb = await SQLite.deserializeDatabaseAsync(serializedData);
        await validateImportedDatabase(importedDb);
        currentSerializedData = await getSerializedDatabase();

        await resetDatabaseConnection();
        await SQLite.deleteDatabaseAsync('nettkeeping.db').catch(() => undefined);

        destinationDb = await SQLite.openDatabaseAsync('nettkeeping.db');
        await SQLite.backupDatabaseAsync({
            sourceDatabase: importedDb,
            destDatabase: destinationDb,
        });
        await destinationDb.closeAsync();
        destinationDb = null;
        await importedDb.closeAsync();
        importedDb = null;

        await getDBConnection();

        return {
            Status: 'Success',
            DataId: 1,
        };
    } catch (error) {
        if (destinationDb) {
            await destinationDb.closeAsync().catch(() => undefined);
        }
        if (importedDb) {
            await importedDb.closeAsync().catch(() => undefined);
        }

        dbConnectionPromise = null;
        dbMigrationPromise = null;
        dbAsyncMethodsQueued = false;
        dbOperationQueue = Promise.resolve();
        rawDbMethods = null;

        if (currentSerializedData) {
            let restoreSourceDb: SQLite.SQLiteDatabase | null = null;
            let restoreDestinationDb: SQLite.SQLiteDatabase | null = null;

            try {
                await SQLite.deleteDatabaseAsync('nettkeeping.db').catch(() => undefined);
                restoreSourceDb = await SQLite.deserializeDatabaseAsync(currentSerializedData);
                restoreDestinationDb = await SQLite.openDatabaseAsync('nettkeeping.db');
                await SQLite.backupDatabaseAsync({
                    sourceDatabase: restoreSourceDb,
                    destDatabase: restoreDestinationDb,
                });
            } catch (restoreError) {
                console.error('Failed to restore previous database after import failure:', restoreError);
            } finally {
                if (restoreDestinationDb) {
                    await restoreDestinationDb.closeAsync().catch(() => undefined);
                }
                if (restoreSourceDb) {
                    await restoreSourceDb.closeAsync().catch(() => undefined);
                }
            }
        }

        return {
            Status: 'Error',
            ...describeError(error, 'Failed to import database backup.'),
        };
    }
};

const getCurrentDatabaseVersion = async (db: SQLite.SQLiteDatabase): Promise<number> => {
    const result = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    return result?.user_version ?? 0;
};

const setDatabaseVersion = async (db: SQLite.SQLiteDatabase, version: number): Promise<void> => {
    await db.execAsync(`PRAGMA user_version = ${version};`);
};

const runMigration = async (
    db: SQLite.SQLiteDatabase,
    version: number,
    migration: (db: SQLite.SQLiteDatabase) => Promise<void>
): Promise<void> => {
    await db.execAsync('BEGIN TRANSACTION;');

    try {
        await migration(db);
        await setDatabaseVersion(db, version);
        await db.execAsync('COMMIT;');
    } catch (error) {
        await db.execAsync('ROLLBACK;');
        throw error;
    }
};

const migrateToVersion1 = async (db: SQLite.SQLiteDatabase): Promise<void> => {
    // Create TransactionTypes table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS TransactionTypes (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                IsIncome BOOLEAN NOT NULL
            );`
    );

    // Seed data for TransactionTypes (use INSERT OR IGNORE to avoid duplicate inserts)
    await db.execAsync(
        `INSERT OR IGNORE INTO TransactionTypes (Id, Name, IsIncome) VALUES (1, 'Income', 1);`
    );
    await db.execAsync(
        `INSERT OR IGNORE INTO TransactionTypes (Id, Name, IsIncome) VALUES (2, 'Spending', 0);`
    );

    // Create Categories table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS Categories (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                HexColor TEXT NOT NULL,
                TransactionTypeId INTEGER NOT NULL,
                IsActive BOOLEAN NOT NULL DEFAULT 1,
                FOREIGN KEY (TransactionTypeId) REFERENCES TransactionTypes(Id)
            );`
    );

    // Seed data for Categories (use INSERT OR IGNORE to avoid duplicate inserts)
    await db.execAsync(
        `INSERT OR IGNORE INTO Categories (Id, Name, HexColor, TransactionTypeId, IsActive) VALUES (1, 'Transfer Into Account', '#B0BEC5', 1, 1);`
    );
    await db.execAsync(
        `INSERT OR IGNORE INTO Categories (Id, Name, HexColor, TransactionTypeId, IsActive) VALUES (2, 'Transfer From Account', '#B0BEC5', 2, 1);`
    );
    await db.execAsync(
        `INSERT OR IGNORE INTO Categories (Id, Name, HexColor, TransactionTypeId, IsActive) VALUES (3, 'Investment Liquidation', '#0288D1', 1, 1);`
    );
    await db.execAsync(
        `INSERT OR IGNORE INTO Categories (Id, Name, HexColor, TransactionTypeId, IsActive) VALUES (4, 'Investment', '#0288D1', 2, 1);`
    );

    // Starter categories. Version 1 only runs on a brand-new database, so this
    // never touches an existing install or an imported backup. They are
    // ordinary categories: editable, recolourable and deletable. Colours are
    // unique within each type, so the category breakdown can tell them apart.
    await db.execAsync(
        `INSERT INTO Categories (Name, HexColor, TransactionTypeId) VALUES
            ('Bonus', '#43A047', 1),
            ('Cashback', '#7986CB', 1),
            ('Dividend', '#00796B', 1),
            ('Gift', '#F06292', 1),
            ('Interest', '#26A69A', 1),
            ('Item Sale', '#9E9D24', 1),
            ('Loan', '#78909C', 1),
            ('Other', '#8FA98F', 1),
            ('Refund', '#5C6BC0', 1),
            ('Reimbursement', '#546E7A', 1),
            ('Salary', '#1B5E20', 1),
            ('Clothes', '#795548', 2),
            ('Dining', '#D84315', 2),
            ('Electronics', '#4E342E', 2),
            ('Fee', '#EF9A9A', 2),
            ('Gift', '#F06292', 2),
            ('Groceries', '#F4511E', 2),
            ('Health', '#D32F2F', 2),
            ('Hobby', '#880E4F', 2),
            ('Home', '#B3261E', 2),
            ('Lesson', '#F9A825', 2),
            ('Loan', '#546E7A', 2),
            ('Other', '#9E7A7A', 2),
            ('Personal Care', '#BCAAA4', 2),
            ('Software', '#7B3F61', 2),
            ('Tax', '#6A0F0F', 2),
            ('Transport', '#E53935', 2),
            ('Utilities', '#9B1B1B', 2);`
    );

    // Create Currencies table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS Currencies (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Code TEXT NOT NULL UNIQUE,
                Name TEXT NOT NULL,
                NumberToBasic INTEGER NOT NULL,
                IsActive BOOLEAN NOT NULL DEFAULT 1
            );`
    );

    // Seed commonly used currencies
    await db.execAsync(
        `INSERT OR IGNORE INTO Currencies (Id, Code, Name, NumberToBasic, IsActive) VALUES
                (1, 'USD', 'United States Dollar', 100, 1),
                (2, 'EUR', 'Euro', 100, 1),
                (3, 'JPY', 'Japanese Yen', 1, 1),
                (4, 'GBP', 'British Pound Sterling', 100, 1),
                (5, 'AUD', 'Australian Dollar', 100, 1),
                (6, 'CAD', 'Canadian Dollar', 100, 1),
                (7, 'CHF', 'Swiss Franc', 100, 1),
                (8, 'CNY', 'Chinese Yuan', 100, 1),
                (9, 'HKD', 'Hong Kong Dollar', 100, 1),
                (10, 'SGD', 'Singapore Dollar', 100, 1),
                (11, 'INR', 'Indian Rupee', 100, 1),
                (12, 'IDR', 'Indonesian Rupiah', 1, 1),
                (13, 'KRW', 'South Korean Won', 1, 1),
                (14, 'BRL', 'Brazilian Real', 100, 1),
                (15, 'MXN', 'Mexican Peso', 100, 1),
                (16, 'NZD', 'New Zealand Dollar', 100, 1),
                (17, 'SEK', 'Swedish Krona', 100, 1),
                (18, 'NOK', 'Norwegian Krone', 100, 1),
                (19, 'DKK', 'Danish Krone', 100, 1),
                (20, 'ZAR', 'South African Rand', 100, 1),
                (21, 'AED', 'United Arab Emirates Dirham', 100, 1),
                (22, 'SAR', 'Saudi Riyal', 100, 1),
                (23, 'THB', 'Thai Baht', 100, 1),
                (24, 'MYR', 'Malaysian Ringgit', 100, 1),
                (25, 'PHP', 'Philippine Peso', 100, 1),
                (26, 'VND', 'Vietnamese Dong', 1, 1);`
    );

    // Create Accounts table
    await db.execAsync(
            `CREATE TABLE IF NOT EXISTS Accounts (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                Balance INTEGER NOT NULL DEFAULT 0,
                OpeningBalance INTEGER NOT NULL DEFAULT 0,
                OpeningBalanceDate DATETIME NOT NULL DEFAULT CURRENT_DATE,
                BalanceAnchorDate DATETIME NOT NULL DEFAULT CURRENT_DATE,
                CurrencyId INTEGER NOT NULL,
                IsActive BOOLEAN NOT NULL DEFAULT 1,
                CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (CurrencyId) REFERENCES Currencies(Id)
            );`
    );

    // Create InvestmentCategories table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS InvestmentCategories (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                IsActive BOOLEAN NOT NULL DEFAULT 1
            );`
    );

    // "General" is reserved at Id 1 (GENERAL_INVESTMENT_CATEGORY_ID): an
    // investment saved without a category goes here, so it can be neither
    // renamed nor removed, like transaction categories 1-4.
    await db.execAsync(
        `INSERT OR IGNORE INTO InvestmentCategories (Id, Name, IsActive) VALUES (1, 'General', 1);`
    );

    // Starter investment categories, same rules as the starter transaction
    // categories above: version 1 only runs on a brand-new database, and they
    // are ordinary rows (editable, deletable).
    await db.execAsync(
        `INSERT INTO InvestmentCategories (Name) VALUES
            ('Bonds'),
            ('Crypto'),
            ('Mutual Funds'),
            ('Precious Metals'),
            ('Stocks'),
            ('Time Deposits');`
    );

    // Create Investments table
    // - Quantity is an INTEGER scaled by 10^QuantityDecimals (0-8), the same
    //   fixed-point idea as money in minor units, so replays sum integers.
    //   See utils/investmentNumbers.ts.
    // - UnitValue is currency minor units x 10^4 (fixed scale for every
    //   investment).
    // - IsActive is a soft delete, mirroring Accounts.
    // - Unit is a free-text label for one unit (gram, lot, share). NULL, never
    //   '', when not set: callers treat NULL as "unit(s)", and an empty string
    //   would make every "is it set" check need two conditions.
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS Investments (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                InvestmentCategoryId INTEGER NOT NULL,
                CurrencyId INTEGER NOT NULL,
                Quantity INTEGER NOT NULL DEFAULT 0,
                UnitValue INTEGER NOT NULL DEFAULT 0,
                CreatedAt DATETIME NOT NULL,
                IsActive BOOLEAN NOT NULL DEFAULT 1,
                Unit TEXT,
                QuantityDecimals INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (InvestmentCategoryId) REFERENCES InvestmentCategories(Id),
                FOREIGN KEY (CurrencyId) REFERENCES Currencies(Id)
            );`
    );

    // Create InvestmentHistories table
    // - QuantityDelta is the per-entry quantity change, so state can be rebuilt
    //   by replay (database/investmentReplay.ts).
    // - TransactionId links an entry to the transaction that produced it; NULL
    //   for the opening entry and adjustments. No cascade on purpose: if a
    //   transaction is ever hard-deleted outside the investment logic, failing
    //   loudly beats silently corrupting snapshots.
    // - IsOpening marks the creation entry, meaning "held this many AS OF the
    //   creation day": entries dated before it are absorbed into the opening
    //   position instead of adding to it.
    // - Note is an optional label for an adjustment ("bonus shares", "split
    //   1:5"). Adjustments are rows with no transaction that are not the
    //   opening entry.
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS InvestmentHistories (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                InvestmentId INTEGER NOT NULL,
                Quantity INTEGER NOT NULL DEFAULT 0,
                UnitValue INTEGER NOT NULL DEFAULT 0,
                CreatedAt DATETIME NOT NULL,
                QuantityDelta INTEGER NOT NULL DEFAULT 0,
                TransactionId INTEGER REFERENCES Transactions(Id),
                IsOpening INTEGER NOT NULL DEFAULT 0,
                Note TEXT,
                FOREIGN KEY (InvestmentId) REFERENCES Investments(Id) ON DELETE CASCADE
            );`
    );

    // Create Transactions table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS Transactions (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                Description VARCHAR(255),
                CategoryId INTEGER NOT NULL,
                Amount INTEGER NOT NULL,
                AccountId INTEGER NOT NULL,
                TransactionDate DATETIME NOT NULL,
                FOREIGN KEY (CategoryId) REFERENCES Categories(Id),
                FOREIGN KEY (AccountId) REFERENCES Accounts(Id)
            );`
    );

    // Create AppSettings table
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS AppSettings (
                Id INTEGER PRIMARY KEY CHECK (Id = 1),
                Theme TEXT NOT NULL DEFAULT 'device' CHECK (Theme IN ('device', 'light', 'dark')),
                LeftHandedMode BOOLEAN NOT NULL DEFAULT 0,
                CreateTransactionAsStartupScreen BOOLEAN NOT NULL DEFAULT 0,
                ExportDirectoryUri TEXT,
                ExportDirectoryName TEXT
            );`
    );

    await db.execAsync(
        `INSERT OR IGNORE INTO AppSettings (Id, Theme, LeftHandedMode, CreateTransactionAsStartupScreen) VALUES (1, 'device', 0, 0);`
    );

    // Create UserPinSettings table
    // The PIN hash and salt are not stored here: they live in the device
    // secure store (utils/secureCredentials). HashIterations is the count the
    // stored hash was made with, chosen per build by createPinHash
    // (utils/pinCrypto.ts); NULL while no PIN is set.
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS UserPinSettings (
                Id INTEGER PRIMARY KEY CHECK (Id = 1),
                IsPinEnabled BOOLEAN NOT NULL DEFAULT 0,
                HashAlgorithm TEXT NOT NULL DEFAULT 'PBKDF2-SHA256',
                HashIterations INTEGER,
                FailedAttemptCount INTEGER NOT NULL DEFAULT 0,
                LockedUntil DATETIME,
                IsBiometricsEnabled BOOLEAN NOT NULL DEFAULT 0,
                CHECK (IsPinEnabled = 0 OR HashIterations IS NOT NULL)
            );`
    );

    await db.execAsync(
        `INSERT OR IGNORE INTO UserPinSettings (
                Id,
                IsPinEnabled,
                HashAlgorithm,
                FailedAttemptCount,
                IsBiometricsEnabled
            ) VALUES (1, 0, 'PBKDF2-SHA256', 0, 0);`
    );

    await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON Transactions(CategoryId);`
    );
    await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_categories_transaction_type_id ON Categories(TransactionTypeId);`
    );
    await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_accounts_currency_id ON Accounts(CurrencyId);`
    );
    await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_investment_histories_investment_id_created_at
         ON InvestmentHistories(InvestmentId, CreatedAt);`
    );

    // TransferTransactionGroups links the two legs of a transfer.
    await db.execAsync(
        `CREATE TABLE IF NOT EXISTS TransferTransactionGroups (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                TransactionIdFrom INTEGER NOT NULL UNIQUE,
                TransactionIdTo INTEGER NOT NULL UNIQUE,
                FOREIGN KEY (TransactionIdFrom) REFERENCES Transactions(Id),
                FOREIGN KEY (TransactionIdTo) REFERENCES Transactions(Id)
            );`
    );

    await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_investment_histories_transaction_id
         ON InvestmentHistories(TransactionId);`
    );
};

// The schema was squashed into a single version 1 before the first public
// release. Never squash again from here: add a new migrateToVersionN for every
// schema change and bump latestDatabaseVersion.
const latestDatabaseVersion = 1;

export const runMigrations = async (db: SQLite.SQLiteDatabase): Promise<void> => {
    try {
        const currentVersion = await getCurrentDatabaseVersion(db);

        // A database from a newer build (or from before the squash) would
        // otherwise skip every migration and fail later on its first query.
        if (currentVersion > latestDatabaseVersion) {
            throw new UserFacingError(
                'This database was created by a newer version of NettKeeping. Update NettKeeping to open it.'
            );
        }

        if (currentVersion < 1) {
            await runMigration(db, 1, migrateToVersion1);
        }
    } catch (error) {
        console.error('Error running database migrations:', error);
        throw error;
    }
};

