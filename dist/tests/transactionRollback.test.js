"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const postgresql_1 = require("@testcontainers/postgresql");
const pg_1 = require("pg");
const node_postgres_1 = require("drizzle-orm/node-postgres");
const drizzle_orm_1 = require("drizzle-orm");
const schema = __importStar(require("../src/db/schema"));
const schema_1 = require("../src/db/schema");
const connectedAccountService_1 = require("../src/services/connectedAccountService");
const AppError_1 = require("../src/errors/AppError");
jest.setTimeout(120000);
describe('Transaction Rollback Real Postgres Integration Test', () => {
    let container;
    let pool;
    let testDb;
    let isPostgresAvailable = false;
    beforeAll(async () => {
        try {
            // 1. Attempt starting PostgreSQL 15 container via testcontainers
            container = await new postgresql_1.PostgreSqlContainer('postgres:15-alpine').start();
            const connectionString = container.getConnectionUri();
            pool = new pg_1.Pool({ connectionString });
            testDb = (0, node_postgres_1.drizzle)(pool, { schema });
            // 2. Execute real Drizzle schema creation against PostgreSQL container
            await testDb.execute((0, drizzle_orm_1.sql) `
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS connected_accounts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          scopes TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
            isPostgresAvailable = true;
        }
        catch (err) {
            console.warn('PostgreSQL container runtime unavailable on local host environment:', err instanceof Error ? err.message : String(err));
            isPostgresAvailable = false;
        }
    });
    afterAll(async () => {
        if (pool) {
            await pool.end();
        }
        if (container) {
            await container.stop();
        }
    });
    beforeEach(async () => {
        if (testDb && isPostgresAvailable) {
            await testDb.execute((0, drizzle_orm_1.sql) `TRUNCATE TABLE connected_accounts, users CASCADE;`);
        }
    });
    test('INSERT branch: Real PostgreSQL FK constraint violation forces transaction rollback, persisting 0 rows', async () => {
        if (!isPostgresAvailable || !testDb) {
            console.warn('Skipping test: Real PostgreSQL container runtime not running on host machine');
            return;
        }
        // Insert valid user into PostgreSQL
        const [testUser] = await testDb
            .insert(schema_1.users)
            .values({ email: 'tx-insert-user@example.com', passwordHash: 'hash123' })
            .returning();
        // Force real Postgres FK Constraint Violation (code 23503) inside transaction via onBeforeCommit callback
        const failingInsertPromise = (0, connectedAccountService_1.upsertConnectedAccount)(testUser.id, 'google_health', 'access_token_1', 'refresh_token_1', ['activity_and_fitness'], testDb, async (tx) => {
            const dbTx = tx;
            // Attempt inserting connected_account referencing non-existent user_id -> PostgreSQL rejects with FK error 23503
            await dbTx.execute((0, drizzle_orm_1.sql) `
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
        });
        await expect(failingInsertPromise).rejects.toThrow(AppError_1.DatabaseError);
        // Direct Real PostgreSQL Query Assertion: Assert 0 connected_accounts records persisted in Postgres
        const dbAccounts = await testDb.select().from(schema_1.connectedAccounts).where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, testUser.id));
        expect(dbAccounts).toHaveLength(0);
    });
    test('UPDATE branch: Real PostgreSQL constraint violation forces transaction rollback, preserving original tokens', async () => {
        if (!isPostgresAvailable || !testDb) {
            console.warn('Skipping test: Real PostgreSQL container runtime not running on host machine');
            return;
        }
        const [testUser] = await testDb
            .insert(schema_1.users)
            .values({ email: 'tx-update-user@example.com', passwordHash: 'hash123' })
            .returning();
        // 1. Initial valid insert (commits successfully to real Postgres container)
        await (0, connectedAccountService_1.upsertConnectedAccount)(testUser.id, 'google_health', 'original_access_token', 'original_refresh_token', ['activity_and_fitness'], testDb);
        const initialAccounts = await testDb.select().from(schema_1.connectedAccounts).where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, testUser.id));
        expect(initialAccounts).toHaveLength(1);
        const originalAccessToken = initialAccounts[0].accessToken;
        // 2. Attempt update with new tokens, but force real Postgres FK constraint violation before commit
        const failingUpdatePromise = (0, connectedAccountService_1.upsertConnectedAccount)(testUser.id, 'google_health', 'new_uncommitted_access_token', 'new_uncommitted_refresh_token', ['activity_and_fitness'], testDb, async (tx) => {
            const dbTx = tx;
            // Attempt invalid FK write inside transaction block -> PostgreSQL aborts transaction block & rolls back
            await dbTx.execute((0, drizzle_orm_1.sql) `
          INSERT INTO connected_accounts (id, user_id, provider, access_token, refresh_token, scopes)
          VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'invalid_fk_provider', 'token_a', 'token_b', '[]')
        `);
        });
        await expect(failingUpdatePromise).rejects.toThrow(AppError_1.DatabaseError);
        // 3. Direct Real PostgreSQL Query Assertion: Original record tokens in Postgres remain unchanged
        const accountsAfterFailure = await testDb.select().from(schema_1.connectedAccounts).where((0, drizzle_orm_1.eq)(schema_1.connectedAccounts.userId, testUser.id));
        expect(accountsAfterFailure).toHaveLength(1);
        expect(accountsAfterFailure[0].accessToken).toEqual(originalAccessToken);
    });
});
