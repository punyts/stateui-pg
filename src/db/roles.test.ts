import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../testing/testDatabase.js';
import type { TestDatabase } from '../testing/testDatabase.js';
import { STATEUI_PG_MIGRATIONS } from '../migrations.js';
import { grantAggregateRole, grantAppRole } from './migrate.js';

const WORKSPACE = 'a0000000-0000-4000-8000-000000000001';
let test: TestDatabase;

beforeAll(async () => {
    test = await createTestDatabase([STATEUI_PG_MIGRATIONS]);
    for (const role of ['punyts_server_test', 'punyts_aggregate_test']) await test.db.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
});

afterAll(async () => {
    for (const role of ['punyts_server_test', 'punyts_aggregate_test']) await test.db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${test.schema} FROM ${role}; REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${test.schema} FROM ${role}; REVOKE ALL ON SCHEMA ${test.schema} FROM ${role}`);
    await test.drop();
});

/** Runs one statement as a role, in the workspace; answers the error's message, or 'ok' */
const as = (role: string, sql: string): Promise<string> =>
    test.db
        .transaction(
            async (tx) => {
                await tx.query(`SET LOCAL ROLE ${role}`);
                await tx.query(sql);
                return 'ok';
            },
            { workspaceIds: [WORKSPACE] }
        )
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

const NODE = `INSERT INTO state_node (workspace_id, address, path, parent, position, kind, value, revision) VALUES ('${WORKSPACE}', '1/apps/x', 'form', '', 0, 'value', '1', 1)`;

describe('the roles of the servers and the aggregate', () => {
    it('should let a server with read-only state read the state tables and write none of them, and keep its other rights', async () => {
        // Arrange
        await grantAppRole(test.db, 'punyts_server_test', { readOnlyState: true });

        // Act
        const outcomes = [
            await as('punyts_server_test', 'SELECT * FROM state_node'),
            await as('punyts_server_test', NODE),
            await as('punyts_server_test', "UPDATE namespace_head SET revision = 2 WHERE address = '1/apps/x'"),
            await as('punyts_server_test', "DELETE FROM state_change WHERE address = '1/apps/x'"),
            await as('punyts_server_test', `INSERT INTO part (workspace_id, kind, id, name, revision, body, created_at, updated_at) VALUES ('${WORKSPACE}', 'apps', 'b0000000-0000-4000-8000-000000000001', 'a1', 1, '{}', now(), now())`)
        ];

        // Assert
        expect(outcomes.map((outcome) => (outcome === 'ok' ? 'ok' : /permission denied/.test(outcome) ? 'denied' : outcome))).toEqual(['ok', 'denied', 'denied', 'denied', 'ok']);
    });

    it('should let the aggregate write the state tables and queue embeddings, read the parts, and change nothing else', async () => {
        // Arrange
        await grantAggregateRole(test.db, 'punyts_aggregate_test');

        // Act
        const outcomes = [
            await as('punyts_aggregate_test', NODE.replace("'form'", "'route'")),
            await as('punyts_aggregate_test', "DELETE FROM state_node WHERE address = '1/apps/x'"),
            await as('punyts_aggregate_test', `INSERT INTO embedding_job (workspace_id, source_kind, source_id) VALUES ('${WORKSPACE}', 'persona-record', '1/apps/x/b/k')`),
            await as('punyts_aggregate_test', 'SELECT * FROM part'),
            await as('punyts_aggregate_test', `INSERT INTO part (workspace_id, kind, id, name, revision, body, created_at, updated_at) VALUES ('${WORKSPACE}', 'apps', 'b0000000-0000-4000-8000-000000000002', 'a2', 1, '{}', now(), now())`),
            await as('punyts_aggregate_test', 'DELETE FROM embedding')
        ];

        // Assert
        expect(outcomes.map((outcome) => (outcome === 'ok' ? 'ok' : /permission denied/.test(outcome) ? 'denied' : outcome))).toEqual(['ok', 'ok', 'ok', 'ok', 'denied', 'denied']);
    });
});
